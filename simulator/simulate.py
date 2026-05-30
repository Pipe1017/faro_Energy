import asyncio
import logging
import random
from datetime import datetime, timezone

import websockets
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call
from ocpp.v16.enums import ChargePointStatus, RegistrationStatus

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)-12s] %(message)s")

CHARGERS = [
    {"id": "CP-MED-001", "owner": "dueño_1", "location": "Universidad de Antioquia"},
    {"id": "CP-MED-002", "owner": "dueño_1", "location": "CC El Tesoro"},
    {"id": "CP-MED-003", "owner": "dueño_1", "location": "CC Santafé"},
    {"id": "CP-MED-004", "owner": "dueño_2", "location": "Universidad EAFIT"},
    {"id": "CP-MED-005", "owner": "dueño_2", "location": "CC Oviedo"},
]


class SimulatedCharger(cp):
    def __init__(self, charger_id, connection, owner):
        super().__init__(charger_id, connection)
        self.owner = owner
        self.log = logging.getLogger(charger_id)

    async def boot(self):
        response = await self.call(call.BootNotificationPayload(
            charge_point_model="SimCargador-v1",
            charge_point_vendor=f"CPO-Col ({self.owner})",
        ))
        ok = response.status == RegistrationStatus.accepted
        if ok:
            self.log.info("Registrado en servidor OCPP")
        return ok

    async def set_status(self, status):
        await self.call(call.StatusNotificationPayload(
            connector_id=1, error_code="NoError", status=status
        ))

    async def simulate_session(self):
        user_tag = f"USER-{random.randint(100, 999)}"
        meter_start = random.randint(10000, 50000)

        self.log.info(f"Nuevo usuario: {user_tag}")
        await self.set_status(ChargePointStatus.preparing)

        auth = await self.call(call.AuthorizePayload(id_tag=user_tag))
        if auth.id_tag_info["status"] != "Accepted":
            await self.set_status(ChargePointStatus.available)
            return

        start = await self.call(call.StartTransactionPayload(
            connector_id=1,
            id_tag=user_tag,
            meter_start=meter_start,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ))
        tx_id = start.transaction_id
        await self.set_status(ChargePointStatus.charging)
        self.log.info(f"Cargando... tx#{tx_id}")

        energy = meter_start
        duration = random.randint(3, 6)

        for _ in range(duration):
            await asyncio.sleep(8)
            energy += random.randint(500, 2000)
            await self.call(call.MeterValuesPayload(
                connector_id=1,
                transaction_id=tx_id,
                meter_value=[{
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "sampledValue": [{"value": str(energy), "unit": "Wh"}],
                }],
            ))
            kwh = (energy - meter_start) / 1000
            self.log.info(f"Energía: {kwh:.2f} kWh")

        await self.call(call.StopTransactionPayload(
            meter_stop=energy,
            timestamp=datetime.now(timezone.utc).isoformat(),
            transaction_id=tx_id,
            reason="Local",
        ))
        total_kwh = (energy - meter_start) / 1000
        self.log.info(f"Sesión terminada — {total_kwh:.2f} kWh entregados")
        await self.set_status(ChargePointStatus.available)

    async def run(self):
        if not await self.boot():
            raise Exception("Boot fallido")
        await self.set_status(ChargePointStatus.available)
        while True:
            wait = random.randint(15, 45)
            self.log.info(f"Disponible — próxima sesión en {wait}s")
            await asyncio.sleep(wait)
            try:
                await self.simulate_session()
            except Exception as e:
                self.log.warning(f"Error en sesión: {e}")
                await self.set_status(ChargePointStatus.available)


async def connect_charger(config):
    url = f"ws://localhost:8000/ocpp/{config['id']}"
    log = logging.getLogger(config["id"])
    while True:
        try:
            async with websockets.connect(url, subprotocols=["ocpp1.6"]) as ws:
                charger = SimulatedCharger(config["id"], ws, config["owner"])
                await charger.run()
        except Exception as e:
            log.warning(f"Desconectado ({e}) — reconectando en 5s...")
            await asyncio.sleep(5)


async def main():
    print("\n" + "=" * 55)
    print("  CPO COLOMBIA — Simulador de Cargadores Medellín")
    print("=" * 55)
    print("  dueño_1 → CP-MED-001, CP-MED-002, CP-MED-003")
    print("  dueño_2 → CP-MED-004, CP-MED-005")
    print("  Estado:  http://localhost:8000/status")
    print("  API:     http://localhost:8000/docs")
    print("=" * 55 + "\n")
    await asyncio.gather(*[connect_charger(c) for c in CHARGERS])


if __name__ == "__main__":
    asyncio.run(main())
