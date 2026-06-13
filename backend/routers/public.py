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

@router.get("/status")
async def get_status(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Charger).options(selectinload(Charger.owner)).order_by(Charger.id))
    chargers = result.scalars().all()
    return {
        "connected": list(connected_chargers.keys()),
        "total": len(chargers),
        "chargers": {c.id: c.to_dict(public=True) for c in chargers},
    }


@router.get("/status/{charge_point_id}")
async def get_charger(charge_point_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Charger).where(Charger.id == charge_point_id).options(selectinload(Charger.owner))
    )
    charger = result.scalar_one_or_none()
    if not charger:
        return {"error": "No encontrado"}
    return charger.to_dict(public=True)



@router.get("/config/public")
async def public_config():
    """Config para el cliente: la llave pública de Wompi es pública por diseño —
    la app la usa para tokenizar la tarjeta directo contra Wompi (PCI)."""
    return {
        "wompi_api": wompi_svc.BASE_URL,
        "wompi_public_key": os.getenv("WOMPI_PUBLIC_KEY", ""),
    }

