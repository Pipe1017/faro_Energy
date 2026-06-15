"""Back-office del CPO (rol admin): conciliación de las bolsas, facturas y dueños.

Pensado para la web de administración (no para la app móvil). Solo lectura +
acciones operativas puntuales (reintentar una factura). El control financiero del
Modelo A vive aquí: ingreso de Faro, IVA por girar a la DIAN y deuda con dueños.
"""
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User, Charger, Session, Invoice, LedgerEntry, PaymentTransaction
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
