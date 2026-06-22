"""
Simulador interno de cargadores OCPP.
Cada cargador simulado corre como tarea asyncio dentro del backend.
Sin terminales separadas — se controla desde la app.
"""
import asyncio
import logging
import random
from datetime import datetime, timezone

import websockets
from ocpp.routing import on
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call, call_result
from ocpp.v16.enums import (
    Action, ChargePointStatus, RegistrationStatus,
    RemoteStartStopStatus, AvailabilityType, ReservationStatus,
)

logger = logging.getLogger("sim")

BACKEND_WS = "ws://localhost:8000/ocpp"


class SimCharger(cp):
    """Cargador simulado — misma lógica que charger.py pero en proceso."""

    def __init__(self, charger_id: str, connection, power_kw: float = 22.0):
        super().__init__(charger_id, connection)
        self.power_kw    = power_kw
        self.log         = logging.getLogger(f"sim.{charger_id}")
        self._in_session = False
        self._remote_start = asyncio.Event()
        self._remote_stop  = asyncio.Event()
        self._remote_tag   = None

    async def _status(self, status: ChargePointStatus):
        await self.call(call.StatusNotificationPayload(
            connector_id=1, error_code="NoError", status=status,
        ))

    @on(Action.RemoteStartTransaction)
    async def on_remote_start(self, id_tag, connector_id=1, **kwargs):
        if self._in_session:
            return call_result.RemoteStartTransactionPayload(status=RemoteStartStopStatus.rejected)
        self._remote_tag = id_tag
        self._remote_start.set()
        return call_result.RemoteStartTransactionPayload(status=RemoteStartStopStatus.accepted)

    @on(Action.RemoteStopTransaction)
    async def on_remote_stop(self, transaction_id, **kwargs):
        if not self._in_session:
            return call_result.RemoteStopTransactionPayload(status=RemoteStartStopStatus.rejected)
        self._remote_stop.set()
        return call_result.RemoteStopTransactionPayload(status=RemoteStartStopStatus.accepted)

    @on(Action.ChangeAvailability)
    async def on_change_availability(self, connector_id, type, **kwargs):
        return call_result.ChangeAvailabilityPayload(status="Accepted")

    @on(Action.ReserveNow)
    async def on_reserve_now(self, **kwargs):
        return call_result.ReserveNowPayload(status=ReservationStatus.accepted)

    @on(Action.CancelReservation)
    async def on_cancel_reservation(self, **kwargs):
        return call_result.CancelReservationPayload(status="Accepted")

    async def boot(self) -> bool:
        try:
            resp = await self.call(call.BootNotificationPayload(
                charge_point_model="CPO-Sim-v1",
                charge_point_vendor="CPO-Colombia",
            ))
            return resp.status == RegistrationStatus.accepted
        except Exception:
            return False

    async def run_session(self, id_tag: str):
        self._in_session = True
        self._remote_stop.clear()
        meter  = random.randint(10_000, 80_000)
        energy = meter

        await self._status(ChargePointStatus.preparing)
        await asyncio.sleep(1)

        start = await self.call(call.StartTransactionPayload(
            connector_id=1, id_tag=id_tag, meter_start=meter,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        tx_id = start.transaction_id
        await self._status(ChargePointStatus.charging)
        self.log.info(f"Sesión iniciada — tx#{tx_id} usuario:{id_tag}")

        # Como un cargador real: carga hasta que llegue RemoteStop.
        # Tope de seguridad de 8 horas por si una sesión queda olvidada.
        for _ in range(8 * 3600 // 3):
            try:
                await asyncio.wait_for(self._remote_stop.wait(), timeout=3.0)
                break
            except asyncio.TimeoutError:
                pass
            delta  = int(self.power_kw * 1000 * 3 / 3600 * random.uniform(0.85, 1.0))
            energy += delta
            await self.call(call.MeterValuesPayload(
                connector_id=1, transaction_id=tx_id,
                meter_value=[{
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "sampledValue": [
                        {"value": str(energy), "unit": "Wh",
                         "measurand": "Energy.Active.Import.Register"},
                        {"value": str(self.power_kw), "unit": "kW",
                         "measurand": "Power.Active.Import"},
                    ],
                }],
            ))

        await self.call(call.StopTransactionPayload(
            meter_stop=energy,
            timestamp=datetime.now(timezone.utc).isoformat(),
            transaction_id=tx_id,
            reason="Remote" if self._remote_stop.is_set() else "Local",
        ))
        self.log.info(f"Sesión terminada — {(energy - meter) / 1000:.3f} kWh")
        await self._status(ChargePointStatus.available)
        self._in_session = False

    async def run_loop(self):
        if not await self.boot():
            return
        await self._status(ChargePointStatus.available)
        while True:
            self._remote_start.clear()
            self._remote_tag = None
            await self._remote_start.wait()
            try:
                await self.run_session(self._remote_tag)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log.error(f"Error en sesión: {e}")
                self._in_session = False
                try:
                    await self._status(ChargePointStatus.available)
                except Exception:
                    pass


# ── Gestión de tareas ──────────────────────────────────────────────────────────

_tasks: dict[str, asyncio.Task] = {}


def is_running(charger_id: str) -> bool:
    t = _tasks.get(charger_id)
    return t is not None and not t.done()


def list_running() -> list[str]:
    return [cid for cid, t in _tasks.items() if not t.done()]


async def _loop(charger_id: str, power_kw: float):
    url = f"{BACKEND_WS}/{charger_id}"
    logger.info(f"[{charger_id}] Simulador iniciado ({power_kw} kW)")
    while True:
        try:
            async with websockets.connect(url, subprotocols=["ocpp1.6"]) as ws:
                sim = SimCharger(charger_id, ws, power_kw)
                start_task = asyncio.create_task(sim.start())
                try:
                    await sim.run_loop()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"[{charger_id}] run_loop error: {e}")
                finally:
                    start_task.cancel()
                    try:
                        await start_task
                    except Exception:
                        pass
        except asyncio.CancelledError:
            logger.info(f"[{charger_id}] Simulador detenido")
            break
        except Exception as e:
            delay = 3 + random.uniform(0, 2)
            logger.warning(f"[{charger_id}] desconectado ({e}) — reintentando en {delay:.1f}s")
            await asyncio.sleep(delay)


def start(charger_id: str, power_kw: float = 22.0) -> bool:
    if is_running(charger_id):
        return False
    task = asyncio.create_task(_loop(charger_id, power_kw))
    _tasks[charger_id] = task
    return True


def stop(charger_id: str) -> bool:
    task = _tasks.pop(charger_id, None)
    if task and not task.done():
        task.cancel()
        return True
    return False
