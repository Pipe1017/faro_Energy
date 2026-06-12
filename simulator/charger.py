#!/usr/bin/env python3
"""
Simulador de un cargador OCPP 1.6 individual.
Uso: python charger.py <CHARGER_ID>

Cada cargador corre como proceso independiente — igual que hardware real.
"""
import sys
import asyncio
import logging
import random
from datetime import datetime, timezone

import websockets
from ocpp.routing import on
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call, call_result
from ocpp.v16.enums import Action, ChargePointStatus, RegistrationStatus, RemoteStartStopStatus, ReservationStatus

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)-12s] %(message)s",
)

CHARGERS = {
    "CP-MED-001": {"power_kw": 22},
    "CP-MED-002": {"power_kw": 50},
    "CP-MED-003": {"power_kw": 7.4},
    "CP-MED-004": {"power_kw": 22},
    "CP-MED-005": {"power_kw": 150},
}

BACKEND_URL = "ws://localhost:8000/ocpp"

def get_config(charger_id: str, power_kw: float = None) -> dict:
    """Retorna la config del cargador. Acepta cualquier ID, no solo los 5 predefinidos."""
    if charger_id in CHARGERS:
        cfg = CHARGERS[charger_id].copy()
    else:
        cfg = {"power_kw": power_kw or 22.0}
        print(f"[{charger_id}] Cargador nuevo — usando {cfg['power_kw']} kW por defecto")
    if power_kw:
        cfg["power_kw"] = power_kw
    return cfg


