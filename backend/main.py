import asyncio
import json
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from ocpp.routing import on
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call_result, call
from ocpp.v16.enums import Action, RegistrationStatus, AvailabilityType
from dotenv import load_dotenv

from database import engine, AsyncSessionLocal, Base, get_db
from models import User, Charger, Session, Reservation, PaymentMethod, DisbursementAccount, PaymentTransaction, DisbursementRecord, PendingCharge, LedgerEntry, ChargerBrandProfile, OwnerEvent
import wompi as wompi_svc
from auth import hash_password, verify_password, create_token, get_current_user
import sim as sim_mgr

PLATFORM_MARGIN = 0.10   # 10% comisión CPO
IVA_RATE        = 0.19   # IVA Colombia
GATEWAY_FEE     = 0.03   # pasarela de pagos

WOMPI_MIN_CENTS         = 150_000  # $1.500 COP — monto mínimo que acepta Wompi
CHARGE_MAX_ATTEMPTS     = 8        # reintentos de cobro antes de pasar a revisión manual
OFFLINE_SESSION_TIMEOUT = 300      # s sin señal del cargador antes de cerrar su sesión huérfana

MIN_WITHDRAW_COP        = 1_000    # retiro manual mínimo del dueño
SETTLEMENT_DAYS         = (5, 20)  # días de corte: giro automático (siguiente día hábil Colombia)
SETTLE_CHECK_INTERVAL   = 3600     # el job revisa cada hora si hoy es día de giro

# URL pública del WebSocket OCPP — lo que el dueño configura en su cargador
PUBLIC_WS_BASE = os.getenv("PUBLIC_WS_BASE", "wss://preseason-constable-sappiness.ngrok-free.dev/ocpp")

def ocpp_url(charger_id: str) -> str:
    return f"{PUBLIC_WS_BASE}/{charger_id}"


def price_to_conductor(price_per_kwh: float) -> float:
    """Precio final que paga el conductor por kWh, incluyendo todos los cargos."""
    return price_per_kwh * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * (1 + GATEWAY_FEE)

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="CPO Colombia")

# CORS solo aplica a clientes web (la app nativa no manda Origin).
# En prod: ALLOWED_ORIGINS=https://faroenergy.lat,https://app.faroenergy.lat
ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "https://faroenergy.lat,http://localhost:5173,http://localhost:3000",
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*", "ngrok-skip-browser-warning"],
)

# WebSocket connections viven en memoria (no se pueden persistir)
connected_chargers: Dict[str, "ChargePoint"] = {}

# Usuarios demo: solo se crean si SEED_DEMO_USERS=true (default en dev).
# La clave sale de SEED_PASSWORD — en prod apaga el seed o usa una clave fuerte.
SEED_DEMO_USERS = os.getenv("SEED_DEMO_USERS", "true").lower() == "true"
SEED_PASSWORD   = os.getenv("SEED_PASSWORD", "1234")

SEED_OWNERS = [
    {"email": "admin@cpo.com",      "name": "Admin CPO",   "role": "admin"},
    {"email": "carlos@cpo.com",     "name": "Carlos",      "role": "owner"},
    {"email": "juanes@cpo.com",     "name": "Juanes",      "role": "owner"},
    {"email": "conductor1@cpo.com", "name": "Conductor 1", "role": "conductor"},
    {"email": "conductor2@cpo.com", "name": "Conductor 2", "role": "conductor"},
] if SEED_DEMO_USERS else []
SEED_CHARGERS = []   # Los dueños agregan sus cargadores desde la app

# Perfiles de marca — el catálogo crece a medida que se integran fabricantes.
# El matching usa vendor/model del BootNotification; model NULL aplica a todo el vendor.
SEED_BRAND_PROFILES = [
    {
        "id": "faro-sim", "vendor": "CPO-Colombia", "model": "CPO-Sim-v1",
        "display_name": "Simulador Faro", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 150,
        "features": {"remote_start": True, "remote_stop": True, "reserve": True, "change_availability": True},
        "quirks": {},
        "setup_guide_md": "Cargador virtual para pruebas. Se conecta automáticamente al registrarlo — no requiere configuración.",
    },
    {
        "id": "wallbox-pulsar-plus", "vendor": "Wallbox", "model": "Pulsar Plus",
        "display_name": "Wallbox Pulsar Plus", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": True},
        "quirks": {"heartbeat_interval": 300, "config_via": "portal myWallbox"},
        "setup_guide_md": (
            "1. Entra a my.wallbox.com con la cuenta del cargador\n"
            "2. Selecciona tu Pulsar Plus → Configuración → OCPP\n"
            "3. Activa OCPP y pega la URL que te dimos\n"
            "4. En 'Charge Point ID' escribe el ID asignado por Faro\n"
            "5. Guarda — el cargador se reinicia y aparecerá En línea aquí"
        ),
    },
    {
        "id": "abb-terra-ac", "vendor": "ABB", "model": "Terra AC",
        "display_name": "ABB Terra AC", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": True, "change_availability": True},
        "quirks": {"config_via": "app TerraConfig"},
        "setup_guide_md": (
            "1. Descarga la app TerraConfig (ABB) y conéctate al cargador por Bluetooth\n"
            "2. Ve a Configuración → OCPP → Servidor\n"
            "3. Pega la URL de Faro y el ID asignado\n"
            "4. Reinicia el cargador desde la app"
        ),
    },
    {
        "id": "growatt-thor", "vendor": "Growatt", "model": None,
        "display_name": "Growatt THOR", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": True},
        "quirks": {"config_via": "app ShinePhone"},
        "setup_guide_md": (
            "1. Abre ShinePhone y entra a tu cargador THOR\n"
            "2. Configuración → OCPP Server URL → pega la URL de Faro\n"
            "3. ChargePoint ID = el ID asignado por Faro\n"
            "4. Guarda y espera ~1 minuto a que reconecte"
        ),
    },
    {
        "id": "generic-ocpp16", "vendor": "Genérico", "model": None,
        "display_name": "Genérico OCPP 1.6", "ocpp_version": "1.6J",
        "connector_types": ["Type 2", "CCS2", "CHAdeMO", "Schuko"], "max_power_kw": None,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": False},
        "quirks": {},
        "setup_guide_md": (
            "Cualquier cargador con OCPP 1.6-J (la mayoría de marcas chinas lo soportan):\n"
            "1. Busca en la app o panel web del fabricante la opción 'OCPP' o 'Backend'\n"
            "2. Pega la URL de Faro como servidor OCPP\n"
            "3. Usa el ID asignado como ChargePoint ID / ChargeBox ID\n"
            "4. Asegúrate de elegir OCPP 1.6 JSON (no SOAP)\n"
            "Si la marca no aparece en nuestro catálogo, escríbenos y la integramos."
        ),
    },
]


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


async def _match_brand_profile(db: AsyncSession, vendor: str, model: str) -> ChargerBrandProfile | None:
    """Busca el perfil de marca: primero vendor+model exactos, luego solo vendor
    (perfiles con model NULL cubren toda la línea del fabricante)."""
    if not vendor:
        return None
    v, m = vendor.strip().lower(), (model or "").strip().lower()
    result = await db.execute(select(ChargerBrandProfile))
    profiles = result.scalars().all()
    for p in profiles:
        if p.model and p.vendor.lower() == v and p.model.lower() == m:
            return p
    for p in profiles:
        if p.model is None and p.vendor.lower() == v:
            return p
    return None


# ── OCPP ─────────────────────────────────────────────────────────────────────

class WebSocketAdapter:
    def __init__(self, ws: WebSocket):
        self.ws = ws

    async def send(self, msg: str):
        await self.ws.send_text(msg)

    async def recv(self) -> str:
        return await self.ws.receive_text()


