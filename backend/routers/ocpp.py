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

from core.database import get_db, AsyncSessionLocal
from models import (User, Charger, Session, Reservation, PaymentMethod,
                    DisbursementAccount, PaymentTransaction, DisbursementRecord,
                    PendingCharge, LedgerEntry, ChargerBrandProfile, OwnerEvent)
from core.auth import get_current_user, hash_password, verify_password, create_token
import services.wompi as wompi_svc
import services.sim as sim_mgr
from core.config import *
from core.state import connected_chargers
from services.engine import (_finalize_session, _settle_captured, _owner_balance_cents,
                    _settle_owner, _settle_lock, _period_start_utc, _next_settlement_date,
                    _PERIOD_HOURS, calc_preauth_cop, ChargePoint, WebSocketAdapter,
                    _mark_offline_after_grace)

logger = logging.getLogger(__name__)
router = APIRouter()

@router.websocket("/ocpp/{charge_point_id}")
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

