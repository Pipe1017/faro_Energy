import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, Response, Form, UploadFile, File
from fastapi.responses import HTMLResponse
from services import storage
from pydantic import BaseModel
from services import emailer
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

class RegisterBody(BaseModel):
    email: str
    name: str
    password: str
    role: str  # "conductor" | "owner"
    accept_terms: bool = False   # Habeas Data: debe aceptar T&C + Privacidad


class LoginBody(BaseModel):
    email: str
    password: str
    role: str | None = None   # desambigua si el correo tiene cuenta de conductor y de dueño


class ResendBody(BaseModel):
    email: str
    role: str | None = None


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
    if not body.accept_terms:
        raise HTTPException(400, "Debes aceptar los Términos y la Política de Privacidad")
    if len(body.password) < 6:
        raise HTTPException(400, "La contraseña debe tener al menos 6 caracteres")
    email = body.email.lower().strip()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "Email inválido")
    # Único por (email, rol): permite una cuenta de conductor y otra de dueño con el mismo correo
    result = await db.execute(select(User).where(User.email == email, User.role == body.role))
    if result.scalar_one_or_none():
        rol = "conductor" if body.role == "conductor" else "dueño"
        raise HTTPException(400, f"Ya existe una cuenta de {rol} con ese correo")
    token = secrets.token_urlsafe(32)
    user = User(email=email, name=body.name,
                password_hash=hash_password(body.password), role=body.role,
                email_verified=False, email_verify_token=token,
                terms_accepted_at=datetime.now(timezone.utc), terms_version=TERMS_VERSION)
    db.add(user)
    await db.commit()
    # NO devolvemos token: el usuario debe CONFIRMAR su correo antes de poder entrar.
    subject, html, text = emailer.verification_email(user.name, token)
    asyncio.create_task(emailer.send_email(user.email, subject, html, text))
    return {"needs_verification": True, "email": user.email, "role": user.role}


@router.get("/auth/verify", response_class=HTMLResponse)
async def verify_email(token: str, db: AsyncSession = Depends(get_db)):
    """Abierto desde el link del correo. Marca el email como verificado."""
    result = await db.execute(select(User).where(User.email_verify_token == token))
    user = result.scalar_one_or_none()
    if not user:
        return HTMLResponse(_verify_page("Enlace inválido o ya usado",
                            "Pide un nuevo correo de verificación desde la app."), status_code=400)
    user.email_verified = True
    user.email_verify_token = None
    await db.commit()
    return HTMLResponse(_verify_page("¡Correo confirmado!",
                        f"Listo {user.name}, ya puedes usar Faro Energy."))


@router.post("/auth/resend-verification")
async def resend_verification(body: ResendBody, db: AsyncSession = Depends(get_db)):
    """Público: reenvía el correo de verificación. Devuelve ok siempre (no revela
    si el correo existe). Útil para el botón 'Reenviar' tras el registro."""
    email = body.email.lower().strip()
    q = select(User).where(User.email == email, User.email_verified.is_(False))
    if body.role:
        q = q.where(User.role == body.role)
    users = (await db.execute(q)).scalars().all()
    for user in users:
        user.email_verify_token = secrets.token_urlsafe(32)
        await db.flush()
        subject, html, text = emailer.verification_email(user.name, user.email_verify_token)
        asyncio.create_task(emailer.send_email(user.email, subject, html, text))
    await db.commit()
    return {"ok": True}


# ── RESTABLECER CONTRASEÑA ────────────────────────────────────────────────────

class ForgotBody(BaseModel):
    email: str
    role: str | None = None


