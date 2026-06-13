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


@router.post("/auth/register")
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


@router.post("/auth/login")
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


@router.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)):
    return _user_dict(current_user)


def _user_dict(user: User) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}

