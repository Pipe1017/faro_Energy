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
                    _mark_offline_after_grace, fulfill_reservation_if_any)

logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/my-active-session")
async def my_active_session(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Carga en curso del usuario, si la hay. Permite a la app reconstruir la
    sesión tras cerrarse/reabrirse (activeSession vive en memoria del cliente)."""
    result = await db.execute(
        select(Charger)
        .where(Charger.session_user == current_user.email, Charger.active_transaction.isnot(None))
        .options(selectinload(Charger.owner))
        .limit(1)
    )
    charger = result.scalars().first()
    if not charger:
        return {"active": False}
    return {
        "active": True,
        "charger": charger.to_dict(),
        "started_at": charger.session_started_at.isoformat() if charger.session_started_at else None,
    }


@router.get("/my-sessions")
async def my_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Session)
        .where(Session.session_user == current_user.email)
        .options(selectinload(Session.charger))
        .order_by(Session.ended_at.desc())
        .limit(50)
    )
    sessions = result.scalars().all()
    total_kwh  = sum(s.kwh_delivered for s in sessions)
    total_paid = sum(s.total_charged for s in sessions)
    # Pagos de estas sesiones
    session_ids = [s.id for s in sessions]
    payments_r = await db.execute(
        select(PaymentTransaction)
        .where(PaymentTransaction.user_id == current_user.id)
    )
    all_payments = payments_r.scalars().all()

    # Mapear session_id → payment_status
    pay_by_session: dict[int, str] = {}
    for p in all_payments:
        if p.session_id and p.session_id in session_ids:
            pay_by_session[p.session_id] = p.status

    unpaid_count = sum(1 for p in all_payments if p.status == "UNPAID")

    def session_dict(s):
        d = s.to_dict()
        d["payment_status"] = pay_by_session.get(s.id, "unknown")
        return d

    return {
        "total_sessions": len(sessions),
        "total_kwh": round(total_kwh, 3),
        "total_paid_cop": round(total_paid),
        "unpaid_count": unpaid_count,
        "sessions": [session_dict(s) for s in sessions],
    }



# ── MÉTODOS DE PAGO (conductor) ───────────────────────────────────────────────

class AddCardBody(BaseModel):
    # PCI: el número de tarjeta NUNCA pasa por este servidor.
    # La app tokeniza directo contra Wompi con la llave pública y manda solo el token.
    token: str                      # tok_... de Wompi
    brand: str | None = None        # VISA | MASTERCARD (del response de tokenización)
    last4: str | None = None
    nickname: str | None = None

class AddNequiBody(BaseModel):
    phone: str
    holder_name: str
    nickname: str | None = None

class NicknameBody(BaseModel):
    nickname: str

@router.get("/payment-methods")
async def list_payment_methods(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id).order_by(PaymentMethod.created_at))
    return {"methods": [m.to_dict() for m in result.scalars().all()]}


@router.post("/payment-methods/card")
async def add_card(body: AddCardBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not body.token.startswith("tok_"):
        raise HTTPException(400, "Token de tarjeta inválido")

    # Anti-duplicado: misma marca + últimos 4 dígitos ya guardados
    # (también protege contra doble-tap en el botón de guardar)
    if body.brand and body.last4:
        dup_display = f"{body.brand.upper()} •••• {body.last4}"
        dup = await db.execute(
            select(PaymentMethod)
            .where(PaymentMethod.user_id == current_user.id, PaymentMethod.display == dup_display)
            .limit(1)
        )
        if dup.scalars().first():
            raise HTTPException(409, "Ya tienes guardada esta tarjeta. Si es otra distinta con los mismos últimos dígitos, elimina la anterior primero.")

    # Convertir el token de un solo uso en payment_source persistente
    try:
        ps_resp = await wompi_svc.save_card_as_payment_source(body.token, current_user.email)
    except Exception as e:
        # Timeout o caída del sandbox de Wompi — no reventar con 500 crudo
        logger.warning(f"save_payment_source error de red para {current_user.email}: {e}")
        raise HTTPException(502, "La pasarela de pago no respondió a tiempo. Intenta de nuevo en un momento.")
    ps_data = ps_resp.get("data") or {}
    ps_id   = ps_data.get("id")
    if not ps_id:
        err = ps_resp.get("error") or {}
        reason = err.get("reason") or (err.get("messages") if isinstance(err, dict) else None) or "Wompi no aceptó la tarjeta"
        logger.warning(f"save_payment_source sin id para {current_user.email}: {ps_resp}")
        raise HTTPException(400, f"No se pudo guardar la tarjeta: {reason}")
    logger.info(f"Tarjeta guardada como payment_source #{ps_id} para {current_user.email}")

    brand = (body.brand or ps_data.get("public_data", {}).get("brand") or "CARD").upper()
    last4 = body.last4 if body.last4 and body.last4.isdigit() and len(body.last4) == 4 \
        else ps_data.get("public_data", {}).get("last_four", "????")

    existing = await db.execute(select(PaymentMethod.id).where(PaymentMethod.user_id == current_user.id).limit(1))
    is_first  = existing.scalars().first() is None
    method = PaymentMethod(
        user_id=current_user.id,
        type="CARD",
        wompi_token=None,
        wompi_payment_source_id=ps_id,
        display=f"{brand} •••• {last4}",
        brand=brand,
        nickname=body.nickname.strip() if body.nickname and body.nickname.strip() else None,
        is_default=is_first,
    )
    db.add(method)
    await db.commit()
    return method.to_dict()

@router.post("/payment-methods/nequi")
async def add_nequi(body: AddNequiBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    dup = await db.execute(
        select(PaymentMethod)
        .where(PaymentMethod.user_id == current_user.id, PaymentMethod.wompi_token == body.phone, PaymentMethod.type == "NEQUI")
        .limit(1)
    )
    if dup.scalars().first():
        raise HTTPException(409, "Ya tienes guardado ese número de Nequi.")
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id).limit(1))
    is_first = result.scalars().first() is None
    method = PaymentMethod(
        user_id=current_user.id,
        type="NEQUI",
        display=f"Nequi {body.phone}",
        wompi_token=body.phone,
        nickname=body.nickname.strip() if body.nickname and body.nickname.strip() else None,
        is_default=is_first,
    )
    db.add(method)
    await db.commit()
    return method.to_dict()

@router.patch("/payment-methods/{method_id}/nickname")
async def rename_payment_method(method_id: str, body: NicknameBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    method = await db.get(PaymentMethod, method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método no encontrado")
    method.nickname = body.nickname.strip() or None
    await db.commit()
    return method.to_dict()

@router.delete("/payment-methods/{method_id}")
async def delete_payment_method(method_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    method = await db.get(PaymentMethod, method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método no encontrado")
    await db.delete(method)
    await db.commit()
    return {"ok": True}

@router.patch("/payment-methods/{method_id}/default")
async def set_default_method(method_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentMethod).where(PaymentMethod.user_id == current_user.id))
    for m in result.scalars().all():
        m.is_default = (m.id == method_id)
    await db.commit()
    return {"ok": True}



class InitiatePaymentBody(BaseModel):
    charger_id: str
    payment_method_id: str


@router.post("/payments/initiate")
async def initiate_payment(
    body: InitiatePaymentBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    method = await db.get(PaymentMethod, body.payment_method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método de pago no encontrado")

    charger = await db.get(Charger, body.charger_id)
    if not charger:
        raise HTTPException(400, "Cargador no disponible")
    if charger.status == "Reserved":
        # Solo quien tiene la separación activa puede arrancar un cargador reservado
        held = await db.execute(
            select(Reservation).where(
                Reservation.charger_id == body.charger_id,
                Reservation.user_id == current_user.id,
                Reservation.status == "active",
            ).limit(1)
        )
        if not held.scalars().first():
            raise HTTPException(400, "Este cargador está separado por otro conductor")
    elif charger.status != "Available":
        raise HTTPException(400, "Cargador no disponible")

    if not method.wompi_payment_source_id:
        raise HTTPException(400, "Esta tarjeta no tiene un payment_source válido. Elimínala y vuélvela a agregar.")

    # Bloquear si tiene pagos fallidos pendientes
    unpaid = await db.execute(
        select(PaymentTransaction)
        .where(PaymentTransaction.user_id == current_user.id, PaymentTransaction.status.in_(["UNPAID", "PROCESSING"]))
        .limit(1)
    )
    if unpaid.scalars().first():
        raise HTTPException(402, "Tienes un cobro pendiente de una sesión anterior. Págalo desde 'Mi uso' para volver a cargar.")

    reference     = f"cpo-{current_user.id[:8]}-{body.charger_id}-{int(datetime.now().timestamp())}"
    guarantee_cop = calc_preauth_cop(charger)

    # Pre-autorización real: retiene la garantía ANTES de arrancar la carga.
    # Si el banco rechaza, el cargador nunca arranca — imposible quedar UNPAID
    # por fondos insuficientes. El cobro exacto se captura al terminar.
    preauth_id = None
    pstatus    = ""
    try:
        resp  = await wompi_svc.preauthorize_card(guarantee_cop * 100, current_user.email, method.wompi_payment_source_id)
        pdata = resp.get("data", {})
        preauth_id, pstatus = pdata.get("id"), (pdata.get("status") or "")
        # Espera corta a que la retención quede disponible (sandbox: 1-2s)
        waited = 0
        while preauth_id and pstatus == "PROCESSING" and waited < 6:
            await asyncio.sleep(1)
            waited += 1
            pdata   = (await wompi_svc.get_payment_source(preauth_id)).get("data", {})
            pstatus = pdata.get("status") or ""
    except Exception as e:
        logger.warning(f"Pre-auth no disponible ({e}) — autorizando sin retención")

    if pstatus in ("DECLINED", "ERROR", "VOIDED"):
        raise HTTPException(402, "Tu banco rechazó la retención de garantía. Verifica fondos o usa otra tarjeta.")
    if preauth_id is None:
        # Feature de pre-auth no activa en esta cuenta Wompi — flujo degradado:
        # se autoriza con la tarjeta guardada y el cobro único ocurre al final.
        logger.warning(f"Pre-auth no activa en Wompi — {reference} autorizado sin retención de garantía")

    status = "APPROVED" if (preauth_id is None or pstatus == "AVAILABLE") else "PENDING"
    payment = PaymentTransaction(
        charger_id=body.charger_id,
        user_id=current_user.id,
        reference=reference,
        wompi_payment_source_id=method.wompi_payment_source_id,
        wompi_preauth_id=preauth_id,
        wompi_id=None,
        amount_cents=0,      # se actualiza al capturar el cobro real
        status=status,
        payment_type="CARD",
    )
    db.add(payment)
    await db.commit()

    if status == "APPROVED":
        charger_conn = connected_chargers.get(body.charger_id)
        if charger_conn:
            await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.email))
        # Si venía de una separación: cúmplela (captura la cuota fija, libera el resto)
        await fulfill_reservation_if_any(db, current_user.id, body.charger_id)
        await db.commit()
        logger.info(
            f"Sesión autorizada para {current_user.email} en {body.charger_id} — "
            + (f"garantía ${guarantee_cop:,} COP retenida (preauth#{preauth_id})" if preauth_id else f"sin retención, ps#{method.wompi_payment_source_id}")
        )
    else:
        logger.info(f"Pre-auth {reference} en PROCESSING — la app hará polling hasta confirmar")

    return {
        "reference":     reference,
        "status":        status,
        "payment_id":    payment.id,
        "guarantee_cop": guarantee_cop if preauth_id else 0,
    }


@router.get("/payments/status/{reference}")
async def payment_status(reference: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PaymentTransaction).where(PaymentTransaction.reference == reference))
    payment = result.scalar_one_or_none()
    if not payment or payment.user_id != current_user.id:
        raise HTTPException(404, "Pago no encontrado")

    # Pre-auth aún en PROCESSING: consultar Wompi y, al confirmarse la
    # retención, arrancar la carga (la app hace polling de este endpoint)
    if payment.status == "PENDING" and payment.wompi_preauth_id:
        try:
            resp = await wompi_svc.get_payment_source(payment.wompi_preauth_id)
            ps_status = resp.get("data", {}).get("status", "")
        except Exception as e:
            logger.warning(f"payment_status: error consultando pre-auth: {e}")
            ps_status = ""
        if ps_status == "AVAILABLE":
            payment.status = "APPROVED"
            charger_conn = connected_chargers.get(payment.charger_id)
            if charger_conn:
                await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.email))
            await fulfill_reservation_if_any(db, current_user.id, payment.charger_id)
            await db.commit()
            logger.info(f"Pre-auth confirmada — sesión iniciada en {payment.charger_id} para {current_user.email}")
        elif ps_status in ("DECLINED", "ERROR", "VOIDED"):
            payment.status = "DECLINED"
            await db.commit()
            logger.warning(f"Pre-auth {reference} declinada por el banco")

    return {"reference": reference, "status": payment.status, "payment_id": payment.id}



# ── DEUDAS (cobros fallidos) ──────────────────────────────────────────────────

@router.get("/my-debts")
async def my_debts(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Cobros que el banco rechazó y mantienen bloqueado al conductor."""
    result = await db.execute(
        select(PaymentTransaction)
        .where(PaymentTransaction.user_id == current_user.id, PaymentTransaction.status.in_(["UNPAID", "PROCESSING"]))
        .order_by(PaymentTransaction.created_at)
    )
    debts = result.scalars().all()
    items = []
    for p in debts:
        location = None
        if p.session_id:
            s = await db.get(Session, p.session_id)
            if s:
                ch = await db.get(Charger, s.charger_id)
                location = ch.location if ch else s.charger_id
        items.append({
            "payment_id": p.id, "session_id": p.session_id,
            "amount_cop": p.amount_cents // 100, "charger_id": p.charger_id,
            "location": location, "created_at": p.created_at.isoformat(),
            "processing": p.status == "PROCESSING",   # en confirmación → no reintentar
        })
    return {
        "blocked": len(items) > 0,
        "total_cop": sum(i["amount_cop"] for i in items),
        "debts": items,
    }


class PayDebtBody(BaseModel):
    payment_id: str
    payment_method_id: str


@router.post("/my-debts/pay")
async def pay_debt(body: PayDebtBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Reintenta cobrar una deuda con el método elegido (puede ser otra tarjeta).
    Si aprueba: marca CAPTURED, abona al dueño y el conductor queda desbloqueado."""
    pay_tx = await db.get(PaymentTransaction, body.payment_id)
    if not pay_tx or pay_tx.user_id != current_user.id:
        raise HTTPException(404, "Cobro no encontrado")
    if pay_tx.status != "UNPAID":
        raise HTTPException(400, "Este cobro ya no está pendiente")

    method = await db.get(PaymentMethod, body.payment_method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método de pago no encontrado")
    if not method.wompi_payment_source_id:
        raise HTTPException(400, "Esta tarjeta no es válida para cobros. Elimínala y agrégala de nuevo.")

    amount_cents = max(WOMPI_MIN_CENTS, pay_tx.amount_cents)
    # Referencia NUEVA: Wompi rechaza referencias repetidas
    new_ref = f"debt-{pay_tx.id[:8]}-{int(datetime.now().timestamp())}"
    try:
        resp = await wompi_svc.capture_preauth(method.wompi_payment_source_id, amount_cents, current_user.email, new_ref)
    except Exception as e:
        raise HTTPException(502, f"No pudimos conectar con la pasarela: {e}")

    data   = resp.get("data", {})
    err    = resp.get("error")
    status = data.get("status", "")
    if err or not data.get("id"):
        raise HTTPException(402, "El banco rechazó el cobro. Intenta con otra tarjeta.")

    pay_tx.reference   = new_ref
    pay_tx.wompi_id    = data["id"]
    pay_tx.amount_cents = amount_cents
    pay_tx.wompi_payment_source_id = method.wompi_payment_source_id

    if status == "APPROVED":
        pc = (await db.execute(
            select(PendingCharge).where(PendingCharge.payment_tx_id == pay_tx.id).limit(1)
        )).scalars().first()
        if pc:
            await _settle_captured(db, pc, pay_tx)   # marca CAPTURED + abona al dueño
        else:
            pay_tx.status = "CAPTURED"
        await db.commit()
        return {"ok": True, "status": "CAPTURED", "amount_cop": amount_cents // 100}

    if status == "PENDING":
        # Cobro en confirmación: marcar PROCESSING para que NO se pueda
        # reintentar (evita cobros duplicados). El worker lo resuelve:
        # → CAPTURED si el banco aprueba, → UNPAID si declina (pagable de nuevo)
        pay_tx.status = "PROCESSING"
        pc = (await db.execute(
            select(PendingCharge).where(PendingCharge.payment_tx_id == pay_tx.id).limit(1)
        )).scalars().first()
        if pc:
            pc.status = "WAITING_CONFIRM"
            pc.wompi_tx_id = data["id"]
            pc.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=10)
        await db.commit()
        return {"ok": True, "status": "PENDING", "amount_cop": amount_cents // 100}

    raise HTTPException(402, "El banco rechazó el cobro. Intenta con otra tarjeta.")



# ── WEBHOOK DE WOMPI ──────────────────────────────────────────────────────────

@router.post("/webhooks/wompi")
async def wompi_webhook(payload: dict, db: AsyncSession = Depends(get_db)):
    if not wompi_svc.verify_webhook_signature(payload):
        raise HTTPException(401, "Firma inválida")

    event = payload.get("event")
    if event != "transaction.updated":
        return {"ok": True}

    tx = payload.get("data", {}).get("transaction", {})
    wompi_id = tx.get("id")
    status   = tx.get("status")

    result = await db.execute(select(PaymentTransaction).where(PaymentTransaction.wompi_id == wompi_id))
    payment = result.scalar_one_or_none()
    if not payment:
        return {"ok": True}

    old_status = payment.status
    # Mapear DECLINED → UNPAID para activar el bloqueo de futuras sesiones
    payment.status = "UNPAID" if status == "DECLINED" else status
    await db.commit()
    logger.info(f"Webhook Wompi: {wompi_id} → {status}" + (" (→ UNPAID)" if status == "DECLINED" else ""))

    return {"ok": True}

