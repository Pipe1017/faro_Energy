"""Back-office del CPO (rol admin): conciliación de las bolsas, facturas y dueños.

Pensado para la web de administración (no para la app móvil). Solo lectura +
acciones operativas puntuales (reintentar una factura). El control financiero del
Modelo A vive aquí: ingreso de Faro, IVA por girar a la DIAN y deuda con dueños.
"""
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (User, Charger, Session, Invoice, LedgerEntry, PaymentTransaction,
                    PaymentMethod, DisbursementAccount, DisbursementRecord, OwnerEvent,
                    Reservation, mask_email)
from auth import get_current_user
from config import ACCT_FARO_REVENUE, ACCT_FARO_IVA, BOGOTA
from engine import _faro_balance_cents
from state import connected_chargers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin")


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(403, "Solo administradores")
    return current_user


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
    """Dueños con su saldo (bolsa), estatus fiscal y nº de cargadores."""
    result = await db.execute(select(User).where(User.role.in_(["owner", "admin"])))
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
async def list_invoices(status: str | None = None, limit: int = 100,
                        _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Facturas, opcionalmente filtradas por estado (PENDING/ISSUED/FAILED)."""
    q = select(Invoice).order_by(Invoice.created_at.desc()).limit(min(limit, 500))
    if status:
        q = q.where(Invoice.status == status.upper())
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
