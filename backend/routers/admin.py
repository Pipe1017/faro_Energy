"""Back-office del CPO (rol admin): conciliación de las bolsas, facturas y dueños.

Pensado para la web de administración (no para la app móvil). Solo lectura +
acciones operativas puntuales (reintentar una factura). El control financiero del
Modelo A vive aquí: ingreso de Faro, IVA por girar a la DIAN y deuda con dueños.
"""
import logging
from datetime import datetime, timedelta

import json
import secrets
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models import (User, Charger, Session, Invoice, LedgerEntry, PaymentTransaction,
                    PaymentMethod, DisbursementAccount, DisbursementRecord, OwnerEvent,
                    Reservation, WalletTransaction, ChargerBrandProfile, ChargerModelPhoto, mask_email)
from core.auth import get_current_user, SECRET_KEY, ALGORITHM
from core.config import (ACCT_FARO_REVENUE, ACCT_FARO_IVA, ACCT_FARO_GATEWAY, BOGOTA,
                    MIN_WITHDRAW_COP, PLATFORM_MARGIN, IVA_RATE, monthly_fee_cop)
from services.engine import (_faro_balance_cents, _owner_balance_cents, _settle_lock, _notify_owner,
                    _wallet_balance_cents, _refundable_cents, bill_owner_subscription, _owner_card)
from core.state import connected_chargers
from services import storage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin")


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(403, "Solo administradores")
    return current_user


async def _admin_from_token(token: str, db: AsyncSession) -> User:
    """Valida admin desde un token en query (para abrir archivos en el navegador,
    donde no se puede mandar header Authorization)."""
    try:
        uid = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])["sub"]
    except (JWTError, KeyError):
        raise HTTPException(401, "Token inválido")
    u = await db.get(User, uid)
    if not u or u.role != "admin":
        raise HTTPException(403, "Solo administradores")
    return u


@router.get("/invoices/{invoice_id}/pdf")
async def invoice_pdf(invoice_id: str, token: str, db: AsyncSession = Depends(get_db)):
    """Sirve el PDF de la factura a través de la API (el backend lo lee de MinIO
    por dentro; el navegador nunca toca MinIO directo)."""
    await _admin_from_token(token, db)
    inv = await db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(404, "Factura no encontrada")
    if inv.provider == "stub":
        # Stub: regeneramos el PDF al vuelo (válido y consistente con los datos)
        from services import invoicing
        data = invoicing.render_invoice_pdf(inv)
    else:
        # Proveedor real (Factus): el PDF almacenado es el oficial
        data = storage.get_bytes(f"invoices/{inv.kind.lower()}/{inv.id}.pdf")
    if data is None:
        raise HTTPException(404, "PDF no disponible todavía")
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="factura-{inv.number or inv.id}.pdf"'})


def _cop(cents: int | None) -> int:
    return int(cents or 0) // 100


