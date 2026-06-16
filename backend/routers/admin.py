"""Back-office del CPO (rol admin): conciliación de las bolsas, facturas y dueños.

Pensado para la web de administración (no para la app móvil). Solo lectura +
acciones operativas puntuales (reintentar una factura). El control financiero del
Modelo A vive aquí: ingreso de Faro, IVA por girar a la DIAN y deuda con dueños.
"""
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (User, Charger, Session, Invoice, LedgerEntry, PaymentTransaction,
                    PaymentMethod, DisbursementAccount, DisbursementRecord, OwnerEvent,
                    Reservation, mask_email)
from auth import get_current_user, SECRET_KEY, ALGORITHM
from config import ACCT_FARO_REVENUE, ACCT_FARO_IVA, BOGOTA, MIN_WITHDRAW_COP
from engine import _faro_balance_cents, _owner_balance_cents, _settle_lock, _notify_owner
from state import connected_chargers
import storage

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
        import invoicing
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
    faro_revenue = await _faro_balance_cents(db, ACCT_FARO_REVENUE)
    iva_to_dian  = await _faro_balance_cents(db, ACCT_FARO_IVA)

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
            "faro_revenue_cop":  _cop(faro_revenue),
            "iva_to_dian_cop":   _cop(iva_to_dian),
            "owed_to_owners_cop": _cop(owed_to_owners),
            "collected_cop":     _cop(int(collected.scalar() or 0)),
            "disbursed_cop":     _cop(abs(int(disbursed.scalar() or 0))),
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
        out.append({
            "id": u.id, "name": u.name, "email": u.email, "role": u.role,
            "email_verified": u.email_verified,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        })
    return out


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