class ChargerSimulator(cp):

    def __init__(self, charger_id: str, connection, config: dict):
        super().__init__(charger_id, connection)
        self.config = config
        self.log = logging.getLogger(charger_id)
        self._in_session = False
        self._remote_start = asyncio.Event()
        self._remote_stop  = asyncio.Event()
        self._remote_tag   = None

    # ── Boot ─────────────────────────────────────────────────────────────────

    async def boot(self) -> bool:
        resp = await self.call(call.BootNotificationPayload(
            charge_point_model="CPO-Sim-v1",
            charge_point_vendor="CPO-Colombia",
        ))
        ok = resp.status == RegistrationStatus.accepted
        if ok:
            self.log.info(f"Registrado — {self.config['power_kw']}kW")
        return ok

    async def set_status(self, status: ChargePointStatus):
        await self.call(call.StatusNotificationPayload(
            connector_id=1, error_code="NoError", status=status,
        ))

    # ── Handlers OCPP entrantes ───────────────────────────────────────────────

    @on(Action.RemoteStartTransaction)
    async def on_remote_start(self, id_tag, connector_id=1, **kwargs):
        if self._in_session:
            self.log.warning("RemoteStart rechazado — sesión activa")
            return call_result.RemoteStartTransactionPayload(status=RemoteStartStopStatus.rejected)
        self.log.info(f"RemoteStart ← {id_tag}")
        self._remote_tag = id_tag
        self._remote_start.set()
        return call_result.RemoteStartTransactionPayload(status=RemoteStartStopStatus.accepted)

    @on(Action.ReserveNow)
    async def on_reserve_now(self, reservation_id, expiry_date, id_tag, connector_id=1, **kwargs):
        if self._in_session:
            return call_result.ReserveNowPayload(status=ReservationStatus.occupied)
        self.log.info(f"Reserva #{reservation_id} para {id_tag}")
        await self.set_status(ChargePointStatus.reserved)
        return call_result.ReserveNowPayload(status=ReservationStatus.accepted)

    @on(Action.CancelReservation)
    async def on_cancel_reservation(self, reservation_id, **kwargs):
        self.log.info(f"Reserva #{reservation_id} cancelada")
        await self.set_status(ChargePointStatus.available)
        return call_result.CancelReservationPayload(status="Accepted")

    @on(Action.RemoteStopTransaction)
    async def on_remote_stop(self, transaction_id, **kwargs):
        if not self._in_session:
            return call_result.RemoteStopTransactionPayload(status=RemoteStartStopStatus.rejected)
        self.log.info(f"RemoteStop ← tx#{transaction_id}")
        self._remote_stop.set()
        return call_result.RemoteStopTransactionPayload(status=RemoteStartStopStatus.accepted)

    # ── Sesión de carga ───────────────────────────────────────────────────────

    async def run_session(self, id_tag: str | None = None):
        self._in_session = True
        self._remote_stop.clear()

        user  = id_tag or f"SIM-{random.randint(100, 999)}"
        power = self.config["power_kw"] * 1000  # W
        meter = random.randint(10000, 80000)     # Wh iniciales del contador

        self.log.info(f"Sesión iniciada — usuario: {user}")
        await self.set_status(ChargePointStatus.preparing)
        await asyncio.sleep(1)

        start = await self.call(call.StartTransactionPayload(
            connector_id=1,
            id_tag=user,
            meter_start=meter,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        tx_id = start.transaction_id
        await self.set_status(ChargePointStatus.charging)
        self.log.info(f"Cargando — tx#{tx_id}")

        energy = meter
        max_ticks = 120  # máximo 10 min de sesión simulada (5s × 120)

        for _ in range(max_ticks):
            try:
                await asyncio.wait_for(self._remote_stop.wait(), timeout=3.0)
                self.log.info("Detenido remotamente")
                break
            except asyncio.TimeoutError:
                pass

            # Energía realista basada en potencia del cargador (intervalo 3s)
            delta = int(power * 3 / 3600 * random.uniform(0.85, 1.0))
            energy += delta

            await self.call(call.MeterValuesPayload(
                connector_id=1,
                transaction_id=tx_id,
                meter_value=[{
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "sampledValue": [
                        {"value": str(energy),           "unit": "Wh",   "measurand": "Energy.Active.Import.Register"},
                        {"value": str(self.config["power_kw"]), "unit": "kW",   "measurand": "Power.Active.Import"},
                        {"value": str(random.randint(220, 240)),   "unit": "V",    "measurand": "Voltage"},
                    ],
                }],
            ))
            kwh = (energy - meter) / 1000
            self.log.info(f"  {kwh:.3f} kWh  |  {self.config['power_kw']} kW")

        await self.call(call.StopTransactionPayload(
            meter_stop=energy,
            timestamp=datetime.now(timezone.utc).isoformat(),
            transaction_id=tx_id,
            reason="Remote" if self._remote_stop.is_set() else "Local",
        ))
        total_kwh = (energy - meter) / 1000
        self.log.info(f"Sesión terminada — {total_kwh:.3f} kWh")
        await self.set_status(ChargePointStatus.available)
        self._in_session = False

    # ── Loop principal ────────────────────────────────────────────────────────

    async def run(self):
        if not await self.boot():
            raise RuntimeError("Boot fallido")
        await self.set_status(ChargePointStatus.available)

        while True:
            self._remote_start.clear()
            self._remote_tag = None
            self.log.info("Disponible — esperando solicitud de carga")

            # Solo inicia cuando el servidor envía RemoteStart (QR scan del conductor)
            await self._remote_start.wait()
            id_tag = self._remote_tag

            try:
                await self.run_session(id_tag)
            except Exception as e:
                self.log.error(f"Error en sesión: {e}")
                self._in_session = False
                await self.set_status(ChargePointStatus.available)


# ── Punto de entrada ──────────────────────────────────────────────────────────

async def main(charger_id: str, power_kw: float = None):
    config = get_config(charger_id, power_kw)
    url = f"{BACKEND_URL}/{charger_id}"
    log = logging.getLogger(charger_id)

    print(f"\n{'='*50}")
    print(f"  {charger_id}")
    print(f"  {config['power_kw']} kW")
    print(f"  Conectando a {url}")
    print(f"{'='*50}\n")

    while True:
        try:
            async with websockets.connect(url, subprotocols=["ocpp1.6"]) as ws:
                charger = ChargerSimulator(charger_id, ws, config)
                # start() maneja mensajes ENTRANTES del servidor (RemoteStart/Stop)
                # run()   maneja la lógica de carga saliente
                # Deben correr concurrentemente
                start_task = asyncio.create_task(charger.start())
                try:
                    await charger.run()
                except Exception as e:
                    log.error(f"Error: {e}")
                    await asyncio.sleep(2)
                finally:
                    start_task.cancel()
                    try:
                        await start_task
                    except (asyncio.CancelledError, Exception):
                        pass
        except Exception as e:
            delay = 3 + random.uniform(0, 5)
            log.warning(f"Desconectado ({e}) — reconectando en {delay:.1f}s")
            await asyncio.sleep(delay)


if __name__ == "__main__":
    # Uso: python charger.py <ID> [potencia_kw]
    # Ejemplos:
    #   python charger.py CP-MED-001
    #   python charger.py CP-MED-006          ← nuevo cargador registrado en la app
    #   python charger.py MI-CHARGER-01 50    ← nuevo cargador con 50 kW
    if len(sys.argv) < 2:
        print("Uso: python charger.py <CHARGER_ID> [potencia_kw]")
        print(f"Cargadores predefinidos: {', '.join(CHARGERS.keys())}")
        print("También puedes usar cualquier ID registrado en la app.")
        sys.exit(1)

    power = float(sys.argv[2]) if len(sys.argv) >= 3 else None
    asyncio.run(main(sys.argv[1], power))
