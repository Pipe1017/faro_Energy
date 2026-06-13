"""Punto de entrada: app FastAPI, startup (migraciones + seeds + workers) y routers."""
import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from dotenv import load_dotenv

from database import engine, AsyncSessionLocal, Base
from models import User, Charger, ChargerBrandProfile
from auth import hash_password
import sim as sim_mgr
from config import ALLOWED_ORIGINS, SEED_OWNERS, SEED_CHARGERS, SEED_BRAND_PROFILES, SEED_PASSWORD, SEED_DEMO_USERS
from engine import _charge_worker, _offline_watcher, _settlement_worker, _backfill_ledger
from routers import ocpp, public, auth as auth_router, chargers, reservations, driver, owner

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="CPO Colombia")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*", "ngrok-skip-browser-warning"],
)


@app.on_event("startup")
async def startup():
    # create_all en su propia transacción — debe commitear antes de las migraciones
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Cada ALTER TABLE en transacción independiente para que un fallo no afecte a los demás
    from sqlalchemy import text as _sql
    for stmt, label in [
        ("ALTER TABLE payment_methods ADD COLUMN nickname TEXT",                                          "nickname en payment_methods"),
        ("ALTER TABLE disbursement_accounts ADD COLUMN verified BOOLEAN DEFAULT FALSE",               "verified en disbursement_accounts"),
        ("ALTER TABLE disbursement_accounts ADD COLUMN verified_at TIMESTAMP",                        "verified_at en disbursement_accounts"),
        ("ALTER TABLE payment_transactions ADD COLUMN wompi_payment_source_id INTEGER",               "wompi_payment_source_id en payment_transactions"),
        ("ALTER TABLE payment_methods ADD COLUMN wompi_payment_source_id INTEGER",                   "wompi_payment_source_id en payment_methods"),
        ("ALTER TABLE payment_transactions ADD COLUMN wompi_preauth_id INTEGER",                    "wompi_preauth_id en payment_transactions"),
        ("ALTER TABLE disbursement_records ALTER COLUMN session_id DROP NOT NULL",                  "session_id nullable en disbursement_records"),
        ("ALTER TABLE chargers ADD COLUMN vendor TEXT",                                             "vendor en chargers"),
        ("ALTER TABLE chargers ADD COLUMN brand_profile_id TEXT",                                   "brand_profile_id en chargers"),
        ("ALTER TABLE chargers ADD COLUMN peak_price_per_kwh FLOAT",                                "peak_price_per_kwh en chargers"),
    ]:
        try:
            async with engine.begin() as conn:
                await conn.execute(_sql(stmt))
            logger.info(f"Migración: {label}")
        except Exception as e:
            # Solo ignorar "ya existe" — cualquier otro error de migración debe verse
            msg = str(e).lower()
            if not any(k in msg for k in ("already exists", "duplicate", "ya existe", "duplicatecolumn")):
                logger.error(f"Migración FALLÓ ({label}): {e}")

    async with AsyncSessionLocal() as db:
        owner_ids: Dict[str, str] = {}
        if SEED_OWNERS and SEED_PASSWORD == "1234":
            logger.warning("⚠ Usuarios demo con clave por defecto '1234' — define SEED_PASSWORD o SEED_DEMO_USERS=false en prod")
        for o in SEED_OWNERS:
            result = await db.execute(select(User).where(User.email == o["email"]))
            user = result.scalar_one_or_none()
            if not user:
                user = User(email=o["email"], name=o["name"], password_hash=hash_password(SEED_PASSWORD), role=o["role"])
                db.add(user)
                await db.flush()
                logger.info(f"Seed: usuario {user.email}")
            owner_ids[o["email"]] = user.id

        for bp in SEED_BRAND_PROFILES:
            existing_bp = await db.get(ChargerBrandProfile, bp["id"])
            if not existing_bp:
                db.add(ChargerBrandProfile(
                    id=bp["id"], vendor=bp["vendor"], model=bp["model"],
                    display_name=bp["display_name"], ocpp_version=bp["ocpp_version"],
                    connector_types=json.dumps(bp["connector_types"]),
                    max_power_kw=bp["max_power_kw"],
                    features=json.dumps(bp["features"]),
                    quirks=json.dumps(bp["quirks"]),
                    setup_guide_md=bp["setup_guide_md"],
                ))
                logger.info(f"Seed: perfil de marca {bp['id']}")

        for c in SEED_CHARGERS:
            charger = await db.get(Charger, c["id"])
            if not charger:
                charger = Charger(
                    id=c["id"], owner_id=owner_ids.get(c["owner"]),
                    location=c["location"], lat=c["lat"], lng=c["lng"],
                    power_kw=c["power_kw"], connector_type=c["connector"],
                    price_per_kwh=c["price"], cost_per_kwh=c["cost"],
                )
                db.add(charger)
                logger.info(f"Seed: cargador {charger.id}")

        await db.commit()

    # Arrancar simuladores para todos los cargadores que existan en la DB
    async def _autostart_all_sims():
        await asyncio.sleep(2)  # esperar a que el WebSocket esté listo
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Charger))
            all_chargers = result.scalars().all()
        for c in all_chargers:
            sim_mgr.start(c.id, c.power_kw or 22.0)
            logger.info(f"Simulador auto-iniciado: {c.id} ({c.power_kw or 22} kW)")

    asyncio.create_task(_autostart_all_sims())

    # Worker de cobros (outbox) + cierre de sesiones huérfanas
    asyncio.create_task(_charge_worker())

    # Liquidación automática a dueños + backfill de sesiones pre-ledger
    await _backfill_ledger()
    asyncio.create_task(_settlement_worker())
    asyncio.create_task(_offline_watcher())



app.include_router(ocpp.router)
app.include_router(public.router)
app.include_router(auth_router.router)
app.include_router(chargers.router)
app.include_router(reservations.router)
app.include_router(driver.router)
app.include_router(owner.router)