@router.get("/overview")
async def overview(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Tablero de plata: bolsas + actividad. Todo en COP enteros."""
    faro_revenue = await _faro_balance_cents(db, ACCT_FARO_REVENUE)   # comisión + mensualidad (bruto)
    iva_to_dian  = await _faro_balance_cents(db, ACCT_FARO_IVA)
    gateway_cost = await _faro_balance_cents(db, ACCT_FARO_GATEWAY)   # negativo (lo que Faro paga a Wompi)

    async def _revenue_by_type(t: str) -> int:
        r = await db.execute(
            select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
            .where(LedgerEntry.account == ACCT_FARO_REVENUE, LedgerEntry.type == t)
        )
        return int(r.scalar() or 0)
    commission_income   = await _revenue_by_type("COMMISSION_INCOME")
    subscription_income = await _revenue_by_type("SUBSCRIPTION_INCOME")

    # Suscripciones de dueños: activos vs suspendidos
    owners_total = await db.execute(select(func.count(User.id)).where(User.role == "owner"))
    owners_suspended = await db.execute(
        select(func.count(User.id)).where(User.role == "owner", User.subscription_active.is_(False))
    )

    # Deuda con dueños = suma de sus bolsas (wallets): account NULL, owner_id no nulo
    owed = await db.execute(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.owner_id.isnot(None), LedgerEntry.account.is_(None))
    )
    owed_to_owners = int(owed.scalar() or 0)

    collected = await db.execute(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.type == "EARNING")
    )
    disbursed = await db.execute(
        select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
        .where(LedgerEntry.type == "DISBURSEMENT")
    )

    # Actividad
    total_sessions = await db.execute(select(func.count(Session.id)))
    midnight = datetime.now(BOGOTA).replace(hour=0, minute=0, second=0, microsecond=0)
    today_sessions = await db.execute(
        select(func.count(Session.id)).where(Session.ended_at >= midnight)
    )
    gmv = await db.execute(select(func.coalesce(func.sum(Session.total_charged), 0)))

    # Facturas por estado
    inv_rows = await db.execute(select(Invoice.status, func.count(Invoice.id)).group_by(Invoice.status))
    inv_counts = {row[0]: row[1] for row in inv_rows.all()}

    chargers_total = await db.execute(select(func.count(Charger.id)))

    return {
        "money": {
            "commission_rate_pct": round(PLATFORM_MARGIN * 100),
            "faro_revenue_cop":  _cop(faro_revenue),                       # comisión + mensualidad (bruto)
            "commission_income_cop":   _cop(commission_income),            # solo comisión
            "subscription_income_cop": _cop(subscription_income),          # solo mensualidad
            "faro_gateway_cost_cop": _cop(abs(gateway_cost)),             # pasarela que Faro asume
            "faro_net_cop":      _cop(faro_revenue + gateway_cost),       # neto = (comisión + mensualidad) − pasarela
            "iva_to_dian_cop":   _cop(iva_to_dian),
            "owed_to_owners_cop": _cop(owed_to_owners),
            "collected_cop":     _cop(int(collected.scalar() or 0)),
            "disbursed_cop":     _cop(abs(int(disbursed.scalar() or 0))),
        },
        "subscriptions": {
            "owners_total":     int(owners_total.scalar() or 0),
            "owners_suspended": int(owners_suspended.scalar() or 0),
        },
        "activity": {
            "sessions_total": int(total_sessions.scalar() or 0),
            "sessions_today": int(today_sessions.scalar() or 0),
            "gmv_cop":        int(gmv.scalar() or 0),
        },
        "chargers": {
            "total":  int(chargers_total.scalar() or 0),
            "online": len(connected_chargers),
        },
        "invoices": {
            "pending": inv_counts.get("PENDING", 0),
            "issued":  inv_counts.get("ISSUED", 0),
            "failed":  inv_counts.get("FAILED", 0),
        },
    }


@router.get("/chargers")
async def list_chargers(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Todos los cargadores con su estado operativo para el mapa de monitoreo.
    `state`: charging | available | offline (offline = sin conexión OCPP viva)."""
    result = await db.execute(
        select(Charger).options(selectinload(Charger.owner)).order_by(Charger.id)
    )
    chargers = result.scalars().all()
    out = []
    for c in chargers:
        online = c.id in connected_chargers
        if not online:
            state = "offline"
        elif (c.status or "").lower() == "charging":
            state = "charging"
        else:
            state = "available"
        out.append({
            "id": c.id, "location": c.location, "lat": c.lat, "lng": c.lng,
            "owner": c.owner.name if c.owner else None,
            "status": c.status, "online": online, "state": state,
            "power_kw": c.power_kw, "connector": c.connector_type,
            "price_now": c.price_at(),
            "current_kwh": round(c.current_kwh, 2) if c.current_kwh is not None else None,
            "session_user": mask_email(c.session_user) if c.session_user else None,
            "last_seen": c.last_seen.isoformat() if c.last_seen else None,
        })
    return {
        "chargers": out,
        "counts": {
            "total": len(out),
            "online": sum(1 for x in out if x["online"]),
            "charging": sum(1 for x in out if x["state"] == "charging"),
            "offline": sum(1 for x in out if x["state"] == "offline"),
        },
    }


@router.get("/owners")
async def list_owners(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Dueños con su saldo (bolsa), estatus fiscal y nº de cargadores.
    El admin de Faro NO es dueño de cargadores → no aparece aquí."""
    result = await db.execute(select(User).where(User.role == "owner"))
    owners = result.scalars().all()
    out = []
    for o in owners:
        bal = await db.execute(
            select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
            .where(LedgerEntry.owner_id == o.id, LedgerEntry.account.is_(None))
        )
        n_ch = await db.execute(select(func.count(Charger.id)).where(Charger.owner_id == o.id))
        out.append({
            "id": o.id, "name": o.name, "email": o.email, "role": o.role,
            "rut": o.rut, "responsable_iva": o.responsable_iva,
            "kyc_ok": bool(o.rut),
            "balance_cop": int(bal.scalar() or 0) // 100,
            "chargers": int(n_ch.scalar() or 0),
            "subscription_active": o.subscription_active,
        })
    out.sort(key=lambda x: x["balance_cop"], reverse=True)
    return out


async def _owner_statement(db: AsyncSession, owner_id: str) -> dict:
    """Estado de cuenta del dueño a partir del ledger (todo en COP)."""
    async def s(*conds):
        r = await db.execute(select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
                             .where(LedgerEntry.owner_id == owner_id, *conds))
        return int(r.scalar() or 0) // 100
    earning      = await s(LedgerEntry.type == "EARNING")
    commission   = await s(LedgerEntry.type == "COMMISSION")     # negativo
    gateway      = await s(LedgerEntry.type == "GATEWAY")        # negativo
    subscription = await s(LedgerEntry.type == "SUBSCRIPTION")   # negativo
    disbursed    = await s(LedgerEntry.type == "DISBURSEMENT")   # negativo
    balance      = await s(LedgerEntry.account.is_(None))        # saldo neto actual
    return {
        "recaudado_cop": earning,
        "comision_cop": -commission,
        "pasarela_cop": -gateway,
        "mensualidad_cop": -subscription,
        "girado_cop": -disbursed,
        "saldo_cop": balance,
    }


@router.get("/owners/{owner_id}")
async def owner_detail(owner_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Detalle del dueño: estado de cuenta, datos fiscales, cuenta de dispersión,
    cargadores, facturas y pagos (dispersiones)."""
    o = await db.get(User, owner_id)
    if not o or o.role != "owner":
        raise HTTPException(404, "Dueño no encontrado")

    statement = await _owner_statement(db, owner_id)
    acc = (await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == owner_id))).scalar_one_or_none()
    chargers = (await db.execute(select(Charger).where(Charger.owner_id == owner_id).order_by(Charger.id))).scalars().all()

    current_period = datetime.now(BOGOTA).strftime("%Y-%m")
    sub_charged = (await db.execute(
        select(LedgerEntry.id).where(
            LedgerEntry.account == ACCT_FARO_REVENUE, LedgerEntry.type == "SUBSCRIPTION_INCOME",
            LedgerEntry.description.like(f"%[{current_period}]%{o.email}%"),
        )
    )).first() is not None
    has_card = await _owner_card(db, owner_id) is not None
    invoices = (await db.execute(
        select(Invoice).where(Invoice.owner_id == owner_id).order_by(Invoice.created_at.desc()).limit(50)
    )).scalars().all()
    disburses = (await db.execute(
        select(DisbursementRecord).where(DisbursementRecord.owner_id == owner_id).order_by(DisbursementRecord.created_at.desc()).limit(50)
    )).scalars().all()

    return {
        "id": o.id, "name": o.name, "email": o.email, "tag": o.tag,
        "rut": o.rut, "responsable_iva": o.responsable_iva, "kyc_ok": bool(o.rut),
        "statement": statement,
        "monthly_fee_cop": monthly_fee_cop(len(chargers)),   # mensualidad de plataforma
        "current_period": current_period,
        "subscription_charged": sub_charged,                 # ¿ya se cobró el mes actual?
        "subscription_active": o.subscription_active,        # ¿cargadores habilitados?
        "subscription_paid_until": o.subscription_paid_until.isoformat() if o.subscription_paid_until else None,
        "has_card": has_card,                                # ¿tiene tarjeta para cobrar?
        "disbursement_account": acc.to_dict() if acc else None,
        "chargers": [{"id": c.id, "location": c.location, "power_kw": c.power_kw,
                      "price": c.price_per_kwh, "online": c.id in connected_chargers} for c in chargers],
        "invoices": [i.to_dict() for i in invoices],
        "disbursements": [d.to_dict() for d in disburses],
    }


