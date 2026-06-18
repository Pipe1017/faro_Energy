"""Motor de negocio: OCPP, cobros (outbox), liquidacion, workers.
Extraido literal de main.py — misma logica, ahora reusable por los routers."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone, date as _date
from typing import Dict

from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from ocpp.routing import on
from ocpp.v16 import ChargePoint as cp
from ocpp.v16 import call_result, call
from ocpp.v16.enums import Action, RegistrationStatus, AvailabilityType

from database import AsyncSessionLocal
from models import (User, Charger, Session, Reservation, PaymentMethod,
                    DisbursementAccount, PaymentTransaction, DisbursementRecord,
                    PendingCharge, LedgerEntry, ChargerBrandProfile, OwnerEvent, Invoice,
                    WalletTransaction)
import wompi as wompi_svc
import emailer
from config import (PLATFORM_MARGIN, IVA_RATE, GATEWAY_FEE, WOMPI_MIN_CENTS,
                    CHARGE_MAX_ATTEMPTS, OFFLINE_SESSION_TIMEOUT, IDLE_SESSION_TIMEOUT, MIN_WITHDRAW_COP,
                    SETTLEMENT_DAYS, SETTLE_CHECK_INTERVAL, BOGOTA, _PERIOD_HOURS,
                    RESERVE_MINUTES, RESERVE_GRACE_MINUTES, RESERVE_FEE_FACTOR,
                    RESERVE_FEE_MIN_COP, RESERVE_FEE_CAP_COP, RESERVE_CONVENIENCE_COP,
                    RESERVE_CHECK_INTERVAL,
                    ACCT_FARO_REVENUE, ACCT_FARO_IVA, ACCT_FARO_GATEWAY, GATEWAY_BORNE_BY,
                    SUBSCRIPTION_COP, WOMPI_FEE_PCT, WOMPI_FEE_FIXED_COP, monthly_fee_cop,
                    AUTO_SUBSCRIPTION_BILLING, SUBSCRIPTION_CHECK_INTERVAL)
from state import connected_chargers

logger = logging.getLogger(__name__)


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
                # Un BootNotification = el cargador (re)arrancó y perdió el
                # contexto de cualquier sesión en curso. Limpiar la transacción
                # colgada evita una "sesión fantasma" (barra morada sin carga real)
                if charger.active_transaction:
                    logger.warning(
                        f"[{self.id}] Boot con sesión colgada (tx#{charger.active_transaction}, "
                        f"{charger.current_kwh or 0} kWh) — el cargador reinició, se descarta"
                    )
                    charger.active_transaction = None
                    charger.session_user = None
                    charger.session_started_at = None
                    charger.current_kwh = None
                    charger.meter_start = None
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
        """Autorización OCPP (también cubre tarjetas RFID físicas). Fail-closed:
        solo autoriza a un usuario registrado, sin deuda, con dueño al día y saldo
        suficiente. Es la última barrera además de /payments/initiate."""
        status = "Accepted"
        try:
            async with AsyncSessionLocal() as db:
                user = (await db.execute(
                    select(User).where(User.tag == id_tag).limit(1)
                )).scalar_one_or_none()
                charger = await db.get(Charger, self.id)
                if not user:
                    status = "Invalid"            # tag no registrado → no es flujo soportado
                else:
                    owner = await db.get(User, charger.owner_id) if charger and charger.owner_id else None
                    bal = await _wallet_balance_cents(db, user.id)
                    if owner and not owner.subscription_active:
                        status = "Blocked"        # cargador suspendido por mensualidad
                    elif charger and bal < calc_preauth_cop(charger):
                        status = "Blocked"        # saldo insuficiente (prepago, sin deuda)
        except Exception as e:
            logger.warning(f"[{self.id}] Authorize: {e}")
        return call_result.AuthorizePayload(id_tag_info={"status": status})

    @on(Action.StartTransaction)
    async def on_start_transaction(self, connector_id, id_tag, meter_start, timestamp, **kwargs):
        tx_id = int(datetime.now().timestamp())
        logger.info(f"[{self.id}] Sesión iniciada — tx#{tx_id} usuario:{id_tag}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            if charger:
                # El idTag de OCPP es el `tag` corto del usuario; lo resolvemos de
                # vuelta a su email para el emparejamiento de sesiones (cae al id_tag
                # tal cual si no lo encuentra, p. ej. una tarjeta RFID física).
                session_user = id_tag
                u = (await db.execute(select(User).where(User.tag == id_tag).limit(1))).scalar_one_or_none()
                if u:
                    session_user = u.email
                charger.status = "Charging"
                charger.active_transaction = tx_id
                charger.session_user = session_user
                charger.meter_start = meter_start
                charger.session_started_at = datetime.now(timezone.utc)
                charger.current_kwh = 0.0   # resetear al iniciar sesión nueva
                _wallet_stop_sent.discard(self.id)
                _session_progress.pop(self.id, None)
                _notify_owner(db, charger.owner_id, "SESSION_STARTED",
                              f"{self.id}: carga iniciada por {session_user}", self.id)
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
                    # Seguridad wallet: cortar si el costo alcanza el saldo prepago
                    await _enforce_wallet_limit(db, charger)
        except Exception as e:
            logger.warning(f"[{self.id}] Error MeterValues: {e}")
        return call_result.MeterValuesPayload()

    @on(Action.StopTransaction)
    async def on_stop_transaction(self, meter_stop, timestamp, transaction_id, **kwargs):
        logger.info(f"[{self.id}] Sesión terminada — tx#{transaction_id}")
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, self.id)
            # Idempotente: si la sesión ya se finalizó (fallback/parada manual), no
            # crear una sesión fantasma ni cobrar dos veces.
            if charger and charger.active_transaction:
                kwh = (meter_stop - (charger.meter_start or 0)) / 1000
                await _finalize_session(db, charger, kwh)
                await db.commit()
            else:
                logger.info(f"[{self.id}] StopTransaction ignorado (sesión ya finalizada)")
        return call_result.StopTransactionPayload(id_tag_info={"status": "Accepted"})


# ── CIERRE DE SESIÓN Y COBRO (outbox) ─────────────────────────────────────────

# Tipos de alerta que ademas se envian por correo (los de alta señal; los
# frecuentes como SESSION_STARTED/COMPLETED quedan solo in-app para no spamear).
EMAIL_ALERT_TYPES = {"CHARGER_OFFLINE", "SETTLEMENT_SENT", "PAYMENT_UNPAID", "SUBSCRIPTION_CHARGED"}
EMAIL_ALERT_TITLES = {
    "CHARGER_OFFLINE": "Tu cargador está fuera de línea",
    "SETTLEMENT_SENT": "Te enviamos tu liquidación",
    "PAYMENT_UNPAID":  "Un cobro quedó pendiente",
    "SUBSCRIPTION_CHARGED": "Cobramos tu mensualidad de plataforma",
}


async def _email_owner(owner_id: str, type_: str, message: str):
    """Envía por correo una alerta del dueño (sesión propia, nunca lanza)."""
    try:
        async with AsyncSessionLocal() as db:
            owner = await db.get(User, owner_id)
        if not owner or not owner.email:
            return
        title = EMAIL_ALERT_TITLES.get(type_, "Notificación de Faro Energy")
        subject, html, text = emailer.owner_alert_email(owner.name, title, message)
        await emailer.send_email(owner.email, subject, html, text)
    except Exception as e:
        logger.warning(f"email alerta dueño: {e}")


def _notify_owner(db: AsyncSession, owner_id: str | None, type_: str, message: str, charger_id: str | None = None):
    """Registra una alerta para el dueño (centro de alertas in-app) y, para los
    tipos de alta señal, ademas la envia por correo en segundo plano."""
    if owner_id:
        db.add(OwnerEvent(owner_id=owner_id, type=type_, message=message, charger_id=charger_id))
        if type_ in EMAIL_ALERT_TYPES:
            try:
                asyncio.create_task(_email_owner(owner_id, type_, message))
            except RuntimeError:
                pass  # sin event loop (p. ej. en tests síncronos)


def session_money(kwh: float, charger: Charger, started_at: datetime | None = None,
                  responsable_iva: bool = True) -> dict:
    """Montos en COP enteros (Modelo A — comisionista / "bolsas").

    El conductor paga SOLO la recarga + IVA (sin markup):
        total = revenue + recarga_iva
    La comisión, su IVA y la pasarela NO se le suman al conductor: se DEBITAN del
    saldo del dueño al liquidar (ver _settle_captured). Por eso:
        neto_dueño = total − commission − commission_iva − gateway(si lo asume el dueño)
    El precio base depende de la franja horaria al INICIO de la sesión. Si el dueño
    no es responsable de IVA, la recarga no lleva IVA."""
    price_base     = charger.price_at(started_at)
    cost_base      = charger.cost_per_kwh or 0
    revenue        = round(kwh * price_base)                          # venta de energía del dueño (base)
    recarga_iva    = round(revenue * IVA_RATE) if responsable_iva else 0
    total          = revenue + recarga_iva                            # lo que paga el conductor
    commission     = round(revenue * PLATFORM_MARGIN)                 # comisión Faro 15% (descontada del dueño)
    commission_iva = round(commission * IVA_RATE)                     # Faro siempre es responsable de IVA
    # Modelo wallet: NO hay pasarela por sesión (el conductor paga con saldo). La
    # pasarela la asume Faro en la RECARGA del wallet. Por eso el dueño no la paga.
    gateway        = 0
    gateway_owner  = 0
    elec_cost      = round(kwh * cost_base)
    net_owner      = total - commission - commission_iva
    return {
        "revenue": revenue, "recarga_iva": recarga_iva, "total": total,
        "commission": commission, "commission_iva": commission_iva,
        "gateway": gateway, "gateway_owner": gateway_owner,
        "elec_cost": elec_cost, "net_owner": net_owner,
        # compat: campos que ya consumían modelos/UI
        "iva": recarga_iva, "net_profit": revenue - elec_cost,
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
    owner = await db.get(User, charger.owner_id) if charger.owner_id else None
    responsable_iva = owner.responsable_iva if owner else True
    m = session_money(kwh, charger, charger.session_started_at, responsable_iva)
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

    # Recibo por correo al conductor (si su identificador es un email)
    conductor = charger.session_user or ""
    if "@" in conductor:
        subject, html, text = emailer.receipt_email(
            conductor.split("@")[0], charger.location, kwh, int(m["total"]))
        try:
            asyncio.create_task(emailer.send_email(conductor, subject, html, text))
        except RuntimeError:
            pass

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
    _wallet_stop_sent.discard(charger.id)
    _session_progress.pop(charger.id, None)
    logger.info(f"[{charger.id}] {kwh:.3f}kWh · ingreso:{m['revenue']} · luz:{m['elec_cost']} · neto:{m['net_profit']} COP")
    return session


async def _settle_captured(db: AsyncSession, pc: PendingCharge, pay_tx: PaymentTransaction):
    """Cobro confirmado: marca CAPTURED y reparte la plata en BOLSAS (Modelo A).

    Lo que pagó el conductor (total = recarga + IVA) es 100% del dueño en custodia.
    De su saldo se DEBITAN la comisión de Faro (+ su IVA) y la pasarela (si la
    asume el dueño). Asientos por sesión:

      Bolsa del dueño (owner_id, account=NULL):
        + total            (EARNING)        ← lo recaudado del conductor
        − comisión+IVA     (COMMISSION)     ← lo que cobra Faro
        − pasarela         (GATEWAY)        ← si GATEWAY_BORNE_BY == "owner"
      Bolsa de Faro (owner_id=NULL):
        + comisión         (COMMISSION_INCOME, account=revenue:faro)
        + IVA comisión     (IVA_COLLECTED,     account=tax:iva)

    La plata sale hacia el dueño solo en la liquidación. Idempotente: si el worker
    reintenta, el guard por EARNING evita duplicar el reparto."""
    pc.status = "DONE"
    pay_tx.status = "CAPTURED"
    logger.info(f"✓ Cobro sesión #{pc.session_id}: ${pay_tx.amount_cents // 100:,} COP CAPTURED")

    session = await db.get(Session, pc.session_id)
    if not session:
        return
    charger = await db.get(Charger, session.charger_id)
    owner_id = charger.owner_id if charger else None
    total = int(round(session.total_charged))
    if not owner_id or total <= 0:
        return

    # Evitar reparto duplicado si el worker reintenta
    existing = await db.execute(
        select(LedgerEntry)
        .where(LedgerEntry.session_id == session.id, LedgerEntry.type == "EARNING")
        .limit(1)
    )
    if existing.scalars().first():
        return

    commission     = int(round(session.commission_cpo))
    commission_iva = int(round(commission * IVA_RATE))
    gateway        = int(round(session.gateway_fee))
    gateway_owner  = gateway if GATEWAY_BORNE_BY == "owner" else 0
    tag = f"sesión #{session.id} — {session.charger_id}"

    # ── Bolsa del dueño ──
    db.add(LedgerEntry(owner_id=owner_id, session_id=session.id, type="EARNING",
                       amount_cents=total * 100, description=f"Recarga cobrada — {tag}"))
    if commission + commission_iva > 0:
        db.add(LedgerEntry(owner_id=owner_id, session_id=session.id, type="COMMISSION",
                           amount_cents=-(commission + commission_iva) * 100,
                           description=f"Comisión Faro 10% + IVA — {tag}"))
    if gateway_owner > 0:
        db.add(LedgerEntry(owner_id=owner_id, session_id=session.id, type="GATEWAY",
                           amount_cents=-gateway_owner * 100, description=f"Pasarela — {tag}"))

    # ── Bolsas de Faro ──
    if commission > 0:
        db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_REVENUE, session_id=session.id,
                           type="COMMISSION_INCOME", amount_cents=commission * 100,
                           description=f"Comisión — {tag}"))
    if commission_iva > 0:
        db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_IVA, session_id=session.id,
                           type="IVA_COLLECTED", amount_cents=commission_iva * 100,
                           description=f"IVA comisión — {tag}"))

    net_owner = total - commission - commission_iva - gateway_owner
    logger.info(f"[{session.charger_id}] Bolsas s#{session.id}: dueño +${net_owner:,} "
                f"(recaudo ${total:,} − com ${commission + commission_iva:,} − pasarela ${gateway_owner:,}) "
                f"· Faro +${commission:,} · IVA ${commission_iva:,}")

    # Factura electrónica (por mandato la recarga; comisión la factura Faro) — outbox
    await _enqueue_session_invoices(db, session, owner_id, total, commission, commission_iva)


# ── FACTURACIÓN ELECTRÓNICA (outbox) ─────────────────────────────────────────

async def _enqueue_session_invoices(db: AsyncSession, session: Session, owner_id: str,
                                    total: int, commission: int, commission_iva: int):
    """Crea las facturas PENDING de una sesión (no emite — eso lo hace el worker).
    Idempotente: no duplica si ya existen para la sesión."""
    existing = await db.execute(
        select(Invoice.kind).where(Invoice.session_id == session.id)
    )
    have = {row[0] for row in existing.all()}

    recarga_iva = int(round(session.iva_amount))
    recarga_base = total - recarga_iva
    if "RECARGA" not in have and recarga_base > 0:
        db.add(Invoice(
            kind="RECARGA", session_id=session.id,
            issuer=f"owner:{owner_id}", owner_id=owner_id,   # por mandato, a nombre del dueño
            amount_cents=recarga_base * 100, iva_cents=recarga_iva * 100, total_cents=total * 100,
        ))
    if "COMMISSION" not in have and commission > 0:
        db.add(Invoice(
            kind="COMMISSION", session_id=session.id,
            issuer="faro", owner_id=owner_id, recipient_user_id=owner_id,
            amount_cents=commission * 100, iva_cents=commission_iva * 100,
            total_cents=(commission + commission_iva) * 100,
        ))


async def _invoice_worker():
    """Emite las facturas PENDING contra el proveedor (stub o real) y guarda el
    PDF/XML en MinIO. Reintentos con backoff implícito (cada ciclo). Que una
    factura falle NO afecta la plata: el reparto en bolsas ya ocurrió."""
    import invoicing
    logger.info(f"Worker de facturación iniciado — proveedor: {invoicing.provider_name()}")
    while True:
        try:
            async with AsyncSessionLocal() as db:
                pend = await db.execute(
                    select(Invoice).where(Invoice.status == "PENDING",
                                          Invoice.attempts < 5).limit(20)
                )
                invoices = pend.scalars().all()
                for inv in invoices:
                    try:
                        await invoicing.issue_invoice(db, inv)
                    except Exception as e:
                        inv.attempts += 1
                        inv.last_error = str(e)[:480]
                        if inv.attempts >= 5:
                            inv.status = "FAILED"
                        logger.warning(f"Factura {inv.id[:8]} ({inv.kind}) intento {inv.attempts}: {e}")
                await db.commit()
        except Exception as e:
            logger.warning(f"invoice_worker: {e}")
        await asyncio.sleep(20)


# ── MENSUALIDAD DE PLATAFORMA (cobro a la tarjeta del dueño) ──────────────────

def _next_period_start(now: datetime) -> datetime:
    """Primer día del mes siguiente (hora Bogotá) — hasta cuándo queda cubierta."""
    if now.month == 12:
        return now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)


async def _owner_card(db: AsyncSession, owner_id: str) -> PaymentMethod | None:
    """Tarjeta del dueño para cobrar la mensualidad (la default, o cualquiera con source)."""
    rows = (await db.execute(
        select(PaymentMethod).where(
            PaymentMethod.user_id == owner_id,
            PaymentMethod.wompi_payment_source_id.isnot(None),
        ).order_by(PaymentMethod.is_default.desc())
    )).scalars().all()
    return rows[0] if rows else None


async def bill_owner_subscription(db: AsyncSession, owner: User, period: str | None = None) -> dict:
    """Cobra la mensualidad de plataforma a la TARJETA del dueño (Wompi).

    APROBADA  → ingreso Faro + IVA + costo pasarela + factura SUBSCRIPTION; activa
                los cargadores (subscription_active=True) hasta el próximo mes.
    RECHAZADA → suspende al dueño (subscription_active=False) → sus cargadores se
                ocultan/bloquean. NO registra ingreso.
    Idempotente por mes: no recobra un period ya cobrado con éxito.
    Usado por el back-office (manual) y por el worker (automático).
    """
    period = period or datetime.now(BOGOTA).strftime("%Y-%m")
    n = int((await db.execute(
        select(func.count(Charger.id)).where(Charger.owner_id == owner.id)
    )).scalar() or 0)
    if n == 0:
        raise HTTPException(400, "El dueño no tiene cargadores: no hay mensualidad que cobrar")

    # Idempotencia: ¿ya hay un ingreso de mensualidad de este mes para este dueño?
    dup = (await db.execute(
        select(LedgerEntry.id).where(
            LedgerEntry.account == ACCT_FARO_REVENUE,
            LedgerEntry.type == "SUBSCRIPTION_INCOME",
            LedgerEntry.description.like(f"%[{period}]%{owner.email}%"),
        )
    )).first()
    if dup:
        raise HTTPException(409, f"La mensualidad de {period} ya fue cobrada a este dueño")

    card = await _owner_card(db, owner.id)
    if not card:
        raise HTTPException(400, "El dueño no tiene una tarjeta asociada para cobrar la mensualidad")

    fee = monthly_fee_cop(n)
    iva = round(fee * IVA_RATE)
    total = fee + iva
    amount_cents = total * 100
    reference = f"sub-{owner.id[:8]}-{period}-{int(datetime.now().timestamp())}"

    # Cobro a la tarjeta (Wompi)
    status = ""
    try:
        resp = await wompi_svc.capture_preauth(card.wompi_payment_source_id, amount_cents, owner.email, reference)
        data = resp.get("data", {})
        status = data.get("status") or ""
        wid = data.get("id")
        waited = 0
        while status == "PENDING" and wid and waited < 6:
            await asyncio.sleep(1); waited += 1
            data = (await wompi_svc.get_transaction(str(wid))).get("data", {})
            status = data.get("status") or ""
    except Exception as e:
        logger.warning(f"Mensualidad {reference}: error Wompi {e}")
        status = "ERROR"

    if status != "APPROVED":
        # Transacción rechazada → suspender y ocultar/bloquear sus cargadores
        owner.subscription_active = False
        await db.commit()
        _notify_owner(db, owner.id, "PAYMENT_UNPAID",
                      "No pudimos cobrar la mensualidad de plataforma. Tus cargadores quedaron "
                      "suspendidos hasta que actualices tu tarjeta.")
        await db.commit()
        return {"ok": False, "status": status or "RECHAZADA", "period": period,
                "chargers": n, "fee_cop": fee, "iva_cop": iva, "total_cop": total,
                "subscription_active": False}

    # Aprobada → ingreso de Faro, IVA, costo de pasarela, factura, reactivar
    wid = data.get("id")
    desc = f"Mensualidad plataforma [{period}] — {owner.email} ({n} cargador/es)"
    db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_REVENUE, type="SUBSCRIPTION_INCOME",
                       amount_cents=fee * 100, description=desc))
    if iva > 0:
        db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_IVA, type="IVA_COLLECTED",
                           amount_cents=iva * 100, description=f"IVA mensualidad [{period}] — {owner.email}"))
    fee_cents = round((amount_cents * WOMPI_FEE_PCT + WOMPI_FEE_FIXED_COP * 100) * (1 + IVA_RATE))
    db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_GATEWAY, type="GATEWAY_COST",
                       amount_cents=-fee_cents, description=f"Pasarela mensualidad [{period}] — {owner.email}"))
    db.add(Invoice(kind="SUBSCRIPTION", issuer="faro", owner_id=owner.id,
                   recipient_user_id=owner.id, amount_cents=fee * 100,
                   iva_cents=iva * 100, total_cents=total * 100))

    owner.subscription_active = True
    owner.subscription_paid_until = _next_period_start(datetime.now(BOGOTA))
    _notify_owner(db, owner.id, "SUBSCRIPTION_CHARGED",
                  f"Cobramos tu mensualidad de plataforma de {period}: ${total:,} COP "
                  f"(IVA incl.). Tus {n} cargador(es) siguen activos.")
    await db.commit()
    logger.info(f"Mensualidad {period} cobrada a {owner.email}: ${total:,} (tx {wid})")
    return {"ok": True, "status": "APPROVED", "period": period, "chargers": n,
            "fee_cop": fee, "iva_cop": iva, "total_cop": total,
            "subscription_active": True,
            "paid_until": owner.subscription_paid_until.isoformat() if owner.subscription_paid_until else None}


async def _subscription_billing_worker():
    """[Automático — desactivado por defecto] Cobra la mensualidad a los dueños cuya
    cobertura (subscription_paid_until) ya venció. Activar con AUTO_SUBSCRIPTION_BILLING=true.
    Hoy el cobro es MANUAL desde el back-office; este worker es el placeholder listo."""
    logger.info("Worker de mensualidad (automático) iniciado")
    while True:
        try:
            async with AsyncSessionLocal() as db:
                now = datetime.now(BOGOTA)
                due = (await db.execute(
                    select(User).where(
                        User.role == "owner",
                        (User.subscription_paid_until.is_(None)) | (User.subscription_paid_until <= now),
                    )
                )).scalars().all()
                for owner in due:
                    # solo dueños con cargadores y tarjeta; si no, se omiten
                    try:
                        async with _settle_lock(owner.id):
                            await bill_owner_subscription(db, owner)
                    except HTTPException as e:
                        logger.info(f"Mensualidad auto omitida {owner.email}: {e.detail}")
                    except Exception as e:
                        logger.warning(f"Mensualidad auto {owner.email}: {e}")
        except Exception as e:
            logger.warning(f"subscription_billing_worker: {e}")
        await asyncio.sleep(SUBSCRIPTION_CHECK_INTERVAL)


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
        .where(LedgerEntry.owner_id == owner_id, LedgerEntry.account.is_(None))
    )
    return int(result.scalar() or 0)


async def _faro_balance_cents(db: AsyncSession, account: str) -> int:
    """Saldo de una bolsa de Faro (revenue:faro o tax:iva)."""
    result = await db.execute(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.account == account)
    )
    return int(result.scalar() or 0)


async def _wallet_balance_cents(db: AsyncSession, user_id: str) -> int:
    """Saldo prepago del conductor = suma de sus movimientos de wallet."""
    result = await db.execute(
        select(func.coalesce(func.sum(WalletTransaction.amount_cents), 0))
        .where(WalletTransaction.user_id == user_id)
    )
    return int(result.scalar() or 0)


# Cargadores a los que ya enviamos el corte por saldo (evita reenviar RemoteStop
# en cada MeterValue mientras el cargador termina de detenerse).
_wallet_stop_sent: set[str] = set()

# Progreso de energía por cargador: {id: (last_kwh, momento_del_último_avance)}.
# Sirve para detectar sesiones inactivas (carro conectado que ya no consume).
_session_progress: dict[str, tuple[float, datetime]] = {}


async def _finalize_fallback(charge_point_id: str, grace: int = 30):
    """Red de seguridad: si tras pedir RemoteStop el cargador NO envía su
    StopTransaction en `grace` s, finaliza la sesión del lado servidor (con el
    último consumo medido) para que SIEMPRE se cobre y se libere el cargador.
    Idempotente: si el StopTransaction sí llegó, active_transaction ya es None y no hace nada."""
    await asyncio.sleep(grace)
    try:
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, charge_point_id)
            if charger and charger.active_transaction:
                logger.warning(f"[{charge_point_id}] Sin StopTransaction en {grace}s — "
                               f"finalizando del lado servidor ({charger.current_kwh or 0} kWh)")
                await _finalize_session(db, charger, charger.current_kwh or 0.0)
                await db.commit()
    except Exception as e:
        logger.warning(f"[{charge_point_id}] fallback de finalización: {e}")


async def _stop_charge(charger: Charger, reason: str) -> bool:
    """Envía RemoteStop al cargador físico y programa un fallback de finalización
    por si el StopTransaction no llega. True si se envió el comando."""
    conn = connected_chargers.get(charger.id)
    if not conn or not charger.active_transaction:
        return False
    try:
        await conn.call(call.RemoteStopTransactionPayload(transaction_id=charger.active_transaction))
        logger.info(f"[{charger.id}] RemoteStop ({reason})")
        asyncio.create_task(_finalize_fallback(charger.id))
        return True
    except Exception as e:
        logger.warning(f"[{charger.id}] No se pudo enviar RemoteStop ({reason}): {e}")
        return False


async def _guard_active_sessions(db: AsyncSession):
    """Watchdog periódico (corre en el loop de cobros, cada ~5 s) sobre TODA sesión
    activa — independiente de la frecuencia de MeterValues. Defense in depth:
      1) Corte por saldo (wallet) si el costo alcanza el saldo.
      2) Timeout de inactividad: si la energía no avanza en IDLE_SESSION_TIMEOUT
         (carro lleno/conectado), cierra la sesión y libera el cargador.
      3) Dueño suspendido a mitad de carga → detener.
    """
    rows = (await db.execute(
        select(Charger).where(Charger.active_transaction.isnot(None))
    )).scalars().all()
    now = datetime.now(timezone.utc)
    for charger in rows:
        if charger.id not in connected_chargers:
            continue  # offline lo maneja _close_orphan_sessions

        # 3) dueño suspendido durante la carga
        if charger.owner_id:
            owner = await db.get(User, charger.owner_id)
            if owner and not owner.subscription_active:
                await _stop_charge(charger, "dueño suspendido")
                continue

        # 1) límite de saldo (también aquí, no solo en MeterValues)
        await _enforce_wallet_limit(db, charger)

        # 2) inactividad: ¿avanzó la energía?
        kwh = charger.current_kwh or 0.0
        prev = _session_progress.get(charger.id)
        if prev is None or kwh > prev[0] + 0.01:
            _session_progress[charger.id] = (kwh, now)
        elif (now - prev[1]).total_seconds() >= IDLE_SESSION_TIMEOUT:
            if await _stop_charge(charger, f"inactiva {IDLE_SESSION_TIMEOUT}s sin consumo"):
                _session_progress.pop(charger.id, None)


async def _enforce_wallet_limit(db: AsyncSession, charger: Charger):
    """Seguridad del saldo prepago: si el costo acumulado de la carga alcanza el
    saldo del conductor, corta la carga (RemoteStop) antes de que quede en deuda.
    Solo aplica a sesiones WALLET. Deja un colchón (≈2 min de energía) porque entre
    una muestra y la siguiente podría entrar más energía."""
    if not charger.active_transaction or charger.id in _wallet_stop_sent:
        return
    pay_tx = (await db.execute(
        select(PaymentTransaction).where(
            PaymentTransaction.charger_id == charger.id,
            PaymentTransaction.status == "APPROVED",
            PaymentTransaction.session_id.is_(None),
        ).order_by(PaymentTransaction.created_at.desc()).limit(1)
    )).scalars().first()
    if not pay_tx or pay_tx.payment_type != "WALLET":
        return

    bal = await _wallet_balance_cents(db, pay_tx.user_id)
    owner = await db.get(User, charger.owner_id) if charger.owner_id else None
    responsable_iva = owner.responsable_iva if owner else True
    m = session_money(charger.current_kwh or 0.0, charger, charger.session_started_at, responsable_iva)
    cost_cents = m["total"] * 100

    # Colchón adaptado a la potencia: energía que podría entrar en ~2 min a tope
    price_user = (charger.price_at(charger.session_started_at) or 1000) * (1 + (IVA_RATE if responsable_iva else 0))
    margin_cents = max(round((charger.power_kw or 7.0) * (2 / 60) * price_user) * 100, int(bal * 0.03))

    if cost_cents < bal - margin_cents:
        return

    _wallet_stop_sent.add(charger.id)
    if not await _stop_charge(charger, f"saldo: costo ${m['total']:,} ≈ ${bal // 100:,} "
                                       f"(colchón ${margin_cents // 100:,})"):
        _wallet_stop_sent.discard(charger.id)


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
                    .where(LedgerEntry.owner_id.isnot(None), LedgerEntry.account.is_(None))
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
            # Pago de deuda colgado en confirmación: liberar para reintento manual
            if pay_tx and pay_tx.status == "PROCESSING":
                pay_tx.status = "UNPAID"
            logger.error(f"Cobro sesión #{pc.session_id} agotó reintentos — requiere revisión manual: {err[:120]}")
        else:
            logger.warning(f"Cobro sesión #{pc.session_id} falló (intento {pc.attempts}) — reintento en {delay}s")

    # 0) Modo WALLET: el conductor paga con su saldo prepago (sin Wompi por sesión).
    #    Prepago = NUNCA hay deuda: si el saldo no alcanza (raro: la carga se corta
    #    antes), se cobra solo lo que hay y se reescala la sesión a ese monto.
    if pay_tx.payment_type == "WALLET":
        if pc.amount_cents <= 0:
            pc.status = "DONE"; pay_tx.status = "VOID"; return
        bal = await _wallet_balance_cents(db, pay_tx.user_id)
        if bal <= 0:
            pc.status = "DONE"; pay_tx.status = "VOID"
            logger.warning(f"Cobro sesión #{pc.session_id}: saldo 0 → sin cobro (VOID), sin deuda")
            return
        if bal < pc.amount_cents:
            session = await db.get(Session, pc.session_id)
            if session:
                ratio = bal / pc.amount_cents
                for f in ("total_charged", "commission_cpo", "revenue_owner",
                          "iva_amount", "net_profit_owner", "electricity_cost"):
                    v = getattr(session, f, None)
                    if v is not None:
                        setattr(session, f, round(v * ratio))
            logger.warning(f"Cobro sesión #{pc.session_id}: saldo ${bal // 100:,} < "
                           f"${pc.amount_cents // 100:,} → se cobra el saldo (sin deuda)")
            pc.amount_cents = bal
        db.add(WalletTransaction(user_id=pay_tx.user_id, type="CHARGE",
                                amount_cents=-pc.amount_cents, session_id=pc.session_id,
                                description=f"Carga sesión #{pc.session_id}"))
        pay_tx.amount_cents = pc.amount_cents
        await _settle_captured(db, pc, pay_tx)
        return

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
        try:
            async with AsyncSessionLocal() as db:
                await _guard_active_sessions(db)
        except Exception as e:
            logger.warning(f"watchdog sesiones activas: {e}")


async def _mark_offline_after_grace(charge_point_id: str, grace: int = 10):
    await asyncio.sleep(grace)
    if charge_point_id not in connected_chargers:
        async with AsyncSessionLocal() as db:
            charger = await db.get(Charger, charge_point_id)
            if charger:
                charger.status = "Offline"
                await db.commit()
                logger.info(f"[{charge_point_id}] Marcado Offline tras {grace}s sin reconexión")



def calc_preauth_cop(charger: Charger) -> int:
    """Pre-auth basado en potencia del cargador (cubre 15 min + 20% buffer, mínimo $3.000 COP).
    Modelo A: el conductor paga recarga + IVA (sin markup)."""
    power_kw   = charger.power_kw or 22.0
    price_user = (charger.price_at() or 1000) * (1 + IVA_RATE)
    max_kwh    = power_kw * 0.25           # 15 minutos
    estimated  = max_kwh * price_user * 1.2
    rounded    = max(3_000, int(estimated / 1000 + 1) * 1000)  # mínimo $3.000, múltiplos de $1.000
    return rounded


# ── SEPARACIÓN / RESERVA ─────────────────────────────────────────────────────

def reservation_fee_cop(charger: Charger) -> int:
    """Garantía de separación: fracción del valor de la energía que el cargador
    dejaría de entregar mientras está bloqueado. Redondeada a $100, con piso y tope."""
    price_user = (charger.price_at() or 1000) * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * (1 + GATEWAY_FEE)
    window_kwh = (charger.power_kw or 22.0) * (RESERVE_MINUTES / 60)
    raw        = window_kwh * price_user * RESERVE_FEE_FACTOR
    rounded    = int(round(raw / 100) * 100)
    return max(RESERVE_FEE_MIN_COP, min(RESERVE_FEE_CAP_COP, rounded))


def _reservation_owner_revenue(gross_cents: int) -> int:
    """Del bruto capturado (lo que paga el conductor) saca la parte neta del dueño,
    revirtiendo comisión CPO + IVA + pasarela. Mismo reparto que la energía."""
    factor = (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * (1 + GATEWAY_FEE)
    return int(round(gross_cents / factor))


async def _capture_reservation(db: AsyncSession, reservation: Reservation, amount_cents: int, reason: str) -> bool:
    """Captura `amount_cents` de la garantía retenida y abona la parte del dueño al
    ledger. Idempotente vía reservation.settled. Devuelve True si quedó liquidada.
    Si la captura falla, deja settled=False para que el worker reintente."""
    if reservation.settled:
        return True
    pay_tx = await db.get(PaymentTransaction, reservation.payment_tx_id) if reservation.payment_tx_id else None
    source_id = reservation.wompi_preauth_id or (pay_tx.wompi_payment_source_id if pay_tx else None)

    captured = False
    if source_id and amount_cents > 0:
        user = await db.get(User, reservation.user_id)
        ref  = f"resv-{reservation.id}-{reason}"
        try:
            resp = await wompi_svc.capture_preauth(source_id, amount_cents, user.email if user else "", ref)
            tx   = resp.get("data", {})
            if (tx.get("status") or "") in ("APPROVED", "PENDING"):
                captured = True
                if pay_tx:
                    pay_tx.status   = "CAPTURED"
                    pay_tx.wompi_id = str(tx.get("id"))
                    pay_tx.amount_cents = amount_cents
        except Exception as e:
            logger.warning(f"resv #{reservation.id}: captura ${amount_cents//100:,} falló ({reason}): {e}")
            return False  # reintenta luego

    reservation.captured_cents = amount_cents if captured else 0
    reservation.settled = True

    # Abono al dueño (parte neta), igual que una sesión de energía
    if captured:
        charger  = await db.get(Charger, reservation.charger_id)
        owner_id = charger.owner_id if charger else None
        revenue  = _reservation_owner_revenue(amount_cents)
        if owner_id and revenue > 0:
            db.add(LedgerEntry(
                owner_id=owner_id, session_id=None, type="EARNING",
                amount_cents=revenue * 100,
                description=f"Separación {reason} — reserva #{reservation.id} ({reservation.charger_id})",
            ))
            _notify_owner(
                db, owner_id, "RESERVATION_FEE",
                f"{reservation.charger_id}: multa de separación ${amount_cents//100:,} COP — ganancia ${revenue:,}",
                reservation.charger_id,
            )
    return True


async def fulfill_reservation_if_any(db: AsyncSession, user_id: str, charger_id: str):
    """El conductor con reserva activa arrancó su sesión: marca la reserva como
    cumplida y captura SOLO la cuota fija de conveniencia (el resto de la retención
    se libera). Se llama al autorizar la sesión. No bloquea si la captura falla."""
    result = await db.execute(
        select(Reservation).where(
            Reservation.user_id == user_id,
            Reservation.charger_id == charger_id,
            Reservation.status == "active",
        ).order_by(Reservation.created_at.desc()).limit(1)
    )
    reservation = result.scalars().first()
    if not reservation:
        return
    reservation.status = "fulfilled"
    # Cuota fija ≤ garantía retenida. El sobrante de la retención se libera solo.
    fee = min(RESERVE_CONVENIENCE_COP * 100, reservation.fee_cents)
    await _capture_reservation(db, reservation, fee, "cumplida")
    conn = connected_chargers.get(charger_id)
    if conn:
        try:
            await conn.call(call.CancelReservationPayload(reservation_id=reservation.ocpp_reservation_id))
        except Exception:
            pass
    logger.info(f"resv #{reservation.id} cumplida — cuota ${fee//100:,} COP capturada, resto liberado")


async def _reservation_worker():
    """Vence reservas: pasado no_show_at sin cumplirse, captura la garantía completa
    (multa al dueño) y libera el cargador. Sobrevive reinicios (todo en DB)."""
    logger.info("Worker de reservas iniciado")
    while True:
        await asyncio.sleep(RESERVE_CHECK_INTERVAL)
        try:
            async with AsyncSessionLocal() as db:
                now = datetime.now(timezone.utc)
                due = await db.execute(
                    select(Reservation).where(
                        Reservation.status == "active",
                        Reservation.settled == False,   # noqa: E712
                        Reservation.no_show_at <= now,
                    ).limit(20)
                )
                for r in due.scalars().all():
                    charger = await db.get(Charger, r.charger_id)
                    conn    = connected_chargers.get(r.charger_id)
                    # Justicia: si el cargador no está disponible (offline/desconectado),
                    # el conductor no pudo cargar → se libera SIN cobrar la multa.
                    if conn is None or (charger and charger.status == "Offline"):
                        r.status, r.settled, r.captured_cents = "released", True, 0
                        if charger and charger.status == "Reserved":
                            charger.status = "Available"
                        logger.info(f"resv #{r.id} liberada sin multa — cargador no disponible")
                        continue
                    ok = await _capture_reservation(db, r, r.fee_cents, "no_show")
                    if ok:
                        r.status = "no_show"
                        if charger and charger.status == "Reserved":
                            charger.status = "Available"
                        try:
                            await conn.call(call.CancelReservationPayload(reservation_id=r.ocpp_reservation_id))
                        except Exception:
                            pass
                        logger.info(f"resv #{r.id} NO-SHOW — multa ${r.fee_cents//100:,} COP capturada")
                await db.commit()
        except Exception as e:
            logger.warning(f"reservation_worker: {e}")



def _period_start_utc(period: str) -> datetime:
    now_bo = datetime.now(BOGOTA)
    if period == "today":
        start_bo = now_bo.replace(hour=0, minute=0, second=0, microsecond=0)
        return start_bo.astimezone(timezone.utc)
    hours = _PERIOD_HOURS.get(period) or 24 * 7
    return datetime.now(timezone.utc) - timedelta(hours=hours)