class ChargePoint(cp):

    @on(Action.BootNotification)
    async def on_boot_notification(self, charge_point_model, charge_point_vendor, **kwargs):
        logger.info(f"[{self.id}] Boot — {charge_point_vendor}/{charge_point_model}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                charger.status = "Available"
                charger.model = charge_point_model
                charger.vendor = charge_point_vendor
                charger.last_seen = datetime.now(timezone.utc)
                # Match automático contra el catálogo de marcas
                profile = await _match_brand_profile(db, charge_point_vendor, charge_point_model)
                if profile and charger.brand_profile_id != profile.id:
                    charger.brand_profile_id = profile.id
                    logger.info(f"[{self.id}] Marca identificada: {profile.display_name}")
                elif not profile:
                    logger.info(f"[{self.id}] Marca sin perfil en catálogo: {charge_point_vendor}/{charge_point_model} — candidata a integrar")
                await db.commit()
        return call_result.BootNotificationPayload(
            current_time=datetime.now(timezone.utc).isoformat(),
            interval=30,
            status=RegistrationStatus.accepted,
        )

    @on(Action.Heartbeat)
    async def on_heartbeat(self):
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                charger.last_seen = datetime.now(timezone.utc)
                await db.commit()
        return call_result.HeartbeatPayload(current_time=datetime.now(timezone.utc).isoformat())

    @on(Action.StatusNotification)
    async def on_status_notification(self, connector_id, error_code, status, **kwargs):
        logger.info(f"[{self.id}] Estado → {status}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                charger.status = status
                await db.commit()
        return call_result.StatusNotificationPayload()

    @on(Action.Authorize)
    async def on_authorize(self, id_tag, **kwargs):
        return call_result.AuthorizePayload(id_tag_info={"status": "Accepted"})

    @on(Action.StartTransaction)
    async def on_start_transaction(self, connector_id, id_tag, meter_start, timestamp, **kwargs):
        tx_id = int(datetime.now().timestamp())
        logger.info(f"[{self.id}] Sesión iniciada — tx#{tx_id} usuario:{id_tag}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                charger.status = "Charging"
                charger.active_transaction = tx_id
                charger.session_user = id_tag
                charger.meter_start = meter_start
                charger.session_started_at = datetime.now(timezone.utc)
                charger.current_kwh = 0.0   # resetear al iniciar sesión nueva
                _notify_owner(db, charger.owner_id, "SESSION_STARTED",
                              f"{self.id}: carga iniciada por {id_tag}", self.id)
                await db.commit()
        return call_result.StartTransactionPayload(transaction_id=tx_id, id_tag_info={"status": "Accepted"})

    @on(Action.MeterValues)
    async def on_meter_values(self, connector_id, meter_value, **kwargs):
        try:
            reading = meter_value[0]
            # OCPP lib puede usar camelCase o snake_case según la versión
            samples = (reading.get("sampledValue")
                    or reading.get("sampled_value")
                    or [])
            if not samples:
                logger.warning(f"[{self.id}] MeterValues sin sampledValue: {reading}")
                return call_result.MeterValuesPayload()

            wh = float(samples[0]["value"])
            async with AsyncSessionLocal() as db:
                charger = await db.get(Charger, self.id)
                if charger and charger.meter_start is not None:
                    session_kwh = round((wh - charger.meter_start) / 1000, 3)
                    charger.current_kwh = max(0.0, session_kwh)
                    await db.commit()
                    logger.info(f"[{self.id}] MeterValues: {wh:.0f}Wh → {charger.current_kwh:.3f} kWh")
        except Exception as e:
            logger.warning(f"[{self.id}] Error MeterValues: {e}")
        return call_result.MeterValuesPayload()

    @on(Action.StopTransaction)
    async def on_stop_transaction(self, meter_stop, timestamp, transaction_id, **kwargs):
        logger.info(f"[{self.id}] Sesión terminada — tx#{transaction_id}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                kwh = (meter_stop - (charger.meter_start or 0)) / 1000
                await _finalize_session(db, charger, kwh)
                await db.commit()
        return call_result.StopTransactionPayload(id_tag_info={"status": "Accepted"})


# ── CIERRE DE SESIÓN Y COBRO (outbox) ─────────────────────────────────────────

def _notify_owner(db: AsyncSession, owner_id: str | None, type_: str, message: str, charger_id: str | None = None):
    """Registra una alerta para el dueño (centro de alertas in-app)."""
    if owner_id:
        db.add(OwnerEvent(owner_id=owner_id, type=type_, message=message, charger_id=charger_id))


def session_money(kwh: float, charger: Charger, started_at: datetime | None = None) -> dict:
    """Montos en COP enteros: el total es la suma exacta de sus partes
    para que cobrado = dueño + comisión + IVA + pasarela cuadre siempre.
    El precio base depende de la franja horaria al INICIO de la sesión."""
    price_base = charger.price_at(started_at)
    cost_base  = charger.cost_per_kwh or 0
    revenue    = round(kwh * price_base)
    commission = round(revenue * PLATFORM_MARGIN)
    subtotal   = revenue + commission
    iva        = round(subtotal * IVA_RATE)
    gateway    = round((subtotal + iva) * GATEWAY_FEE)
    total      = subtotal + iva + gateway
    elec_cost  = round(kwh * cost_base)
    return {
        "revenue": revenue, "commission": commission, "iva": iva,
        "gateway": gateway, "total": total, "elec_cost": elec_cost,
        "net_profit": revenue - elec_cost,
    }


async def _finalize_session(db: AsyncSession, charger: Charger, kwh: float, final_status: str = "Available") -> Session:
    """
    Cierra la sesión activa de un cargador: crea el registro Session y encola
    el cobro en pending_charges (mismo commit — si el backend muere, el cobro
    queda registrado y el worker lo ejecuta al reiniciar).
    Se usa desde StopTransaction, desde el cierre manual y desde el janitor
    de sesiones huérfanas.
    """
    kwh = max(0.0, kwh)
    m = session_money(kwh, charger, charger.session_started_at)
    session = Session(
        charger_id=charger.id,
        session_user=charger.session_user,
        kwh_delivered=kwh,
        price_per_kwh=charger.price_at(charger.session_started_at),
        price_to_user=m["total"] / kwh if kwh > 0 else 0,
        revenue_owner=m["revenue"],
        commission_cpo=m["commission"],
        iva_amount=m["iva"],
        gateway_fee=m["gateway"],
        electricity_cost=m["elec_cost"],
        net_profit_owner=m["net_profit"],
        total_charged=m["total"],
        started_at=charger.session_started_at,
        ended_at=datetime.now(timezone.utc),
    )
    db.add(session)
    await db.flush()  # obtener session.id antes de crear registros dependientes

    result_pay = await db.execute(
        select(PaymentTransaction)
        .where(
            PaymentTransaction.charger_id == charger.id,
            PaymentTransaction.status == "APPROVED",
            PaymentTransaction.session_id.is_(None),
        )
        .order_by(PaymentTransaction.created_at.desc())
        .limit(1)
    )
    pay_tx = result_pay.scalars().first()
    if pay_tx:
        pay_tx.session_id = session.id
        db.add(PendingCharge(
            session_id=session.id,
            payment_tx_id=pay_tx.id,
            amount_cents=m["total"] * 100,
            next_attempt_at=datetime.now(timezone.utc),
        ))
        logger.info(f"[{charger.id}] Cobro encolado: ${m['total']:,} COP — sesión #{session.id}")
    else:
        logger.warning(f"[{charger.id}] Sin pago autorizado — sesión #{session.id} queda sin cobro")

    _notify_owner(
        db, charger.owner_id, "SESSION_COMPLETED",
        f"{charger.id}: sesión de {kwh:.2f} kWh terminada — ganancia ${m['revenue']:,} COP",
        charger.id,
    )

    charger.status = final_status
    charger.last_kwh = round(kwh, 3)
    charger.active_transaction = None
    charger.session_user = None
    charger.session_started_at = None
    charger.current_kwh = None
    charger.meter_start = None
    logger.info(f"[{charger.id}] {kwh:.3f}kWh · ingreso:{m['revenue']} · luz:{m['elec_cost']} · neto:{m['net_profit']} COP")
    return session


async def _settle_captured(db: AsyncSession, pc: PendingCharge, pay_tx: PaymentTransaction):
    """Cobro confirmado: marca CAPTURED y abona la ganancia al ledger del dueño.
    La plata sale hacia su cuenta solo en la liquidación (retiro manual o job
    automático) — nunca antes de confirmar que el conductor pagó."""
    pc.status = "DONE"
    pay_tx.status = "CAPTURED"
    logger.info(f"✓ Cobro sesión #{pc.session_id}: ${pay_tx.amount_cents // 100:,} COP CAPTURED")

    session = await db.get(Session, pc.session_id)
    if not session:
        return
    charger = await db.get(Charger, session.charger_id)
    owner_id = charger.owner_id if charger else None
    revenue = int(session.revenue_owner)
    if not owner_id or revenue <= 0:
        return

    # Evitar abono duplicado si el worker reintenta
    existing = await db.execute(
        select(LedgerEntry)
        .where(LedgerEntry.session_id == session.id, LedgerEntry.type == "EARNING")
        .limit(1)
    )
    if existing.scalars().first():
        return

    db.add(LedgerEntry(
        owner_id=owner_id,
        session_id=session.id,
        type="EARNING",
        amount_cents=revenue * 100,
        description=f"Ganancia sesión #{session.id} — {session.charger_id}",
    ))
    logger.info(f"[{session.charger_id}] Ledger: +${revenue:,} COP para dueño {owner_id[:8]} (sesión #{session.id})")


# ── LIQUIDACIÓN AL DUEÑO ─────────────────────────────────────────────────────

# Lock por dueño: evita doble giro si el retiro manual y el job automático
# calculan el mismo saldo al mismo tiempo
_settle_locks: Dict[str, asyncio.Lock] = {}

def _settle_lock(owner_id: str) -> asyncio.Lock:
    if owner_id not in _settle_locks:
        _settle_locks[owner_id] = asyncio.Lock()
    return _settle_locks[owner_id]


async def _owner_balance_cents(db: AsyncSession, owner_id: str) -> int:
    result = await db.execute(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.owner_id == owner_id)
    )
    return int(result.scalar() or 0)


async def _settle_owner(db: AsyncSession, owner_id: str, min_cop: int) -> dict:
    """Dispersa el saldo acumulado del dueño hacia su cuenta (Nequi o banco).
    Registra DisbursementRecord + asiento DISBURSEMENT en el ledger.
    Si Wompi no tiene dispersiones activas, el giro queda PENDING_ACTIVATION
    pero el saldo SÍ se descuenta (la deuda vive en el record, no en el ledger)."""
    balance = await _owner_balance_cents(db, owner_id)
    if balance < min_cop * 100:
        return {"ok": False, "reason": f"Saldo insuficiente: el mínimo de retiro es ${min_cop:,} COP", "balance_cop": balance // 100}

    result = await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == owner_id))
    disb_acc = result.scalar_one_or_none()
    if not disb_acc:
        return {"ok": False, "reason": "Configura primero tu cuenta de dispersión (Nequi o banco)", "balance_cop": balance // 100}

    ref  = f"settle-{owner_id[:8]}-{int(datetime.now().timestamp())}"
    desc = f"Liquidación Faro Energy — ${balance // 100:,} COP"
    try:
        if disb_acc.type == "NEQUI" and disb_acc.phone:
            resp = await wompi_svc.disburse_nequi(ref, balance, disb_acc.phone, desc)
        elif disb_acc.type == "BANK" and disb_acc.account_number:
            resp = await wompi_svc.disburse_bank(
                ref, balance, disb_acc.account_number, disb_acc.bank_code,
                disb_acc.account_type or "SAVINGS", disb_acc.holder_name, disb_acc.holder_id, desc,
            )
        else:
            return {"ok": False, "reason": "Tu cuenta de dispersión está incompleta", "balance_cop": balance // 100}
    except Exception as e:
        logger.warning(f"Liquidación {ref}: error conectando con Wompi: {e}")
        return {"ok": False, "reason": "No pudimos conectar con la pasarela — intenta de nuevo", "balance_cop": balance // 100}

    disb_data   = resp.get("data", {})
    disb_status = disb_data.get("status")
    wompi_err   = resp.get("error", {})

    if disb_status in ("FAILED", "ERROR", "DECLINED"):
        # Giro rechazado explícitamente — el saldo queda intacto
        logger.warning(f"Liquidación {ref} rechazada por Wompi: {disb_status}")
        return {"ok": False, "reason": "La pasarela rechazó el giro — verifica tu cuenta", "balance_cop": balance // 100}

    if not disb_status and (wompi_err or not disb_data.get("id")):
        # 404 = dispersiones no habilitadas en Wompi — el giro queda en cola
        disb_status = "PENDING_ACTIVATION"
        logger.warning(
            f"Liquidación {ref}: dispersiones no activas en Wompi — "
            f"${balance // 100:,} COP queda PENDIENTE para {disb_acc.type}"
        )

    record = DisbursementRecord(
        session_id=None,
        owner_id=owner_id,
        amount_cents=balance,
        wompi_disbursement_id=disb_data.get("id"),
        status=disb_status,
    )
    db.add(record)
    await db.flush()
    db.add(LedgerEntry(
        owner_id=owner_id,
        disbursement_id=record.id,
        type="DISBURSEMENT",
        amount_cents=-balance,
        description=f"Liquidación a {disb_acc.to_dict()['display']}",
    ))
    _notify_owner(
        db, owner_id, "SETTLEMENT_SENT",
        f"Giro de ${balance // 100:,} COP a {disb_acc.to_dict()['display']}"
        + (" — en cola hasta que Wompi active dispersiones" if disb_status == "PENDING_ACTIVATION" else " en camino"),
    )
    logger.info(f"Liquidación ${balance // 100:,} COP → dueño {owner_id[:8]} ({disb_acc.type}): {disb_status}")
    return {"ok": True, "amount_cop": balance // 100, "status": disb_status}


# ── Calendario de cortes (5 y 20, día hábil Colombia) ────────────────────────

from datetime import date as _date
from zoneinfo import ZoneInfo

BOGOTA = ZoneInfo("America/Bogota")
try:
    import holidays as _holidays
    _CO_HOLIDAYS = _holidays.CO()
except Exception:
    _CO_HOLIDAYS = {}
    logger.warning("Librería 'holidays' no disponible — los cortes solo evitan fines de semana")


def _is_business_day(d: _date) -> bool:
    return d.weekday() < 5 and d not in _CO_HOLIDAYS


def _to_business_day(d: _date) -> _date:
    """Si el día de corte cae en fin de semana o festivo, corre al siguiente hábil."""
    while not _is_business_day(d):
        d += timedelta(days=1)
    return d


def _settlement_anchors(today: _date) -> list[_date]:
    """Fechas de giro (ajustadas a día hábil) del mes anterior y el actual."""
    anchors = []
    months = [(today.year - 1, 12)] if today.month == 1 else [(today.year, today.month - 1)]
    months.append((today.year, today.month))
    for y, m in months:
        for day in SETTLEMENT_DAYS:
            anchors.append(_to_business_day(_date(y, m, day)))
    return anchors


def _last_settlement_anchor(today: _date) -> _date:
    return max(a for a in _settlement_anchors(today) if a <= today)


def _next_settlement_date(today: _date) -> _date:
    future = [a for a in _settlement_anchors(today) if a > today]
    if future:
        return min(future)
    # todos los cortes cercanos ya pasaron — primer corte del mes siguiente
    y, m = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    return _to_business_day(_date(y, m, SETTLEMENT_DAYS[0]))


async def _settlement_worker():
    """Giro automático a dueños los días 5 y 20 de cada mes (día hábil Colombia).
    Si el backend estuvo caído el día del corte, el giro sale al volver:
    se liquida todo dueño con saldo sin giro desde el último corte."""
    logger.info(f"Worker de liquidación iniciado — cortes los días {SETTLEMENT_DAYS} (hábil CO)")
    while True:
        try:
            today  = datetime.now(BOGOTA).date()
            anchor = _last_settlement_anchor(today)
            # El corte vence a las 0:00 Bogotá del día ancla — liquidar a quien
            # tenga saldo y ningún giro (manual o automático) desde esa fecha
            anchor_dt = datetime(anchor.year, anchor.month, anchor.day, tzinfo=BOGOTA)
            async with AsyncSessionLocal() as db:
                balances = await db.execute(
                    select(LedgerEntry.owner_id, func.sum(LedgerEntry.amount_cents))
                    .group_by(LedgerEntry.owner_id)
                    .having(func.sum(LedgerEntry.amount_cents) >= MIN_WITHDRAW_COP * 100)
                )
                candidates = [row[0] for row in balances.all()]
                owners = []
                for owner_id in candidates:
                    recent = await db.execute(
                        select(DisbursementRecord)
                        .where(
                            DisbursementRecord.owner_id == owner_id,
                            DisbursementRecord.created_at >= anchor_dt,
                            DisbursementRecord.status.notin_(["FAILED", "ERROR", "DECLINED"]),
                        )
                        .limit(1)
                    )
                    if not recent.scalars().first():
                        owners.append(owner_id)
            for owner_id in owners:
                async with _settle_lock(owner_id):
                    async with AsyncSessionLocal() as db:
                        result = await _settle_owner(db, owner_id, min_cop=MIN_WITHDRAW_COP)
                        await db.commit()
                if result.get("ok"):
                    logger.info(f"Corte {anchor}: liquidado dueño {owner_id[:8]} — ${result['amount_cop']:,} COP")
        except Exception as e:
            logger.warning(f"settlement_worker: {e}")
        await asyncio.sleep(SETTLE_CHECK_INTERVAL)


async def _backfill_ledger():
    """Abona al ledger las sesiones cobradas (CAPTURED) antes de que existiera
    el ledger. Idempotente: salta sesiones con abono o dispersión previa."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Session, Charger.owner_id)
            .join(Charger, Session.charger_id == Charger.id)
            .join(PaymentTransaction, PaymentTransaction.session_id == Session.id)
            .where(PaymentTransaction.status == "CAPTURED")
        )
        added = 0
        for session, owner_id in result.all():
            revenue = int(session.revenue_owner)
            if not owner_id or revenue <= 0:
                continue
            has_entry = await db.execute(
                select(LedgerEntry).where(LedgerEntry.session_id == session.id).limit(1)
            )
            if has_entry.scalars().first():
                continue
            # Si ya hubo dispersión por sesión (sistema viejo), esa plata ya salió
            has_disb = await db.execute(
                select(DisbursementRecord).where(DisbursementRecord.session_id == session.id).limit(1)
            )
            if has_disb.scalars().first():
                continue
            db.add(LedgerEntry(
                owner_id=owner_id,
                session_id=session.id,
                type="EARNING",
                amount_cents=revenue * 100,
                description=f"Ganancia sesión #{session.id} — {session.charger_id}",
            ))
            added += 1
        await db.commit()
        if added:
            logger.info(f"Backfill ledger: {added} sesiones cobradas abonadas")


async def _notify_unpaid(db: AsyncSession, pc: PendingCharge):
    session = await db.get(Session, pc.session_id)
    if session:
        charger = await db.get(Charger, session.charger_id)
        if charger:
            _notify_owner(
                db, charger.owner_id, "PAYMENT_UNPAID",
                f"{charger.id}: el cobro de la sesión #{pc.session_id} fue rechazado por el banco — el conductor quedó bloqueado hasta regularizar",
                charger.id,
            )


async def _execute_charge(db: AsyncSession, pc: PendingCharge):
    """Ejecuta (o confirma) un cobro pendiente. Reintenta con backoff exponencial."""
    pay_tx = await db.get(PaymentTransaction, pc.payment_tx_id) if pc.payment_tx_id else None
    if not pay_tx:
        pc.status = "REVIEW"
        pc.last_error = "PaymentTransaction no encontrada"
        return

    def _backoff(err: str):
        pc.attempts += 1
        pc.last_error = err[:300]
        delay = min(30 * (2 ** pc.attempts), 900)
        pc.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
        if pc.attempts >= CHARGE_MAX_ATTEMPTS:
            pc.status = "REVIEW"
            logger.error(f"Cobro sesión #{pc.session_id} agotó reintentos — requiere revisión manual: {err[:120]}")
        else:
            logger.warning(f"Cobro sesión #{pc.session_id} falló (intento {pc.attempts}) — reintento en {delay}s")

    # 1) Ya existe una transacción en Wompi — solo confirmar su estado final
    if pc.wompi_tx_id:
        try:
            resp = await wompi_svc.get_transaction(pc.wompi_tx_id)
        except Exception as e:
            _backoff(str(e))
            return
        status = resp.get("data", {}).get("status", "")
        if status == "APPROVED":
            await _settle_captured(db, pc, pay_tx)
        elif status in ("DECLINED", "ERROR", "VOIDED"):
            pc.status = "UNPAID"
            pay_tx.status = "UNPAID"
            await _notify_unpaid(db, pc)
            logger.warning(f"Cobro sesión #{pc.session_id} declinado por Wompi → UNPAID (tx#{pc.wompi_tx_id})")
        else:
            _backoff(f"tx aún {status or 'sin estado'}")
        return

    # 2) Sesión sin consumo — nada que cobrar, liberar
    if pc.amount_cents <= 0:
        pc.status = "DONE"
        pay_tx.status = "VOID"
        return

    # 3) Crear la transacción de cobro (sobre la pre-auth si existe, si no sobre la tarjeta)
    source_id = pay_tx.wompi_preauth_id or pay_tx.wompi_payment_source_id
    if not source_id:
        pc.status = "REVIEW"
        pay_tx.status = "UNPAID"
        pc.last_error = "Sin payment_source para cobrar"
        return

    charge_cents = max(WOMPI_MIN_CENTS, pc.amount_cents)  # mínimo $1.500 COP por límite de Wompi
    user = await db.get(User, pay_tx.user_id)
    try:
        resp = await wompi_svc.capture_preauth(source_id, charge_cents, user.email if user else "", pay_tx.reference)
    except Exception as e:
        _backoff(str(e))
        return

    data = resp.get("data", {})
    err  = resp.get("error")
    if err and "reference" in str(err).lower():
        # Referencia ya usada: un intento anterior sí llegó a Wompi — recuperarlo
        existing_tx = await wompi_svc.get_transaction_by_reference(pay_tx.reference)
        if existing_tx:
            data, err = existing_tx, None
    if err or not data.get("id"):
        # Si la captura contra la pre-auth falla repetidamente (p.ej. el cobro
        # supera la garantía retenida), caer a cobrar con la tarjeta guardada
        if (pc.attempts >= 2 and pay_tx.wompi_preauth_id
                and pay_tx.wompi_payment_source_id
                and pay_tx.wompi_payment_source_id != pay_tx.wompi_preauth_id):
            logger.warning(
                f"Cobro sesión #{pc.session_id}: captura sobre pre-auth #{pay_tx.wompi_preauth_id} "
                f"falló {pc.attempts} veces — cayendo a la tarjeta guardada (ps#{pay_tx.wompi_payment_source_id})"
            )
            pay_tx.wompi_preauth_id = None
        _backoff(str(err or resp))
        return

    pay_tx.wompi_id     = data["id"]
    pay_tx.amount_cents = charge_cents
    status = data.get("status", "")
    if status == "APPROVED":
        await _settle_captured(db, pc, pay_tx)
    elif status == "PENDING":
        pc.wompi_tx_id = data["id"]
        pc.status = "WAITING_CONFIRM"
        pc.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=10)
        logger.info(f"Cobro sesión #{pc.session_id} PENDING en Wompi — confirmando en 10s (tx#{data['id']})")
    else:
        pc.status = "UNPAID"
        pay_tx.status = "UNPAID"
        await _notify_unpaid(db, pc)
        logger.warning(f"Cobro sesión #{pc.session_id} {status or 'rechazado'} → UNPAID")


async def _close_orphan_sessions():
    """Cierra sesiones de cargadores que llevan demasiado tiempo sin conexión,
    usando el último consumo medido (current_kwh se persiste en cada MeterValue)."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Charger).where(Charger.active_transaction.isnot(None)))
        now = datetime.now(timezone.utc)
        for charger in result.scalars().all():
            if charger.id in connected_chargers:
                continue
            if charger.last_seen and (now - charger.last_seen).total_seconds() < OFFLINE_SESSION_TIMEOUT:
                continue
            logger.warning(
                f"[{charger.id}] Sesión huérfana ({OFFLINE_SESSION_TIMEOUT}s offline) — "
                f"cerrando con último consumo medido: {charger.current_kwh or 0} kWh"
            )
            await _finalize_session(db, charger, charger.current_kwh or 0.0, final_status="Offline")
        await db.commit()


OFFLINE_ALERT_MIN = 30  # minutos offline antes de alertar al dueño

async def _offline_watcher():
    """Alerta al dueño cuando su cargador lleva demasiado tiempo sin conexión.
    Dedupe: una sola alerta por caída (no se repite hasta que el equipo vuelva)."""
    while True:
        await asyncio.sleep(60)
        try:
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(Charger).where(Charger.status == "Offline", Charger.owner_id.isnot(None))
                )
                now = datetime.now(timezone.utc)
                for c in result.scalars().all():
                    if not c.last_seen or (now - c.last_seen).total_seconds() < OFFLINE_ALERT_MIN * 60:
                        continue
                    already = await db.execute(
                        select(OwnerEvent).where(
                            OwnerEvent.charger_id == c.id,
                            OwnerEvent.type == "CHARGER_OFFLINE",
                            OwnerEvent.created_at >= c.last_seen,
                        ).limit(1)
                    )
                    if already.scalars().first():
                        continue
                    _notify_owner(
                        db, c.owner_id, "CHARGER_OFFLINE",
                        f"{c.id} lleva más de {OFFLINE_ALERT_MIN} min sin conexión — revisa el equipo o su internet",
                        c.id,
                    )
                await db.commit()
        except Exception as e:
            logger.warning(f"offline_watcher: {e}")


async def _charge_worker():
    """Procesa el outbox de cobros y el cierre de sesiones huérfanas."""
    logger.info("Worker de cobros iniciado")
    while True:
        await asyncio.sleep(5)
        try:
            async with AsyncSessionLocal() as db:
                due = await db.execute(
                    select(PendingCharge)
                    .where(
                        PendingCharge.status.in_(["PENDING", "WAITING_CONFIRM"]),
                        PendingCharge.next_attempt_at <= datetime.now(timezone.utc),
                    )
                    .order_by(PendingCharge.created_at)
                    .limit(10)
                )
                for pc in due.scalars().all():
                    await _execute_charge(db, pc)
                await db.commit()
        except Exception as e:
            logger.warning(f"charge_worker: {e}")
        try:
            await _close_orphan_sessions()
        except Exception as e:
            logger.warning(f"janitor sesiones huérfanas: {e}")


async def _mark_offline_after_grace(charge_point_id: str, grace: int = 10):
    await asyncio.sleep(grace)
    if charge_point_id not in connected_chargers:
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, charge_point_id)
            if charger:
                charger.status = "Offline"
                await db.commit()
                logger.info(f"[{charge_point_id}] Marcado Offline tras {grace}s sin reconexión")


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
        asyncio.create_task(_mark_offline_after_grace(charge_point_id))


# ── STATUS ────────────────────────────────────────────────────────────────────

@app.get("/status")
async def get_status(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Charger).options(selectinload(Charger.owner)))
    chargers = result.scalars().all()
    return {
        "connected": list(connected_chargers.keys()),
        "total": len(chargers),
        "chargers": {c.id: c.to_dict() for c in chargers},
    }


@app.get("/status/{charge_point_id}")
async def get_charger(charge_point_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Charger).where(Charger.id == charge_point_id).options(selectinload(Charger.owner))
    )
    charger = result.scalar_one_or_none()
    if not charger:
        return {"error": "No encontrado"}
    return charger.to_dict()


# ── AUTH ──────────────────────────────────────────────────────────────────────

class RegisterBody(BaseModel):
    email: str
    name: str
    password: str
    role: str  # "conductor" | "owner"


class LoginBody(BaseModel):
    email: str
    password: str


# Rate limit de login en memoria (suficiente para un solo worker):
# 5 intentos fallidos por IP+email en 5 minutos → 429
import time as _time
from collections import defaultdict as _dd, deque as _deque

LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_S     = 300
_login_attempts: dict[str, _deque] = _dd(_deque)


def _login_rate_key(request: Request, email: str) -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}|{email.lower().strip()}"


def _check_login_rate(key: str):
    now = _time.monotonic()
    dq = _login_attempts[key]
    while dq and now - dq[0] > LOGIN_WINDOW_S:
        dq.popleft()
    if len(dq) >= LOGIN_MAX_ATTEMPTS:
        raise HTTPException(429, "Demasiados intentos fallidos. Espera 5 minutos e intenta de nuevo.")


@app.post("/auth/register")
async def register(body: RegisterBody, db: AsyncSession = Depends(get_db)):
    if body.role not in ("conductor", "owner"):
        raise HTTPException(400, "role debe ser 'conductor' o 'owner'")
    if len(body.password) < 6:
        raise HTTPException(400, "La contraseña debe tener al menos 6 caracteres")
    if "@" not in body.email or "." not in body.email.split("@")[-1]:
        raise HTTPException(400, "Email inválido")
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise HTTPException(400, "Email ya registrado")
    user = User(email=body.email.lower().strip(), name=body.name, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    await db.commit()
    return {"token": create_token(user.id, user.role), "user": _user_dict(user)}


@app.post("/auth/login")
async def login(body: LoginBody, request: Request, db: AsyncSession = Depends(get_db)):
    key = _login_rate_key(request, body.email)
    _check_login_rate(key)
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        _login_attempts[key].append(_time.monotonic())
        raise HTTPException(401, "Credenciales incorrectas")
    _login_attempts.pop(key, None)   # login exitoso limpia el contador
    return {"token": create_token(user.id, user.role), "user": _user_dict(user)}


@app.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)):
    return _user_dict(current_user)


def _user_dict(user: User) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}