class DisburseBody(BaseModel):
    amount_cop: int | None = None   # None = pagar todo el saldo
    method: str = "MANUAL"          # MANUAL (por ahora) | WOMPI (futuro)
    note: str | None = None         # referencia: "Nequi 300..." / "Transf. Bancolombia #123"


@router.post("/owners/{owner_id}/disburse")
async def disburse_owner(owner_id: str, body: DisburseBody,
                         _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Registra un pago al dueño (modo MANUAL: tú transfieres y lo dejas registrado).
    Descuenta el saldo del ledger. El modo WOMPI (automático) se enchufa después."""
    o = await db.get(User, owner_id)
    if not o or o.role != "owner":
        raise HTTPException(404, "Dueño no encontrado")
    async with _settle_lock(owner_id):
        balance = await _owner_balance_cents(db, owner_id)
        amount = (body.amount_cop * 100) if body.amount_cop else balance
        if amount <= 0:
            raise HTTPException(400, "No hay saldo por pagar")
        if amount > balance:
            raise HTTPException(400, f"El monto supera el saldo disponible (${balance // 100:,} COP)")
        record = DisbursementRecord(owner_id=owner_id, amount_cents=amount,
                                    status="SENT", method=body.method, note=body.note)
        db.add(record)
        await db.flush()
        db.add(LedgerEntry(owner_id=owner_id, disbursement_id=record.id, type="DISBURSEMENT",
                           amount_cents=-amount, description=f"Pago {body.method}" + (f" — {body.note}" if body.note else "")))
        _notify_owner(db, owner_id, "SETTLEMENT_SENT",
                      f"Te pagamos ${amount // 100:,} COP" + (f" ({body.note})" if body.note else ""))
        await db.commit()
    return {"ok": True, "amount_cop": amount // 100, "new_balance_cop": (balance - amount) // 100}


class ChargeSubscriptionBody(BaseModel):
    period: str | None = None   # "YYYY-MM"; None = mes actual (Bogotá)


@router.post("/owners/{owner_id}/charge-subscription")
async def charge_subscription(owner_id: str, body: ChargeSubscriptionBody,
                              _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Cobra la mensualidad de plataforma a la TARJETA del dueño (Wompi).
    APROBADA → activa sus cargadores hasta el próximo mes. RECHAZADA → los suspende.
    El cobro, las bolsas y la factura los maneja engine.bill_owner_subscription."""
    o = await db.get(User, owner_id)
    if not o or o.role != "owner":
        raise HTTPException(404, "Dueño no encontrado")
    async with _settle_lock(owner_id):
        return await bill_owner_subscription(db, o, body.period)


class SubscriptionStatusBody(BaseModel):
    active: bool   # True = reactivar manualmente; False = rechazar/suspender manualmente


@router.post("/owners/{owner_id}/subscription-status")
async def set_subscription_status(owner_id: str, body: SubscriptionStatusBody,
                                  _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Activa/suspende manualmente al dueño (sin cobrar). Suspender oculta y bloquea
    sus cargadores; reactivar los vuelve a habilitar hasta la próxima mensualidad."""
    o = await db.get(User, owner_id)
    if not o or o.role != "owner":
        raise HTTPException(404, "Dueño no encontrado")
    o.subscription_active = body.active
    await db.commit()
    return {"ok": True, "subscription_active": o.subscription_active}


@router.get("/commissions")
async def commissions(period: str = "month", _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Comisión de Faro (ingreso) por periodo, total y por dueño."""
    now = datetime.now(BOGOTA)
    since = None
    if period == "today":   since = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":  since = now - timedelta(days=7)
    elif period == "month": since = now - timedelta(days=30)

    q = select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0)).where(LedgerEntry.account == ACCT_FARO_REVENUE)
    if since: q = q.where(LedgerEntry.created_at >= since)
    total = int((await db.execute(q)).scalar() or 0)

    # Por dueño: la comisión que se le descontó (type COMMISSION, negativo)
    qd = (select(LedgerEntry.owner_id, func.coalesce(func.sum(LedgerEntry.amount_cents), 0))
          .where(LedgerEntry.type == "COMMISSION").group_by(LedgerEntry.owner_id))
    if since: qd = qd.where(LedgerEntry.created_at >= since)
    rows = (await db.execute(qd)).all()
    by_owner = []
    for oid, amt in rows:
        o = await db.get(User, oid) if oid else None
        by_owner.append({"owner": o.name if o else "—", "owner_id": oid, "commission_cop": -int(amt) // 100})
    by_owner.sort(key=lambda x: x["commission_cop"], reverse=True)
    return {"period": period, "total_cop": total // 100, "by_owner": by_owner}


# ── Wallet (saldo de conductores) ─────────────────────────────────────────────

class WalletCreditBody(BaseModel):
    amount_cop: int            # positivo = abono/bono; negativo = ajuste
    note: str | None = None


@router.post("/users/{user_id}/wallet-credit")
async def wallet_credit(user_id: str, body: WalletCreditBody,
                        _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Abona (bono de bienvenida) o ajusta el saldo de un conductor."""
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    if body.amount_cop == 0:
        raise HTTPException(400, "El monto no puede ser 0")
    db.add(WalletTransaction(user_id=user_id, type="BONUS", amount_cents=body.amount_cop * 100,
                            description=body.note or "Crédito de Faro"))
    await db.commit()
    bal = await _wallet_balance_cents(db, user_id)
    return {"ok": True, "balance_cop": bal // 100}


class RefundBody(BaseModel):
    note: str | None = None   # referencia del pago: "Nequi 300..." / "Transf. #123"


@router.post("/users/{user_id}/refund")
async def refund_wallet(user_id: str, body: RefundBody,
                        _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Procesa la devolución del saldo reembolsable (solo dinero propio del conductor,
    menos el costo de procesamiento; los bonos no se devuelven). Modo MANUAL: tú haces
    la transferencia y aquí se registra el débito en el wallet (REFUND)."""
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    refundable = await _refundable_cents(db, user_id)
    if refundable <= 0:
        raise HTTPException(400, "Este usuario no tiene saldo reembolsable")
    db.add(WalletTransaction(user_id=user_id, type="REFUND", amount_cents=-refundable,
                            description="Devolución de saldo" + (f" — {body.note}" if body.note else "")))
    await db.commit()
    bal = await _wallet_balance_cents(db, user_id)
    return {"ok": True, "refunded_cop": refundable // 100, "balance_cop": bal // 100}


# ── Usuarios ──────────────────────────────────────────────────────────────────

async def _user_footprint(db: AsyncSession, user_id: str) -> dict:
    """Cuenta referencias financieras/operativas de un usuario (para borrar seguro)."""
    async def n(model, col):
        r = await db.execute(select(func.count()).select_from(model).where(col == user_id))
        return int(r.scalar() or 0)
    return {
        "chargers":      await n(Charger, Charger.owner_id),
        "transactions":  await n(PaymentTransaction, PaymentTransaction.user_id),
        "disbursements": await n(DisbursementRecord, DisbursementRecord.owner_id),
        "ledger":        await n(LedgerEntry, LedgerEntry.owner_id),
    }


@router.get("/users")
async def list_users(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Todos los usuarios con su estado de verificación (para auditar y limpiar)."""
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    out = []
    for u in result.scalars().all():
        wallet = await _wallet_balance_cents(db, u.id) if u.role == "conductor" else 0
        out.append({
            "id": u.id, "name": u.name, "email": u.email, "role": u.role,
            "email_verified": u.email_verified,
            "wallet_cop": wallet // 100,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        })
    return out


@router.get("/users/{user_id}")
async def user_detail(user_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Resumen e historial de un usuario (para el back-office)."""
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    data = {
        "id": u.id, "name": u.name, "email": u.email, "role": u.role, "tag": u.tag,
        "email_verified": u.email_verified,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }

    if u.role == "conductor":
        wallet = await _wallet_balance_cents(db, u.id)
        sess = (await db.execute(
            select(Session).where(Session.session_user == u.email)
            .order_by(Session.ended_at.desc().nullslast(), Session.id.desc())
        )).scalars().all()
        spent = sum(int(s.total_charged or 0) for s in sess)
        kwh   = sum(float(s.kwh_delivered or 0) for s in sess)
        wtx = (await db.execute(
            select(WalletTransaction).where(WalletTransaction.user_id == u.id)
            .order_by(WalletTransaction.created_at.desc()).limit(20)
        )).scalars().all()
        data["conductor"] = {
            "wallet_cop": wallet // 100,
            "refundable_cop": (await _refundable_cents(db, u.id)) // 100,
            "sessions_total": len(sess),
            "kwh_total": round(kwh, 2),
            "spent_total_cop": spent,
            "sessions": [{
                "charger_id": s.charger_id,
                "kwh": round(float(s.kwh_delivered or 0), 2),
                "cost_cop": int(s.total_charged or 0),
                "ended_at": s.ended_at.isoformat() if s.ended_at else None,
            } for s in sess[:20]],
            "wallet_tx": [{
                "type": t.type,
                "amount_cop": int(t.amount_cents or 0) // 100,
                "description": t.description,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            } for t in wtx],
        }
    elif u.role == "owner":
        chargers = (await db.execute(select(Charger).where(Charger.owner_id == u.id))).scalars().all()
        balance = await _owner_balance_cents(db, u.id)
        data["owner"] = {
            "subscription_active": u.subscription_active,
            "subscription_paid_until": u.subscription_paid_until.isoformat() if u.subscription_paid_until else None,
            "chargers_total": len(chargers),
            "balance_cop": balance // 100,
            "monthly_fee_cop": monthly_fee_cop(len(chargers)),
        }
    return data


async def _delete_user_clean(db: AsyncSession, u: User):
    """Borra un usuario y sus filas hijas NO financieras (tarjetas, cuenta de
    dispersión, eventos, reservas). Asume que ya se verificó que no tiene huella."""
    from sqlalchemy import delete as _del
    await db.execute(_del(PaymentMethod).where(PaymentMethod.user_id == u.id))
    await db.execute(_del(DisbursementAccount).where(DisbursementAccount.user_id == u.id))
    await db.execute(_del(OwnerEvent).where(OwnerEvent.owner_id == u.id))
    await db.execute(_del(Reservation).where(Reservation.user_id == u.id))
    await db.delete(u)


@router.post("/users/cleanup-unverified")
async def cleanup_unverified(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Borra los usuarios SIN correo verificado, excepto admins y los que tengan
    huella financiera (cargadores, cobros, ledger, dispersiones) — esos se reportan
    como omitidos para revisión manual."""
    result = await db.execute(
        select(User).where(User.email_verified.is_(False), User.role != "admin")
    )
    candidates = result.scalars().all()
    deleted, skipped = [], []
    for u in candidates:
        fp = await _user_footprint(db, u.id)
        if any(fp.values()):
            skipped.append({"email": u.email, "reason": "tiene actividad", "footprint": fp})
            continue
        await _delete_user_clean(db, u)
        deleted.append(u.email)
    await db.commit()
    return {"deleted_count": len(deleted), "deleted": deleted, "skipped": skipped}


@router.post("/users/{user_id}/verify")
async def verify_user(user_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Marca un usuario como verificado a mano (p. ej. un dueño de confianza)."""
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    u.email_verified = True
    u.email_verify_token = None
    await db.commit()
    return {"ok": True, "email": u.email, "email_verified": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Borra un usuario puntual (no admin, sin huella financiera)."""
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    if u.role == "admin":
        raise HTTPException(400, "No se puede borrar un administrador")
    fp = await _user_footprint(db, u.id)
    if any(fp.values()):
        raise HTTPException(400, f"El usuario tiene actividad y no se puede borrar: {fp}")
    await _delete_user_clean(db, u)
    await db.commit()
    return {"ok": True, "deleted": u.email}


@router.get("/invoices")
async def list_invoices(status: str | None = None, kind: str | None = None,
                        owner_id: str | None = None, limit: int = 100,
                        _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Facturas, filtrables por estado (PENDING/ISSUED/FAILED), tipo (RECARGA/
    COMMISSION/SUBSCRIPTION) y dueño."""
    q = select(Invoice).order_by(Invoice.created_at.desc()).limit(min(limit, 500))
    if status:   q = q.where(Invoice.status == status.upper())
    if kind:     q = q.where(Invoice.kind == kind.upper())
    if owner_id: q = q.where(Invoice.owner_id == owner_id)
    result = await db.execute(q)
    return [inv.to_dict() | {"attempts": inv.attempts, "last_error": inv.last_error,
                             "provider": inv.provider} for inv in result.scalars().all()]


@router.post("/invoices/{invoice_id}/retry")
async def retry_invoice(invoice_id: str, _: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    """Reencola una factura fallida/pendiente — el worker la reintenta enseguida."""
    inv = await db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(404, "Factura no encontrada")
    if inv.status == "ISSUED":
        raise HTTPException(400, "La factura ya fue emitida")
    inv.status = "PENDING"
    inv.attempts = 0
    inv.last_error = None
    await db.commit()
    return {"ok": True, "id": inv.id, "status": inv.status}


# ── INGENIERÍA: catálogo de modelos de cargador (ChargerBrandProfile) ──────────
# El admin mantiene aquí las referencias que el dueño elige al enlazar un cargador.
import re as _re_model

class BrandProfileBody(BaseModel):
    id: str | None = None                 # "wallbox-pulsar-plus"; si falta se genera del display_name
    vendor: str
    model: str | None = None
    display_name: str
    ocpp_version: str = "1.6J"
    connector_types: list[str] = []
    max_power_kw: float | None = None
    description: str | None = None
    recommendations: str | None = None
    setup_guide_md: str | None = None

def _slug(s: str) -> str:
    return _re_model.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')[:40] or secrets.token_hex(4)

@router.get("/brand-profiles")
async def admin_list_brand_profiles(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ChargerBrandProfile).order_by(ChargerBrandProfile.display_name))).scalars().all()
    return {"profiles": [p.to_dict() for p in rows]}

@router.post("/brand-profiles")
async def admin_create_brand_profile(body: BrandProfileBody, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    pid = body.id or _slug(body.display_name)
    if await db.get(ChargerBrandProfile, pid):
        raise HTTPException(409, f"Ya existe un modelo con id '{pid}'")
    bp = ChargerBrandProfile(
        id=pid, vendor=body.vendor, model=body.model, display_name=body.display_name,
        ocpp_version=body.ocpp_version, connector_types=json.dumps(body.connector_types),
        max_power_kw=body.max_power_kw, description=body.description,
        recommendations=body.recommendations, setup_guide_md=body.setup_guide_md,
    )
    db.add(bp)
    await db.commit()
    return bp.to_dict()

@router.patch("/brand-profiles/{pid}")
async def admin_update_brand_profile(pid: str, body: BrandProfileBody, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    bp = await db.get(ChargerBrandProfile, pid)
    if not bp:
        raise HTTPException(404, "Modelo no encontrado")
    bp.vendor = body.vendor; bp.model = body.model; bp.display_name = body.display_name
    bp.ocpp_version = body.ocpp_version; bp.connector_types = json.dumps(body.connector_types)
    bp.max_power_kw = body.max_power_kw; bp.description = body.description
    bp.recommendations = body.recommendations; bp.setup_guide_md = body.setup_guide_md
    await db.commit()
    return bp.to_dict()

@router.delete("/brand-profiles/{pid}")
async def admin_delete_brand_profile(pid: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    bp = await db.get(ChargerBrandProfile, pid)
    if not bp:
        raise HTTPException(404, "Modelo no encontrado")
    in_use = (await db.execute(select(func.count(Charger.id)).where(Charger.brand_profile_id == pid))).scalar()
    if in_use:
        raise HTTPException(400, f"No se puede borrar: {in_use} cargador(es) usan este modelo")
    await db.delete(bp)
    await db.commit()
    return {"ok": True}

_MODEL_MAX_PHOTOS = 2
_MODEL_PHOTO_EXT  = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

@router.post("/brand-profiles/{pid}/photos")
async def admin_add_model_photo(pid: str, file: UploadFile = File(...), _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    bp = await db.get(ChargerBrandProfile, pid)
    if not bp:
        raise HTTPException(404, "Modelo no encontrado")
    existing = (await db.execute(select(ChargerModelPhoto).where(ChargerModelPhoto.model_id == pid))).scalars().all()
    if len(existing) >= _MODEL_MAX_PHOTOS:
        raise HTTPException(400, f"Máximo {_MODEL_MAX_PHOTOS} fotos por modelo")
    ct = (file.content_type or "").lower()
    if ct not in _MODEL_PHOTO_EXT:
        raise HTTPException(400, "Formato no soportado (JPG, PNG o WEBP)")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(400, "La foto es muy pesada (máx 8 MB)")
    photo_id = secrets.token_hex(8)
    key = f"model-photos/{pid}/{photo_id}.{_MODEL_PHOTO_EXT[ct]}"
    storage.put_bytes(key, data, ct)
    photo = ChargerModelPhoto(id=photo_id, model_id=pid, storage_key=key, content_type=ct)
    db.add(photo)
    await db.commit()
    return photo.to_dict()

@router.delete("/brand-profiles/{pid}/photos/{photo_id}")
async def admin_delete_model_photo(pid: str, photo_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    photo = await db.get(ChargerModelPhoto, photo_id)
    if not photo or photo.model_id != pid:
        raise HTTPException(404, "Foto no encontrada")
    await db.delete(photo)
    await db.commit()
    return {"ok": True}
