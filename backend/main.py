"""Punto de entrada: app FastAPI, startup (migraciones + seeds + workers) y routers."""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from dotenv import load_dotenv

from database import engine, AsyncSessionLocal, Base
from models import User, Charger, ChargerBrandProfile, new_tag
from auth import hash_password, verify_password
import sim as sim_mgr
from config import ALLOWED_ORIGINS, SEED_OWNERS, SEED_CHARGERS, SEED_BRAND_PROFILES, SEED_PASSWORD, SEED_DEMO_USERS
from engine import _charge_worker, _offline_watcher, _settlement_worker, _backfill_ledger, _reservation_worker, _invoice_worker
from routers import ocpp, public, auth as auth_router, chargers, reservations, driver, owner, admin

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
        ("ALTER TABLE reservations ADD COLUMN no_show_at TIMESTAMP",                                "no_show_at en reservations"),
        ("ALTER TABLE reservations ADD COLUMN fee_cents INTEGER DEFAULT 0",                         "fee_cents en reservations"),
        ("ALTER TABLE reservations ADD COLUMN captured_cents INTEGER DEFAULT 0",                    "captured_cents en reservations"),
        ("ALTER TABLE reservations ADD COLUMN wompi_preauth_id INTEGER",                            "wompi_preauth_id en reservations"),
        ("ALTER TABLE reservations ADD COLUMN payment_tx_id TEXT",                                  "payment_tx_id en reservations"),
        ("ALTER TABLE reservations ADD COLUMN session_id INTEGER",                                  "session_id en reservations"),
        ("ALTER TABLE reservations ADD COLUMN settled BOOLEAN DEFAULT FALSE",                       "settled en reservations"),
        # Modelo A — bolsas internas + datos fiscales del dueño + facturación
        ("ALTER TABLE users ADD COLUMN rut TEXT",                                                   "rut en users"),
        ("ALTER TABLE users ADD COLUMN responsable_iva BOOLEAN DEFAULT TRUE",                       "responsable_iva en users"),
        ("ALTER TABLE ledger_entries ADD COLUMN account TEXT",                                      "account en ledger_entries"),
        ("ALTER TABLE ledger_entries ALTER COLUMN owner_id DROP NOT NULL",                          "owner_id nullable en ledger_entries"),
        ("ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE",                        "email_verified en users"),
        ("ALTER TABLE users ADD COLUMN email_verify_token TEXT",                                     "email_verify_token en users"),
        ("ALTER TABLE chargers ADD COLUMN rating_up INTEGER DEFAULT 0",                              "rating_up en chargers"),
        ("ALTER TABLE chargers ADD COLUMN rating_down INTEGER DEFAULT 0",                            "rating_down en chargers"),
        # Email único por (email, rol): quitar el único global y crear el compuesto
        ("DROP INDEX IF EXISTS ix_users_email",                                                      "drop índice único global de email"),
        ("CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email_role ON users (email, role)",              "índice único (email, role)"),
        ("ALTER TABLE users ADD COLUMN tag TEXT",                                                     "tag (idTag OCPP) en users"),
        ("CREATE UNIQUE INDEX IF NOT EXISTS uq_user_tag ON users (tag)",                              "índice único de tag"),
        ("ALTER TABLE disbursement_records ADD COLUMN method TEXT DEFAULT 'WOMPI'",                   "method en disbursement_records"),
        ("ALTER TABLE disbursement_records ADD COLUMN note TEXT",                                     "note en disbursement_records"),
        ("ALTER TABLE users ADD COLUMN subscription_active BOOLEAN DEFAULT TRUE",                     "subscription_active en users"),
        ("ALTER TABLE users ADD COLUMN subscription_paid_until TIMESTAMP",                            "subscription_paid_until en users"),
        ("ALTER TABLE users ADD COLUMN terms_accepted_at TIMESTAMP",                                  "terms_accepted_at en users"),
        ("ALTER TABLE users ADD COLUMN terms_version TEXT",                                           "terms_version en users"),
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
                user = User(email=o["email"], name=o["name"], password_hash=hash_password(SEED_PASSWORD), role=o["role"],
                            email_verified=True)
                db.add(user)
                await db.flush()
                logger.info(f"Seed: usuario {user.email}")
            elif not user.email_verified:
                # Cuentas semilla creadas antes de existir email_verified: marcarlas
                # verificadas para que no queden bloqueadas por la regla de login.
                user.email_verified = True
                logger.info(f"Seed: {user.email} marcado como verificado")
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

        # ── Administrador de Faro por env (independiente de los seeds demo) ──
        # ADMIN_EMAIL define quién es el administrador de la PLATAFORMA (rol "admin":
        # ve todo el back-office). Si el usuario ya existe, se promueve a admin; si no,
        # se crea con ADMIN_PASSWORD. Así tu correo real es el admin, no el demo.
        admin_email = os.getenv("ADMIN_EMAIL", "").lower().strip()
        admin_password = os.getenv("ADMIN_PASSWORD", "")
        if admin_email:
            result = await db.execute(select(User).where(User.email == admin_email))
            admin_user = result.scalar_one_or_none()
            if admin_user:
                # El .env es la fuente de verdad del admin: sincroniza rol, verificación
                # y clave (si ADMIN_PASSWORD cambió) en cada arranque.
                changed = []
                if admin_user.role != "admin":
                    admin_user.role = "admin"; changed.append("rol")
                if not admin_user.email_verified:
                    admin_user.email_verified = True; changed.append("verificado")
                if admin_password and not verify_password(admin_password, admin_user.password_hash):
                    admin_user.password_hash = hash_password(admin_password); changed.append("clave")
                if changed:
                    logger.info(f"Admin: {admin_email} actualizado ({', '.join(changed)})")
            elif admin_password:
                db.add(User(email=admin_email, name="Admin Faro",
                            password_hash=hash_password(admin_password),
                            role="admin", email_verified=True))
                logger.info(f"Admin: creado administrador de Faro {admin_email}")
            else:
                logger.warning(f"ADMIN_EMAIL={admin_email} no existe y falta ADMIN_PASSWORD para crearlo")

        # Backfill: usuarios creados antes de la columna `tag` → asignar uno único
        result = await db.execute(select(User).where(User.tag.is_(None)))
        for u in result.scalars().all():
            u.tag = new_tag()
            logger.info(f"Backfill: tag asignado a {u.email}")

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

    # Liquidación a dueños: backfill + (giro automático SOLO si AUTO_SETTLEMENT)
    await _backfill_ledger()
    from config import AUTO_SETTLEMENT
    if AUTO_SETTLEMENT:
        asyncio.create_task(_settlement_worker())
        logger.info("Pago automático a dueños: ACTIVADO (días 5/20)")
    else:
        logger.info("Pago automático a dueños: DESACTIVADO — pagos manuales desde el back-office")

    # Cobro automático de la mensualidad (placeholder listo: AUTO_SUBSCRIPTION_BILLING)
    from config import AUTO_SUBSCRIPTION_BILLING
    if AUTO_SUBSCRIPTION_BILLING:
        from engine import _subscription_billing_worker
        asyncio.create_task(_subscription_billing_worker())
        logger.info("Cobro automático de mensualidad: ACTIVADO")
    else:
        logger.info("Cobro automático de mensualidad: DESACTIVADO — cobro manual desde el back-office")

    asyncio.create_task(_offline_watcher())

    # Vencimiento de separaciones (no-show → multa al dueño)
    asyncio.create_task(_reservation_worker())

    # Emisión de facturas electrónicas (outbox: stub → MinIO; Factus cuando exista)
    asyncio.create_task(_invoice_worker())



app.include_router(ocpp.router)
app.include_router(public.router)
app.include_router(auth_router.router)
app.include_router(chargers.router)
app.include_router(reservations.router)
app.include_router(driver.router)
app.include_router(owner.router)
app.include_router(admin.router)