# ── REMOTE CONTROL ────────────────────────────────────────────────────────────

@app.post("/remote-start/{charge_point_id}")
async def remote_start(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
):
    charger = connected_chargers.get(charge_point_id)
    if not charger:
        return {"error": "Cargador no conectado"}
    response = await charger.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.email))
    return {"status": response.status}


@app.post("/remote-stop/{charge_point_id}")
async def remote_stop(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger_conn = connected_chargers.get(charge_point_id)
    if not charger_conn:
        # Cargador sin conexión: cerrar la sesión con el último consumo medido
        # y encolar el cobro — el conductor paga solo lo que se alcanzó a medir
        charger = await db.get(Charger, charge_point_id)
        if charger and charger.active_transaction:
            await _finalize_session(db, charger, charger.current_kwh or 0.0, final_status="Offline")
            await db.commit()
        return {"error": "Cargador sin conexión — sesión cerrada con el último consumo medido", "manual": True}
    charger = await db.get(Charger, charge_point_id)
    if not charger or not charger.active_transaction:
        return {"error": "Sin sesión activa"}
    response = await charger_conn.call(call.RemoteStopTransactionPayload(transaction_id=charger.active_transaction))
    return {"status": response.status}


# ── MIS CARGADORES (dueños) ───────────────────────────────────────────────────

@app.get("/my-chargers")
async def my_chargers(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños de cargadores")
    result = await db.execute(
        select(Charger).where(Charger.owner_id == current_user.id).options(selectinload(Charger.owner))
    )
    chargers = result.scalars().all()
    return {"chargers": [c.to_dict() for c in chargers]}


# ── GESTIÓN DE CARGADORES (dueño) ────────────────────────────────────────────

import re as _re_charger

# Alfabeto sin caracteres confundibles (sin 0/O, 1/I/L) — el dueño lo teclea
# en el panel de su cargador, debe ser imposible equivocarse
_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

async def _generate_charger_id(db: AsyncSession) -> str:
    for _ in range(20):
        cid = "FARO-" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(4))
        if not await db.get(Charger, cid):
            return cid
    raise HTTPException(500, "No se pudo generar un ID único — reintenta")


class AddChargerBody(BaseModel):
    location: str
    lat: float
    lng: float
    power_kw: float
    connector_type: str              # "Type 2" | "CCS2" | "CHAdeMO" | "Schuko"
    price_per_kwh: float
    cost_per_kwh: float = 0.0
    brand_profile_id: str | None = None   # marca elegida por el dueño (opcional)
    id: str | None = None                 # legacy: si no llega, el sistema lo genera

@app.post("/chargers")
async def add_charger(
    body: AddChargerBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")

    if body.id:
        if not _re_charger.match(r'^[A-Za-z0-9_\-]{3,30}$', body.id):
            raise HTTPException(400, "ID inválido. Usa letras, números, guiones (3-30 caracteres).")
        if await db.get(Charger, body.id):
            raise HTTPException(409, f"Ya existe un cargador con ID '{body.id}'")
        charger_id = body.id
    else:
        charger_id = await _generate_charger_id(db)

    if body.brand_profile_id and not await db.get(ChargerBrandProfile, body.brand_profile_id):
        raise HTTPException(400, "Marca no encontrada en el catálogo")

    charger = Charger(
        id=charger_id, owner_id=current_user.id,
        location=body.location, lat=body.lat, lng=body.lng,
        power_kw=body.power_kw, connector_type=body.connector_type,
        price_per_kwh=body.price_per_kwh, cost_per_kwh=body.cost_per_kwh,
        brand_profile_id=body.brand_profile_id,
        status="Offline",
    )
    db.add(charger)
    await db.commit()
    logger.info(f"Cargador {charger_id} registrado por {current_user.email}")

    # Auto-arrancar simulador para el nuevo cargador
    async def _start_sim():
        await asyncio.sleep(1)
        sim_mgr.start(charger_id, body.power_kw)
    asyncio.create_task(_start_sim())

    return {**charger.to_dict(), "ocpp_url": ocpp_url(charger_id)}


@app.get("/brand-profiles")
async def list_brand_profiles(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ChargerBrandProfile).order_by(ChargerBrandProfile.display_name))
    return {"profiles": [p.to_dict() for p in result.scalars().all()]}


@app.get("/chargers/{charge_point_id}/setup")
async def charger_setup(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Guía de vinculación del cargador: URL OCPP, ID, y los pasos según su marca."""
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")

    profile = None
    if charger.brand_profile_id:
        profile = await db.get(ChargerBrandProfile, charger.brand_profile_id)
    if not profile:
        profile = await db.get(ChargerBrandProfile, "generic-ocpp16")

    return {
        "charger_id": charger.id,
        "ocpp_url": ocpp_url(charger.id),
        "connected": charger.id in connected_chargers,
        "status": charger.status,
        "last_seen": charger.last_seen.isoformat() if charger.last_seen else None,
        "detected_vendor": charger.vendor,
        "detected_model": charger.model,
        "brand_profile": profile.to_dict() if profile else None,
    }

@app.delete("/chargers/{charge_point_id}")
async def delete_charger(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if charger.active_transaction:
        raise HTTPException(400, "Hay una sesión activa — detén la carga primero")
    # Detener simulador si está corriendo
    sim_mgr.stop(charge_point_id)
    # Limpiar conexión OCPP activa
    connected_chargers.pop(charge_point_id, None)
    await db.delete(charger)
    await db.commit()
    logger.info(f"Cargador {charge_point_id} eliminado por {current_user.email}")
    return {"ok": True}

class PauseBody(BaseModel):
    pause: bool   # True = pausar, False = reanudar

@app.patch("/chargers/{charge_point_id}/availability")
async def set_availability(
    charge_point_id: str,
    body: PauseBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if charger.active_transaction and body.pause:
        raise HTTPException(400, "Hay una sesión activa, detén la carga primero")

    availability = AvailabilityType.inoperative if body.pause else AvailabilityType.operative
    ocpp_status  = "Unavailable" if body.pause else "Available"

    charger_conn = connected_chargers.get(charge_point_id)
    if charger_conn:
        try:
            resp = await charger_conn.call(call.ChangeAvailabilityPayload(
                connector_id=0, type=availability,
            ))
            logger.info(f"ChangeAvailability {charge_point_id} → {availability}: {resp.status}")
        except Exception as e:
            logger.warning(f"ChangeAvailability falló: {e} — actualizando DB de todas formas")

    charger.status = ocpp_status
    await db.commit()
    return {"ok": True, "status": ocpp_status}


# ── SIMULADORES (gestión desde la app) ───────────────────────────────────────

@app.get("/simulators")
async def list_simulators(current_user: User = Depends(get_current_user)):
    return {"running": sim_mgr.list_running()}

@app.post("/simulators/{charge_point_id}")
async def start_simulator(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if sim_mgr.is_running(charge_point_id):
        return {"ok": True, "message": "Ya estaba corriendo"}
    sim_mgr.start(charge_point_id, charger.power_kw or 22.0)
    logger.info(f"Simulador iniciado para {charge_point_id} por {current_user.email}")
    return {"ok": True, "message": f"Simulador de {charge_point_id} iniciado"}

@app.delete("/simulators/{charge_point_id}")
async def stop_simulator(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
):
    stopped = sim_mgr.stop(charge_point_id)
    logger.info(f"Simulador {charge_point_id} detenido por {current_user.email}")
    return {"ok": True, "stopped": stopped}


class PriceBody(BaseModel):
    price_per_kwh: float

class CostBody(BaseModel):
    cost_per_kwh: float


@app.patch("/chargers/{charge_point_id}/price")
async def update_price(
    charge_point_id: str,
    body: PriceBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if body.price_per_kwh <= 0:
        raise HTTPException(400, "El precio debe ser mayor a 0")
    charger.price_per_kwh = body.price_per_kwh
    await db.commit()
    final = price_to_conductor(body.price_per_kwh)
    return {
        "price_per_kwh": body.price_per_kwh,
        "price_to_user": round(final),
        "breakdown": {
            "base": body.price_per_kwh,
            "comision_cpo": round(body.price_per_kwh * PLATFORM_MARGIN),
            "iva": round(body.price_per_kwh * (1 + PLATFORM_MARGIN) * IVA_RATE),
            "pasarela": round(body.price_per_kwh * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * GATEWAY_FEE),
            "total": round(final),
        }
    }


class PeakPriceBody(BaseModel):
    peak_price_per_kwh: float | None = None   # None = quitar tarifa pico (tarifa única)


@app.patch("/chargers/{charge_point_id}/peak-price")
async def update_peak_price(
    charge_point_id: str,
    body: PeakPriceBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if body.peak_price_per_kwh is not None and body.peak_price_per_kwh <= 0:
        raise HTTPException(400, "El precio pico debe ser mayor a 0 (o null para quitarlo)")
    charger.peak_price_per_kwh = body.peak_price_per_kwh
    await db.commit()
    return {
        "price_per_kwh": charger.price_per_kwh,
        "peak_price_per_kwh": charger.peak_price_per_kwh,
        "peak_window": "18:00–22:00 (hora Colombia)",
    }


@app.patch("/chargers/{charge_point_id}/cost")
async def update_cost(
    charge_point_id: str,
    body: CostBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    charger.cost_per_kwh = body.cost_per_kwh
    await db.commit()
    margin_cop = round((charger.price_per_kwh or 0) - body.cost_per_kwh)
    return {"cost_per_kwh": body.cost_per_kwh, "margin_cop_per_kwh": margin_cop}


# ── RESERVAS ─────────────────────────────────────────────────────────────────

class ReserveBody(BaseModel):
    minutes: int = 60  # duración de la reserva en minutos


@app.post("/reserve/{charge_point_id}")
async def reserve_charger(
    charge_point_id: str,
    body: ReserveBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger_conn = connected_chargers.get(charge_point_id)
    if not charger_conn:
        raise HTTPException(400, "Cargador no conectado")
    charger = await db.get(Charger, charge_point_id)
    if not charger or charger.status not in ("Available",):
        raise HTTPException(400, "Cargador no disponible para reserva")

    from datetime import timedelta
    now = datetime.now(timezone.utc)
    end = now + timedelta(minutes=body.minutes)
    reservation_id = int(now.timestamp()) % 100000

    response = await charger_conn.call(call.ReserveNowPayload(
        connector_id=1,
        expiry_date=end.isoformat(),
        id_tag=current_user.email,
        reservation_id=reservation_id,
    ))
    if response.status != "Accepted":
        raise HTTPException(400, f"Cargador rechazó la reserva: {response.status}")

    reservation = Reservation(
        charger_id=charge_point_id,
        user_id=current_user.id,
        ocpp_reservation_id=reservation_id,
        start_time=now,
        end_time=end,
    )
    db.add(reservation)
    await db.commit()
    return reservation.to_dict()


@app.delete("/reserve/{reservation_id}")
async def cancel_reservation(
    reservation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .options(selectinload(Reservation.charger), selectinload(Reservation.user))
    )
    reservation = result.scalar_one_or_none()
    if not reservation or reservation.user_id != current_user.id:
        raise HTTPException(404, "Reserva no encontrada")

    charger_conn = connected_chargers.get(reservation.charger_id)
    if charger_conn:
        await charger_conn.call(call.CancelReservationPayload(reservation_id=reservation.ocpp_reservation_id))

    reservation.status = "cancelled"
    await db.commit()
    return {"ok": True}


@app.get("/my-reservations")
async def my_reservations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Reservation)
        .where(Reservation.user_id == current_user.id, Reservation.status == "active")
        .options(selectinload(Reservation.charger), selectinload(Reservation.user))
        .order_by(Reservation.start_time.desc())
    )
    return {"reservations": [r.to_dict() for r in result.scalars().all()]}


@app.get("/my-chargers/reservations")
async def charger_reservations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    result = await db.execute(
        select(Reservation)
        .join(Charger)
        .where(Charger.owner_id == current_user.id, Reservation.status == "active")
        .options(selectinload(Reservation.charger), selectinload(Reservation.user))
        .order_by(Reservation.start_time)
    )
    return {"reservations": [r.to_dict() for r in result.scalars().all()]}


@app.get("/my-sessions")
async def my_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Session)
        .where(Session.session_user == current_user.email)
        .options(selectinload(Session.charger))
        .order_by(Session.ended_at.desc())
        .limit(50)
    )
    sessions = result.scalars().all()
    total_kwh  = sum(s.kwh_delivered for s in sessions)
    total_paid = sum(s.total_charged for s in sessions)
    # Pagos de estas sesiones
    session_ids = [s.id for s in sessions]
    payments_r = await db.execute(
        select(PaymentTransaction)
        .where(PaymentTransaction.user_id == current_user.id)
    )
    all_payments = payments_r.scalars().all()

    # Mapear session_id → payment_status
    pay_by_session: dict[int, str] = {}
    for p in all_payments:
        if p.session_id and p.session_id in session_ids:
            pay_by_session[p.session_id] = p.status

    unpaid_count = sum(1 for p in all_payments if p.status == "UNPAID")

    def session_dict(s):
        d = s.to_dict()
        d["payment_status"] = pay_by_session.get(s.id, "unknown")
        return d

    return {
        "total_sessions": len(sessions),
        "total_kwh": round(total_kwh, 3),
        "total_paid_cop": round(total_paid),
        "unpaid_count": unpaid_count,
        "sessions": [session_dict(s) for s in sessions],
    }


# ── MÉTODOS DE PAGO (conductor) ───────────────────────────────────────────────

class AddCardBody(BaseModel):
    # PCI: el número de tarjeta NUNCA pasa por este servidor.
    # La app tokeniza directo contra Wompi con la llave pública y manda solo el token.
    token: str                      # tok_... de Wompi
    brand: str | None = None        # VISA | MASTERCARD (del response de tokenización)
    last4: str | None = None
    nickname: str | None = None

class AddNequiBody(BaseModel):
    phone: str
    holder_name: str
    nickname: str | None = None

class NicknameBody(BaseModel):
    nickname: str

@app.get("/payment-methods")
async def list_payment_methods(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id).order_by(PaymentMethod.created_at))
    return {"methods": [m.to_dict() for m in result.scalars().all()]}

@app.get("/config/public")
async def public_config():
    """Config para el cliente: la llave pública de Wompi es pública por diseño —
    la app la usa para tokenizar la tarjeta directo contra Wompi (PCI)."""
    return {
        "wompi_api": wompi_svc.BASE_URL,
        "wompi_public_key": os.getenv("WOMPI_PUBLIC_KEY", ""),
    }


@app.post("/payment-methods/card")
async def add_card(body: AddCardBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not body.token.startswith("tok_"):
        raise HTTPException(400, "Token de tarjeta inválido")

    # Anti-duplicado: misma marca + últimos 4 dígitos ya guardados
    # (también protege contra doble-tap en el botón de guardar)
    if body.brand and body.last4:
        dup_display = f"{body.brand.upper()} •••• {body.last4}"
        dup = await db.execute(
            select(PaymentMethod)
            .where(PaymentMethod.user_id == current_user.id, PaymentMethod.display == dup_display)
            .limit(1)
        )
        if dup.scalars().first():
            raise HTTPException(409, "Ya tienes guardada esta tarjeta. Si es otra distinta con los mismos últimos dígitos, elimina la anterior primero.")

    # Convertir el token de un solo uso en payment_source persistente
    ps_resp = await wompi_svc.save_card_as_payment_source(body.token, current_user.email)
    ps_data = ps_resp.get("data", {})
    ps_id   = ps_data.get("id")
    if not ps_id:
        reason = ps_resp.get("error", {}).get("reason", "Wompi rechazó la tarjeta")
        raise HTTPException(400, f"No se pudo guardar la tarjeta: {reason}")
    logger.info(f"Tarjeta guardada como payment_source #{ps_id} para {current_user.email}")

    brand = (body.brand or ps_data.get("public_data", {}).get("brand") or "CARD").upper()
    last4 = body.last4 if body.last4 and body.last4.isdigit() and len(body.last4) == 4 \
        else ps_data.get("public_data", {}).get("last_four", "????")

    existing = await db.execute(select(PaymentMethod.id).where(PaymentMethod.user_id == current_user.id).limit(1))
    is_first  = existing.scalars().first() is None
    method = PaymentMethod(
        user_id=current_user.id,
        type="CARD",
        wompi_token=None,
        wompi_payment_source_id=ps_id,
        display=f"{brand} •••• {last4}",
        brand=brand,
        nickname=body.nickname.strip() if body.nickname and body.nickname.strip() else None,
        is_default=is_first,
    )
    db.add(method)
    await db.commit()
    return method.to_dict()

@app.post("/payment-methods/nequi")
async def add_nequi(body: AddNequiBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    dup = await db.execute(
        select(PaymentMethod)
        .where(PaymentMethod.user_id == current_user.id, PaymentMethod.wompi_token == body.phone, PaymentMethod.type == "NEQUI")
        .limit(1)
    )
    if dup.scalars().first():
        raise HTTPException(409, "Ya tienes guardado ese número de Nequi.")
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id).limit(1))
    is_first = result.scalars().first() is None
    method = PaymentMethod(
        user_id=current_user.id,
        type="NEQUI",
        display=f"Nequi {body.phone}",
        wompi_token=body.phone,
        nickname=body.nickname.strip() if body.nickname and body.nickname.strip() else None,
        is_default=is_first,
    )
    db.add(method)
    await db.commit()
    return method.to_dict()

@app.patch("/payment-methods/{method_id}/nickname")
async def rename_payment_method(method_id: str, body: NicknameBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    method = await db.get(PaymentMethod, method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método no encontrado")
    method.nickname = body.nickname.strip() or None
    await db.commit()
    return method.to_dict()

@app.delete("/payment-methods/{method_id}")
async def delete_payment_method(method_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    method = await db.get(PaymentMethod, method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método no encontrado")
    await db.delete(method)
    await db.commit()
    return {"ok": True}

@app.patch("/payment-methods/{method_id}/default")
async def set_default_method(method_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id))
    for m in result.scalars().all():
        m.is_default = (m.id == method_id)
    await db.commit()
    return {"ok": True}


# ── CUENTA DE DISPERSIÓN (dueño) ──────────────────────────────────────────────

import re as _re

BANKS = {
    "1007": "Bancolombia", "1040": "BBVA Colombia", "1052": "AV Villas",
    "1006": "Banco de Bogotá", "1009": "Citibank", "1062": "Falabella",
    "1019": "Scotiabank Colpatria", "1023": "Banco de Occidente",
    "1032": "Banco Caja Social", "1051": "Davivienda", "1059": "Bancamía",
}

class DisbursementAccountBody(BaseModel):
    type: str           # NEQUI | BANK
    phone: str | None = None
    account_number: str | None = None
    bank_code: str | None = None
    account_type: str | None = None  # SAVINGS | CHECKING
    holder_name: str
    holder_id: str

def _validate_disb(body: DisbursementAccountBody):
    if body.type == "NEQUI":
        if not body.phone or not _re.match(r'^3\d{9}$', body.phone):
            raise HTTPException(400, "El número Nequi debe ser de 10 dígitos y empezar por 3 (ej: 3001234567)")
    elif body.type == "BANK":
        if not body.account_number or len(body.account_number) < 6:
            raise HTTPException(400, "El número de cuenta debe tener al menos 6 dígitos")
        if not body.bank_code or body.bank_code not in BANKS:
            raise HTTPException(400, f"Código de banco inválido. Bancos disponibles: {', '.join(f'{k}={v}' for k,v in BANKS.items())}")
        if body.account_type not in ("SAVINGS", "CHECKING"):
            raise HTTPException(400, "Tipo de cuenta debe ser SAVINGS o CHECKING")
    if not body.holder_name.strip():
        raise HTTPException(400, "El nombre del titular es obligatorio")
    if not _re.match(r'^\d{6,12}$', body.holder_id):
        raise HTTPException(400, "La cédula debe ser solo números (6-12 dígitos)")

@app.post("/disbursement-account")
async def set_disbursement_account(body: DisbursementAccountBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    _validate_disb(body)
    result = await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == current_user.id))
    existing = result.scalar_one_or_none()
    if existing:
        existing.type = body.type; existing.phone = body.phone
        existing.account_number = body.account_number; existing.bank_code = body.bank_code
        existing.account_type = body.account_type; existing.holder_name = body.holder_name
        existing.holder_id = body.holder_id
        existing.verified = False  # resetear verificación al cambiar cuenta
        existing.verified_at = None
        acc = existing
    else:
        acc = DisbursementAccount(user_id=current_user.id, **body.model_dump(), verified=False)
        db.add(acc)
    await db.commit()
    return acc.to_dict()

@app.get("/disbursement-account")
async def get_disbursement_account(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == current_user.id))
    acc = result.scalar_one_or_none()
    return acc.to_dict() if acc else None

@app.post("/disbursement-account/verify")
async def verify_disbursement_account(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Envía $500 COP de prueba a la cuenta del dueño. Si llega → cuenta verificada."""
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    result = await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == current_user.id))
    acc = result.scalar_one_or_none()
    if not acc:
        raise HTTPException(404, "No tienes cuenta registrada")
    if acc.verified:
        return {**acc.to_dict(), "message": "La cuenta ya estaba verificada"}

    ref = f"verify-{current_user.id[:8]}-{int(datetime.now().timestamp())}"
    amount_cents = 50_000  # $500 COP de prueba

    try:
        if acc.type == "NEQUI":
            resp = await wompi_svc.disburse_nequi(ref, amount_cents, acc.phone, "Verificación de cuenta CPO")
        else:
            resp = await wompi_svc.disburse_bank(
                ref, amount_cents, acc.account_number, acc.bank_code,
                acc.account_type or "SAVINGS", acc.holder_name, acc.holder_id,
                "Verificación de cuenta CPO",
            )
    except Exception as e:
        raise HTTPException(502, f"Error conectando con Wompi: {e}")

    disb_data = resp.get("data", {})
    wompi_error = resp.get("error")
    if wompi_error or not disb_data.get("id"):
        reason = wompi_error.get("reason", str(wompi_error)) if isinstance(wompi_error, dict) else str(wompi_error or "sin respuesta")
        raise HTTPException(400, f"Wompi rechazó la cuenta: {reason}")

    acc.verified = True
    acc.verified_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info(f"Cuenta verificada para {current_user.email}: {acc.type} — dispersión #{disb_data['id']}")
    return {**acc.to_dict(), "message": "¡Cuenta verificada! Se enviaron $500 COP de prueba."}


