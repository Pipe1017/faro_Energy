import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ocpp.routing import on
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call_result, call
from ocpp.v16.enums import Action, RegistrationStatus, ChargePointStatus
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="CPO Colombia")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

connected_chargers: Dict[str, "ChargePoint"] = {}
charger_status: Dict[str, dict] = {}

CHARGER_METADATA = {
    "CP-MED-001": {"owner": "dueño_1", "location": "Universidad de Antioquia", "lat": 6.2672, "lng": -75.5647},
    "CP-MED-002": {"owner": "dueño_1", "location": "CC El Tesoro",             "lat": 6.2100, "lng": -75.5680},
    "CP-MED-003": {"owner": "dueño_1", "location": "CC Santafé",               "lat": 6.2044, "lng": -75.5752},
    "CP-MED-004": {"owner": "dueño_2", "location": "Universidad EAFIT",        "lat": 6.2006, "lng": -75.5781},
    "CP-MED-005": {"owner": "dueño_2", "location": "CC Oviedo",                "lat": 6.2157, "lng": -75.5696},
}


class WebSocketAdapter:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket

    async def send(self, message: str):
        await self.websocket.send_text(message)

    async def recv(self) -> str:
        return await self.websocket.receive_text()


class ChargePoint(cp):

    @on(Action.BootNotification)
    async def on_boot_notification(self, charge_point_model, charge_point_vendor, **kwargs):
        logger.info(f"[{self.id}] BootNotification — {charge_point_vendor} / {charge_point_model}")
        meta = CHARGER_METADATA.get(self.id, {})
        charger_status[self.id] = {
            **meta,
            "status": "Available",
            "model": charge_point_model,
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }
        return call_result.BootNotificationPayload(
            current_time=datetime.now(timezone.utc).isoformat(),
            interval=30,
            status=RegistrationStatus.accepted,
        )

    @on(Action.Heartbeat)
    async def on_heartbeat(self):
        if self.id in charger_status:
            charger_status[self.id]["last_seen"] = datetime.now(timezone.utc).isoformat()
        return call_result.HeartbeatPayload(current_time=datetime.now(timezone.utc).isoformat())

    @on(Action.StatusNotification)
    async def on_status_notification(self, connector_id, error_code, status, **kwargs):
        logger.info(f"[{self.id}] Estado → {status}")
        if self.id in charger_status:
            charger_status[self.id]["status"] = status
        return call_result.StatusNotificationPayload()

    @on(Action.Authorize)
    async def on_authorize(self, id_tag, **kwargs):
        logger.info(f"[{self.id}] Authorize → {id_tag}")
        return call_result.AuthorizePayload(id_tag_info={"status": "Accepted"})

    @on(Action.StartTransaction)
    async def on_start_transaction(self, connector_id, id_tag, meter_start, timestamp, **kwargs):
        tx_id = int(datetime.now().timestamp())
        logger.info(f"[{self.id}] ✅ Sesión iniciada — tx#{tx_id} usuario:{id_tag}")
        if self.id in charger_status:
            charger_status[self.id]["status"] = "Charging"
            charger_status[self.id]["active_transaction"] = tx_id
            charger_status[self.id]["session_user"] = id_tag
            charger_status[self.id]["meter_start"] = meter_start
        return call_result.StartTransactionPayload(
            transaction_id=tx_id,
            id_tag_info={"status": "Accepted"},
        )

    @on(Action.MeterValues)
    async def on_meter_values(self, connector_id, meter_value, **kwargs):
        try:
            wh = meter_value[0]["sampledValue"][0]["value"]
            if self.id in charger_status:
                charger_status[self.id]["current_wh"] = float(wh)
                charger_status[self.id]["current_kwh"] = round(float(wh) / 1000, 2)
        except Exception:
            pass
        return call_result.MeterValuesPayload()

    @on(Action.StopTransaction)
    async def on_stop_transaction(self, meter_stop, timestamp, transaction_id, **kwargs):
        logger.info(f"[{self.id}] 🔴 Sesión terminada — tx#{transaction_id}")
        if self.id in charger_status:
            meter_start = charger_status[self.id].get("meter_start", 0)
            kwh = round((meter_stop - meter_start) / 1000, 2)
            charger_status[self.id]["status"] = "Available"
            charger_status[self.id]["last_kwh"] = kwh
            charger_status[self.id].pop("active_transaction", None)
            charger_status[self.id].pop("session_user", None)
            charger_status[self.id].pop("current_wh", None)
        return call_result.StopTransactionPayload(id_tag_info={"status": "Accepted"})


@app.websocket("/ocpp/{charge_point_id}")
async def ocpp_endpoint(websocket: WebSocket, charge_point_id: str):
    await websocket.accept(subprotocol="ocpp1.6")
    logger.info(f"[{charge_point_id}] Conectado")
    adapter = WebSocketAdapter(websocket)
    cp_instance = ChargePoint(charge_point_id, adapter)
    connected_chargers[charge_point_id] = cp_instance
    try:
        await cp_instance.start()
    except WebSocketDisconnect:
        logger.warning(f"[{charge_point_id}] Desconectado")
    finally:
        connected_chargers.pop(charge_point_id, None)
        if charge_point_id in charger_status:
            charger_status[charge_point_id]["status"] = "Offline"


@app.get("/status")
async def get_status():
    return {
        "connected": list(connected_chargers.keys()),
        "total": len(connected_chargers),
        "chargers": charger_status,
    }


@app.get("/status/{charge_point_id}")
async def get_charger(charge_point_id: str):
    return charger_status.get(charge_point_id, {"error": "No encontrado"})


@app.post("/remote-start/{charge_point_id}")
async def remote_start(charge_point_id: str, id_tag: str = "USER-APP-001"):
    charger = connected_chargers.get(charge_point_id)
    if not charger:
        return {"error": "Cargador no conectado"}
    request = call.RemoteStartTransactionPayload(connector_id=1, id_tag=id_tag)
    response = await charger.call(request)
    return {"status": response.status}


@app.post("/remote-stop/{charge_point_id}")
async def remote_stop(charge_point_id: str):
    charger = connected_chargers.get(charge_point_id)
    if not charger:
        return {"error": "Cargador no conectado"}
    tx_id = charger_status.get(charge_point_id, {}).get("active_transaction")
    if not tx_id:
        return {"error": "Sin sesión activa"}
    request = call.RemoteStopTransactionPayload(transaction_id=tx_id)
    response = await charger.call(request)
    return {"status": response.status}