@router.post("/auth/forgot-password")
async def forgot_password(body: ForgotBody, db: AsyncSession = Depends(get_db)):
    """Público: envía un enlace para restablecer la contraseña. Devuelve ok SIEMPRE
    (no revela si el correo existe). El enlace vence en 1 hora."""
    email = body.email.lower().strip()
    q = select(User).where(User.email == email)
    if body.role:
        q = q.where(User.role == body.role)
    users = (await db.execute(q)).scalars().all()
    for user in users:
        user.reset_token = secrets.token_urlsafe(32)
        user.reset_expires = datetime.now(timezone.utc) + timedelta(hours=1)
        await db.flush()
        subject, html, text = emailer.reset_password_email(user.name, user.reset_token)
        asyncio.create_task(emailer.send_email(user.email, subject, html, text))
    await db.commit()
    return {"ok": True}


@router.get("/auth/reset", response_class=HTMLResponse)
async def reset_form(token: str, db: AsyncSession = Depends(get_db)):
    """Página (abierta desde el correo) con el formulario de nueva contraseña."""
    result = await db.execute(select(User).where(User.reset_token == token))
    user = result.scalar_one_or_none()
    if not user or not user.reset_expires or user.reset_expires < datetime.now(timezone.utc):
        return HTMLResponse(_verify_page("Enlace inválido o vencido",
                            "Solicita un nuevo enlace desde la app."), status_code=400)
    return HTMLResponse(_reset_page(token))


@router.post("/auth/reset-password", response_class=HTMLResponse)
async def reset_password(token: str = Form(...), password: str = Form(...),
                         db: AsyncSession = Depends(get_db)):
    """Recibe la nueva contraseña del formulario y la guarda si el token es válido."""
    if len(password) < 6:
        return HTMLResponse(_reset_page(token, "La contraseña debe tener al menos 6 caracteres"), status_code=400)
    result = await db.execute(select(User).where(User.reset_token == token))
    user = result.scalar_one_or_none()
    if not user or not user.reset_expires or user.reset_expires < datetime.now(timezone.utc):
        return HTMLResponse(_verify_page("Enlace inválido o vencido",
                            "Solicita un nuevo enlace desde la app."), status_code=400)
    user.password_hash = hash_password(password)
    user.reset_token = None
    user.reset_expires = None
    await db.commit()
    return HTMLResponse(_verify_page("¡Contraseña actualizada!",
                        "Ya puedes volver a la app e iniciar sesión con tu nueva contraseña."))


def _reset_page(token: str, error: str = "") -> str:
    err = f'<div style="color:#b91c1c;font-size:13px;margin-bottom:10px;">{error}</div>' if error else ""
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Nueva contraseña · Faro Energy</title></head>
<body style="margin:0;background:#fdfbf7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;
display:grid;place-items:center;min-height:100vh;color:#2e2620;">
<form method="post" action="/auth/reset-password" style="background:#fff;border:1px solid #ece5dc;border-radius:16px;padding:36px;max-width:380px;width:90%;text-align:center;">
<div style="font-size:24px;font-weight:800;">Faro <span style="color:#b45309;">Energy</span></div>
<div style="font-size:19px;font-weight:700;margin:18px 0 14px;">Crea tu nueva contraseña</div>
{err}
<input type="hidden" name="token" value="{token}">
<input type="password" name="password" placeholder="Nueva contraseña (mín. 6)" required minlength="6"
 style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #e7dfd0;border-radius:10px;font-size:15px;margin-bottom:14px;">
<button type="submit" style="width:100%;padding:12px;border:none;border-radius:10px;background:#b45309;color:#fff;font-size:15px;font-weight:700;cursor:pointer;">Guardar contraseña</button>
</form></body></html>"""


def _verify_page(title: str, msg: str) -> str:
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title></head>
<body style="margin:0;background:#fdfbf7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;
display:grid;place-items:center;min-height:100vh;color:#2e2620;">
<div style="background:#fff;border:1px solid #ece5dc;border-radius:16px;padding:36px;max-width:380px;text-align:center;">
<div style="font-size:24px;font-weight:800;">Faro <span style="color:#b45309;">Energy</span></div>
<div style="font-size:19px;font-weight:700;margin:18px 0 8px;">{title}</div>
<div style="color:#8a7d72;font-size:15px;line-height:1.5;">{msg}</div></div></body></html>"""