# ── PAGOS — cobro al conductor ─────────────────────────────────────────────────

def calc_preauth_cop(charger: Charger) -> int:
    """Pre-auth basado en potencia del cargador (cubre 15 min + 20% buffer, mínimo $3.000 COP)."""
    power_kw   = charger.power_kw or 22.0
    price_user = (charger.price_at() or 1000) * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * (1 + GATEWAY_FEE)
    max_kwh    = power_kw * 0.25           # 15 minutos
    estimated  = max_kwh * price_user * 1.2
    rounded    = max(3_000, int(estimated / 1000 + 1) * 1000)  # mínimo $3.000, múltiplos de $1.000
    return rounded


class InitiatePaymentBody(BaseModel):
    charger_id: str
    payment_method_id: str


@app.post("/payments/initiate")
async def initiate_payment(
    body: InitiatePaymentBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    method = await db.get(PaymentMethod, body.payment_method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método de pago no encontrado")

    charger = await db.get(Charger, body.charger_id)
    if not charger or charger.status != "Available":
        raise HTTPException(400, "Cargador no disponible")

    if not method.wompi_payment_source_id:
        raise HTTPException(400, "Esta tarjeta no tiene un payment_source válido. Elimínala y vuélvela a agregar.")

    # Bloquear si tiene pagos fallidos pendientes
    unpaid = await db.execute(
        select(PaymentTransaction)
        .where(PaymentTransaction.user_id == current_user.id, PaymentTransaction.status == "UNPAID")
        .limit(1)
    )
    if unpaid.scalars().first():
        raise HTTPException(402, "Tienes un cobro pendiente de una sesión anterior. Contacta soporte para regularizarlo antes de cargar de nuevo.")

    reference     = f"cpo-{current_user.id[:8]}-{body.charger_id}-{int(datetime.now().timestamp())}"
    guarantee_cop = calc_preauth_cop(charger)

    # Pre-autorización real: retiene la garantía ANTES de arrancar la carga.
    # Si el banco rechaza, el cargador nunca arranca — imposible quedar UNPAID
    # por fondos insuficientes. El cobro exacto se captura al terminar.
    preauth_id = None
    pstatus    = ""
    try:
        resp  = await wompi_svc.preauthorize_card(guarantee_cop * 100, current_user.email, method.wompi_payment_source_id)
        pdata = resp.get("data", {})
        preauth_id, pstatus = pdata.get("id"), (pdata.get("status") or "")
        # Espera corta a que la retención quede disponible (sandbox: 1-2s)
        waited = 0
        while preauth_id and pstatus == "PROCESSING" and waited < 6:
            await asyncio.sleep(1)
            waited += 1
            pdata   = (await wompi_svc.get_payment_source(preauth_id)).get("data", {})
            pstatus = pdata.get("status") or ""
    except Exception as e:
        logger.warning(f"Pre-auth no disponible ({e}) — autorizando sin retención")

    if pstatus in ("DECLINED", "ERROR", "VOIDED"):
        raise HTTPException(402, "Tu banco rechazó la retención de garantía. Verifica fondos o usa otra tarjeta.")
    if preauth_id is None:
        # Feature de pre-auth no activa en esta cuenta Wompi — flujo degradado:
        # se autoriza con la tarjeta guardada y el cobro único ocurre al final.
        logger.warning(f"Pre-auth no activa en Wompi — {reference} autorizado sin retención de garantía")

    status = "APPROVED" if (preauth_id is None or pstatus == "AVAILABLE") else "PENDING"
    payment = PaymentTransaction(
        charger_id=body.charger_id,
        user_id=current_user.id,
        reference=reference,
        wompi_payment_source_id=method.wompi_payment_source_id,
        wompi_preauth_id=preauth_id,
        wompi_id=None,
        amount_cents=0,      # se actualiza al capturar el cobro real
        status=status,
        payment_type="CARD",
    )
    db.add(payment)
    await db.commit()

    if status == "APPROVED":
        charger_conn = connected_chargers.get(body.charger_id)
        if charger_conn:
            await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.email))
        logger.info(
            f"Sesión autorizada para {current_user.email} en {body.charger_id} — "
            + (f"garantía ${guarantee_cop:,} COP retenida (preauth#{preauth_id})" if preauth_id else f"sin retención, ps#{method.wompi_payment_source_id}")
        )
    else:
        logger.info(f"Pre-auth {reference} en PROCESSING — la app hará polling hasta confirmar")

    return {
        "reference":     reference,
        "status":        status,
        "payment_id":    payment.id,
        "guarantee_cop": guarantee_cop if preauth_id else 0,
    }


