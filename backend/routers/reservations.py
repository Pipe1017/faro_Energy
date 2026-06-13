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

class ReserveBody(BaseModel):
    minutes: int = 60  # duración de la reserva en minutos


@router.post("/reserve/{charge_point_id}")
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


@router.delete("/reserve/{reservation_id}")
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


@router.get("/my-reservations")
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


@router.get("/my-chargers/reservations")
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