@router.post("/auth/login")
async def login(body: LoginBody, request: Request, db: AsyncSession = Depends(get_db)):
    key = _login_rate_key(request, body.email)
    _check_login_rate(key)
    email = body.email.lower().strip()
    q = select(User).where(User.email == email)
    if body.role:
        q = q.where(User.role == body.role)
    users = (await db.execute(q)).scalars().all()
    if len(users) > 1:
        # Mismo correo con cuenta de conductor y de dueño: la app debe mandar el rol
        raise HTTPException(409, "Este correo tiene cuenta de conductor y de dueño. Indica con cuál entrar.")
    user = users[0] if users else None
    if not user or not verify_password(body.password, user.password_hash):
        _login_attempts[key].append(_time.monotonic())
        raise HTTPException(401, "Credenciales incorrectas")
    _login_attempts.pop(key, None)   # login exitoso limpia el contador
    # Sin correo verificado no se entra. Reenviamos el enlace para no dejar al
    # usuario atascado (la clave ya fue correcta, así que no es fuga de info).
    if REQUIRE_EMAIL_VERIFICATION and not user.email_verified:
        if not user.email_verify_token:
            user.email_verify_token = secrets.token_urlsafe(32)
            await db.commit()
        subject, html, text = emailer.verification_email(user.name, user.email_verify_token)
        asyncio.create_task(emailer.send_email(user.email, subject, html, text))
        raise HTTPException(403, "Confirma tu correo para entrar. Te reenviamos el enlace de verificación.")
    return {"token": create_token(user.id, user.role), "user": _user_dict(user)}


@router.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)):
    return _user_dict(current_user)


def _user_dict(user: User) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role,
            "email_verified": user.email_verified,
            "avatar_url": f"/profile/avatar/{user.id}" if user.avatar_key else None}


# ── PERFIL ────────────────────────────────────────────────────────────────────
class UpdateProfileBody(BaseModel):
    name: str

@router.patch("/auth/me")
async def update_profile(body: UpdateProfileBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    name = (body.name or "").strip()
    if len(name) < 2:
        raise HTTPException(400, "El nombre es muy corto")
    current_user.name = name
    await db.commit()
    return _user_dict(current_user)


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str

@router.post("/auth/change-password")
async def change_password(body: ChangePasswordBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(400, "La contraseña actual no es correcta")
    if len(body.new_password) < 6:
        raise HTTPException(400, "La nueva contraseña debe tener al menos 6 caracteres")
    current_user.password_hash = hash_password(body.new_password)
    await db.commit()
    return {"ok": True}


_AVATAR_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

@router.post("/auth/avatar")
async def upload_avatar(file: UploadFile = File(...), current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ct = (file.content_type or "").lower()
    if ct not in _AVATAR_EXT:
        raise HTTPException(400, "Formato no soportado (JPG, PNG o WEBP)")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > 6 * 1024 * 1024:
        raise HTTPException(400, "La imagen es muy pesada (máx 6 MB)")
    key = f"avatars/{current_user.id}.{_AVATAR_EXT[ct]}"
    storage.put_bytes(key, data, ct)
    current_user.avatar_key = key
    await db.commit()
    return _user_dict(current_user)


@router.delete("/auth/avatar")
async def delete_avatar(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    current_user.avatar_key = None
    await db.commit()
    return _user_dict(current_user)


@router.get("/profile/avatar/{user_id}")
async def get_avatar(user_id: str, db: AsyncSession = Depends(get_db)):
    # Público (sin token): lo carga <Image> por URL.
    u = await db.get(User, user_id)
    if not u or not u.avatar_key:
        raise HTTPException(404, "Sin foto")
    data = storage.get_bytes(u.avatar_key)
    if data is None:
        raise HTTPException(404, "Sin foto")
    ct = "image/png" if u.avatar_key.endswith(".png") else "image/webp" if u.avatar_key.endswith(".webp") else "image/jpeg"
    return Response(content=data, media_type=ct, headers={"Cache-Control": "no-cache"})