@app.get("/payments/status/{reference}")
async def payment_status(reference: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentTransaction).where(PaymentTransaction.reference == reference))
    payment = result.scalar_one_or_none()
    if not payment or payment.user_id != current_user.id:
        raise HTTPException(404, "Pago no encontrado")

    # Pre-auth aún en PROCESSING: consultar Wompi y, al confirmarse la
    # retención, arrancar la carga (la app hace polling de este endpoint)
    if payment.status == "PENDING" and payment.wompi_preauth_id:
        try:
            resp = await wompi_svc.get_payment_source(payment.wompi_preauth_id)
            ps_status = resp.get("data", {}).get("status", "")
        except Exception as e:
            logger.warning(f"payment_status: error consultando pre-auth: {e}")
            ps_status = ""
        if ps_status == "AVAILABLE":
            payment.status = "APPROVED"
            await db.commit()
            charger_conn = connected_chargers.get(payment.charger_id)
            if charger_conn:
                await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.email))
            logger.info(f"Pre-auth confirmada — sesión iniciada en {payment.charger_id} para {current_user.email}")
        elif ps_status in ("DECLINED", "ERROR", "VOIDED"):
            payment.status = "DECLINED"
            await db.commit()
            logger.warning(f"Pre-auth {reference} declinada por el banco")

    return {"reference": reference, "status": payment.status, "payment_id": payment.id}


