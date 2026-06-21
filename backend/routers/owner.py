import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, Response
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from ocpp.v16 import call
from ocpp.v16.enums import AvailabilityType

from database import get_db, AsyncSessionLocal
from models import (User, Charger, Session, Reservation, PaymentMethod,
                    DisbursementAccount, PaymentTransaction, DisbursementRecord,
                    PendingCharge, LedgerEntry, ChargerBrandProfile, OwnerEvent)
from auth import get_current_user, hash_password, verify_password, create_token
import wompi as wompi_svc
import sim as sim_mgr
from config import *
from state import connected_chargers
from engine import (_finalize_session, _settle_captured, _owner_balance_cents,
                    _settle_owner, _settle_lock, _period_start_utc, _next_settlement_date,
                    _PERIOD_HOURS, calc_preauth_cop, ChargePoint, WebSocketAdapter,
                    _mark_offline_after_grace)

logger = logging.getLogger(__name__)
router = APIRouter()

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

@router.post("/disbursement-account")
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

@router.get("/disbursement-account")
async def get_disbursement_account(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(DisbursementAccount).where(DisbursementAccount.user_id == current_user.id))
    acc = result.scalar_one_or_none()
    return acc.to_dict() if acc else None

@router.post("/disbursement-account/verify")
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



@router.get("/my-earnings")
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

    items = [s.to_dict() for s in sessions]

    # Separaciones cobradas (multa/cuota) — viven en el ledger, no como Session.
    # Las incluimos para que aparezcan en "Últimas sesiones".
    resv = (await db.execute(
        select(LedgerEntry).where(
            LedgerEntry.owner_id == current_user.id,
            LedgerEntry.type == "EARNING",
            LedgerEntry.session_id.is_(None),
        ).order_by(LedgerEntry.created_at.desc()).limit(50)
    )).scalars().all()
    for le in resv:
        cop = int(le.amount_cents or 0) // 100
        items.append({
            "id": f"resv-{le.id}", "kind": "reservation",
            "charger_id": "Separación", "location": le.description or "Separación",
            "kwh_delivered": 0, "electricity_cost": 0,
            "revenue_owner": cop, "net_profit_owner": cop, "total_charged": cop,
            "session_user": None,
            "started_at": None,
            "ended_at": le.created_at.isoformat() if le.created_at else None,
        })
    items.sort(key=lambda x: x.get("ended_at") or "", reverse=True)

    return {
        "margin": PLATFORM_MARGIN,
        "total_revenue_cop":    round(total_revenue),
        "total_electricity_cop": round(total_elec),
        "total_commission_cop": round(total_commission),
        "total_net_profit_cop": round(total_net),
        "total_kwh":            round(total_kwh, 2),
        "total_sessions":       len(items),
        "sessions":             items,
    }


# ── SALDO Y RETIROS DEL DUEÑO ────────────────────────────────────────────────

@router.get("/my-balance")
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


@router.post("/my-balance/withdraw")
async def withdraw_balance(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")
    async with _settle_lock(current_user.id):
        result = await _settle_owner(db, current_user.id, min_cop=MIN_WITHDRAW_COP)
        if not result["ok"]:
            raise HTTPException(400, result["reason"])
        await db.commit()
    return result



@router.get("/my-stats")
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

    # Serie de los últimos 7 días (hora Bogotá) para la gráfica de barras
    seven_start = (datetime.now(BOGOTA) - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    week_r = await db.execute(
        select(Session)
        .join(Charger)
        .where(Charger.owner_id == current_user.id, Session.ended_at >= seven_start.astimezone(timezone.utc))
    )
    days = {}
    for i in range(7):
        d = (seven_start + timedelta(days=i)).date().isoformat()
        days[d] = {"date": d, "kwh": 0.0, "net_cop": 0, "sessions": 0}
    for s in week_r.scalars().all():
        d = s.ended_at.astimezone(BOGOTA).date().isoformat()
        if d in days:
            days[d]["kwh"]      += s.kwh_delivered
            days[d]["net_cop"]  += int(s.net_profit_owner)
            days[d]["sessions"] += 1
    last_7_days = [{**v, "kwh": round(v["kwh"], 2)} for v in days.values()]

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
        "last_7_days": last_7_days,
    }


# ── ALERTAS DEL DUEÑO ────────────────────────────────────────────────────────

@router.get("/my-events")
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


@router.get("/my-subscription")
async def my_subscription(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Estado de la mensualidad de plataforma del dueño (para mostrar en la app)."""
    n = int((await db.execute(
        select(func.count(Charger.id)).where(Charger.owner_id == current_user.id)
    )).scalar() or 0)
    card = (await db.execute(
        select(PaymentMethod).where(
            PaymentMethod.user_id == current_user.id,
            PaymentMethod.wompi_payment_source_id.isnot(None),
        ).limit(1)
    )).scalars().first()
    return {
        "active": current_user.subscription_active,
        "paid_until": current_user.subscription_paid_until.isoformat() if current_user.subscription_paid_until else None,
        "chargers": n,
        "monthly_fee_cop": monthly_fee_cop(n),
        "has_card": card is not None,
    }


@router.post("/my-events/read")
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

@router.get("/my-earnings/export")
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

@router.get("/my-disbursements")
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

@router.get("/admin/summary")
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