# ── WEBHOOK DE WOMPI ──────────────────────────────────────────────────────────

@app.post("/webhooks/wompi")
async def wompi_webhook(payload: dict, db: AsyncSession = Depends(get_db)):
    if not wompi_svc.verify_webhook_signature(payload):
        raise HTTPException(401, "Firma inválida")

    event = payload.get("event")
    if event != "transaction.updated":
        return {"ok": True}

    tx = payload.get("data", {}).get("transaction", {})
    wompi_id = tx.get("id")
    status   = tx.get("status")

    result = await db.execute(select(PaymentTransaction).where(PaymentTransaction.wompi_id == wompi_id))
    payment = result.scalar_one_or_none()
    if not payment:
        return {"ok": True}

    old_status = payment.status
    # Mapear DECLINED → UNPAID para activar el bloqueo de futuras sesiones
    payment.status = "UNPAID" if status == "DECLINED" else status
    await db.commit()
    logger.info(f"Webhook Wompi: {wompi_id} → {status}" + (" (→ UNPAID)" if status == "DECLINED" else ""))

    return {"ok": True}


@app.get("/my-earnings")
async def my_earnings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños de cargadores")
    result = await db.execute(
        select(Session)
        .join(Charger)
        .where(Charger.owner_id == current_user.id)
        .options(selectinload(Session.charger))
        .order_by(Session.ended_at.desc())
        .limit(50)
    )
    sessions = result.scalars().all()
    total_revenue    = sum(s.revenue_owner for s in sessions)
    total_elec       = sum(s.electricity_cost for s in sessions)
    total_commission = sum(s.commission_cpo for s in sessions)
    total_net        = sum(s.net_profit_owner for s in sessions)
    total_kwh        = sum(s.kwh_delivered for s in sessions)
    return {
        "margin": PLATFORM_MARGIN,
        "total_revenue_cop":    round(total_revenue),
        "total_electricity_cop": round(total_elec),
        "total_commission_cop": round(total_commission),
        "total_net_profit_cop": round(total_net),
        "total_kwh":            round(total_kwh, 2),
        "total_sessions":       len(sessions),
        "sessions":             [s.to_dict() for s in sessions],
    }


# ── SALDO Y RETIROS DEL DUEÑO ────────────────────────────────────────────────

@app.get("/my-balance")
async def my_balance(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    balance = await _owner_balance_cents(db, current_user.id)

    # Giros en camino vs atascados por activación de Wompi
    disb_r = await db.execute(
        select(DisbursementRecord).where(DisbursementRecord.owner_id == current_user.id)
    )
    records    = disb_r.scalars().all()
    in_transit = sum(r.amount_cents for r in records if r.status in ("PENDING", "PROCESSING", "CREATED"))
    pending_act = sum(r.amount_cents for r in records if r.status == "PENDING_ACTIVATION")
    sent       = sum(r.amount_cents for r in records if r.status not in ("PENDING", "PROCESSING", "CREATED", "PENDING_ACTIVATION", "FAILED", "ERROR", "DECLINED"))

    entries_r = await db.execute(
        select(LedgerEntry)
        .where(LedgerEntry.owner_id == current_user.id)
        .order_by(LedgerEntry.created_at.desc())
        .limit(50)
    )
    return {
        "balance_cop":            balance // 100,
        "min_withdraw_cop":       MIN_WITHDRAW_COP,
        "next_settlement":        _next_settlement_date(datetime.now(BOGOTA).date()).isoformat(),
        "in_transit_cop":         in_transit // 100,
        "pending_activation_cop": pending_act // 100,
        "total_sent_cop":         sent // 100,
        "entries": [e.to_dict() for e in entries_r.scalars().all()],
    }


@app.post("/my-balance/withdraw")
async def withdraw_balance(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    async with _settle_lock(current_user.id):
        result = await _settle_owner(db, current_user.id, min_cop=MIN_WITHDRAW_COP)
        if not result["ok"]:
            raise HTTPException(400, result["reason"])
        await db.commit()
    return result


# ── ESTADÍSTICAS DEL DUEÑO ───────────────────────────────────────────────────

_PERIOD_HOURS = {"today": None, "week": 24 * 7, "month": 24 * 30}  # today = desde medianoche Bogotá

def _period_start_utc(period: str) -> datetime:
    now_bo = datetime.now(BOGOTA)
    if period == "today":
        start_bo = now_bo.replace(hour=0, minute=0, second=0, microsecond=0)
        return start_bo.astimezone(timezone.utc)
    hours = _PERIOD_HOURS.get(period) or 24 * 7
    return datetime.now(timezone.utc) - timedelta(hours=hours)


@app.get("/my-stats")
async def my_stats(
    period: str = "week",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rendimiento por cargador en el período: sesiones, kWh, plata y % de utilización."""
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    if period not in _PERIOD_HOURS:
        raise HTTPException(400, "period debe ser today | week | month")

    start_utc = _period_start_utc(period)
    now_utc   = datetime.now(timezone.utc)
    elapsed_s = max(1.0, (now_utc - start_utc).total_seconds())

    chargers_r = await db.execute(select(Charger).where(Charger.owner_id == current_user.id))
    my = chargers_r.scalars().all()

    sessions_r = await db.execute(
        select(Session)
        .join(Charger)
        .where(Charger.owner_id == current_user.id, Session.ended_at >= start_utc)
    )
    sessions = sessions_r.scalars().all()

    by_charger: Dict[str, dict] = {
        c.id: {
            "charger_id": c.id, "location": c.location, "status": c.status,
            "sessions": 0, "kwh": 0.0, "revenue_cop": 0, "net_cop": 0,
            "occupied_s": 0.0, "last_session_at": None,
        } for c in my
    }
    for s in sessions:
        st = by_charger.get(s.charger_id)
        if not st:
            continue
        st["sessions"]    += 1
        st["kwh"]         += s.kwh_delivered
        st["revenue_cop"] += int(s.revenue_owner)
        st["net_cop"]     += int(s.net_profit_owner)
        if s.started_at:
            st["occupied_s"] += max(0.0, (s.ended_at - s.started_at).total_seconds())
        if st["last_session_at"] is None or s.ended_at.isoformat() > st["last_session_at"]:
            st["last_session_at"] = s.ended_at.isoformat()

    stats = []
    for st in by_charger.values():
        st["kwh"] = round(st["kwh"], 2)
        st["utilization_pct"] = round(100 * st.pop("occupied_s") / elapsed_s, 1)
        stats.append(st)
    stats.sort(key=lambda x: -x["revenue_cop"])

    return {
        "period": period,
        "since": start_utc.isoformat(),
        "totals": {
            "sessions":    sum(s["sessions"] for s in stats),
            "kwh":         round(sum(s["kwh"] for s in stats), 2),
            "revenue_cop": sum(s["revenue_cop"] for s in stats),
            "net_cop":     sum(s["net_cop"] for s in stats),
        },
        "chargers": stats,
    }


# ── ALERTAS DEL DUEÑO ────────────────────────────────────────────────────────

@app.get("/my-events")
async def my_events(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(OwnerEvent)
        .where(OwnerEvent.owner_id == current_user.id)
        .order_by(OwnerEvent.created_at.desc())
        .limit(30)
    )
    events = result.scalars().all()
    return {
        "unread_count": sum(1 for e in events if not e.read),
        "events": [e.to_dict() for e in events],
    }


@app.post("/my-events/read")
async def mark_events_read(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(OwnerEvent).where(OwnerEvent.owner_id == current_user.id, OwnerEvent.read.is_(False))
    )
    for e in result.scalars().all():
        e.read = True
    await db.commit()
    return {"ok": True}


# ── EXPORT CSV ───────────────────────────────────────────────────────────────

from fastapi import Response
from jose import jwt as _jwt
from auth import SECRET_KEY as _SECRET, ALGORITHM as _ALGO

@app.get("/my-earnings/export")
async def export_earnings_csv(token: str, db: AsyncSession = Depends(get_db)):
    """CSV de sesiones para la contabilidad del dueño.
    Auth por query param: se abre directo desde el navegador del teléfono."""
    try:
        user_id = _jwt.decode(token, _SECRET, algorithms=[_ALGO])["sub"]
    except Exception:
        raise HTTPException(401, "Token inválido")
    user = await db.get(User, user_id)
    if not user or user.role != "owner":
        raise HTTPException(403, "Solo para dueños")

    result = await db.execute(
        select(Session)
        .join(Charger)
        .where(Charger.owner_id == user.id)
        .options(selectinload(Session.charger))
        .order_by(Session.ended_at.desc())
        .limit(1000)
    )
    rows = ["fecha;cargador;ubicacion;kwh;precio_kwh;ingreso_bruto;comision_cpo;iva;pasarela;costo_luz;ganancia_neta;total_conductor"]
    for s in result.scalars().all():
        fecha = s.ended_at.astimezone(BOGOTA).strftime("%Y-%m-%d %H:%M")
        rows.append(";".join(str(v) for v in [
            fecha, s.charger_id, (s.charger.location if s.charger else "").replace(";", ","),
            f"{s.kwh_delivered:.3f}", round(s.price_per_kwh), round(s.revenue_owner),
            round(s.commission_cpo), round(s.iva_amount), round(s.gateway_fee),
            round(s.electricity_cost), round(s.net_profit_owner), round(s.total_charged),
        ]))
    csv_content = "﻿" + "\n".join(rows)   # BOM para que Excel abra bien las tildes
    return Response(
        content=csv_content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=faro-sesiones-{datetime.now(BOGOTA).strftime('%Y%m%d')}.csv"},
    )


# ── DISPERSIONES DEL DUEÑO ───────────────────────────────────────────────────

@app.get("/my-disbursements")
async def my_disbursements(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    result = await db.execute(
        select(DisbursementRecord)
        .where(DisbursementRecord.owner_id == current_user.id)
        .order_by(DisbursementRecord.created_at.desc())
        .limit(50)
    )
    records = result.scalars().all()
    pending_activation = [r for r in records if r.status == "PENDING_ACTIVATION"]
    sent               = [r for r in records if r.status not in ("PENDING_ACTIVATION", "PENDING", "FAILED")]
    return {
        "wompi_dispersiones_activas": len(pending_activation) == 0 and len(records) > 0,
        "total_pendiente_cop":  sum(r.amount_cents for r in pending_activation) // 100,
        "total_enviado_cop":    sum(r.amount_cents for r in sent) // 100,
        "records": [r.to_dict() for r in records],
    }


# ── PANEL ADMIN CPO ───────────────────────────────────────────────────────────

@app.get("/admin/summary")
async def admin_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(403, "Solo para administradores de la plataforma")

    sessions_r = await db.execute(
        select(Session).options(selectinload(Session.charger)).order_by(Session.ended_at.desc()).limit(50)
    )
    sessions = sessions_r.scalars().all()

    payments_r = await db.execute(select(PaymentTransaction))
    payments   = payments_r.scalars().all()

    disb_r     = await db.execute(select(DisbursementRecord))
    disbs      = disb_r.scalars().all()

    users_r    = await db.execute(select(User))
    users      = users_r.scalars().all()

    total_collected  = sum(s.total_charged   for s in sessions)
    total_disbursed  = sum(s.revenue_owner   for s in sessions)
    total_commission = sum(s.commission_cpo  for s in sessions)
    total_iva        = sum(s.iva_amount       for s in sessions)
    total_gateway    = sum(s.gateway_fee      for s in sessions)
    total_kwh        = sum(s.kwh_delivered    for s in sessions)

    return {
        # Contadores
        "total_sessions":   len(sessions),
        "total_kwh":        round(total_kwh, 2),
        "total_conductors": sum(1 for u in users if u.role == "conductor"),
        "total_owners":     sum(1 for u in users if u.role == "owner"),
        "total_chargers":   (await db.execute(select(Charger))).scalars().all().__len__(),
        # Flujo de dinero
        "collected_conductors_cop": round(total_collected),   # lo que pagaron los conductores
        "disbursed_owners_cop":     round(total_disbursed),   # lo que salió hacia los dueños
        "commission_cpo_cop":       round(total_commission),  # tu ganancia (10%)
        "iva_cop":                  round(total_iva),          # IVA (debes remitir a DIAN)
        "gateway_cop":              round(total_gateway),      # pasarela Wompi
        "balance_wompi_cop":        round(total_collected - total_disbursed),
        # Dispersiones
        "disb_sent":               sum(1 for d in disbs if d.status in ("SENT", "PROCESSING", "CREATED")),
        "disb_pending":            sum(1 for d in disbs if d.status == "PENDING"),
        "disb_failed":             sum(1 for d in disbs if d.status in ("ERROR", "FAILED")),
        "disb_pending_activation": sum(1 for d in disbs if d.status == "PENDING_ACTIVATION"),
        "disb_pending_activation_cop": sum(d.amount_cents for d in disbs if d.status == "PENDING_ACTIVATION") // 100,
        "wompi_dispersiones_activas": not any(d.status == "PENDING_ACTIVATION" for d in disbs),
        # Últimas sesiones
        "recent_sessions": [s.to_dict() for s in sessions[:20]],
    }
