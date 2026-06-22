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
                    PendingCharge, LedgerEntry, ChargerBrandProfile, OwnerEvent, ChargerRating,
                    WalletTransaction)
from core.auth import get_current_user, hash_password, verify_password, create_token
import services.wompi as wompi_svc
import services.sim as sim_mgr
from core.config import *
from core.state import connected_chargers
from services.engine import (_finalize_session, _settle_captured, _owner_balance_cents,
                    _settle_owner, _settle_lock, _period_start_utc, _next_settlement_date,
                    _PERIOD_HOURS, calc_preauth_cop, ChargePoint, WebSocketAdapter,
                    _mark_offline_after_grace, fulfill_reservation_if_any, _wallet_balance_cents,
                    _refundable_cents)

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

    # Calificación propia de cada sesión (para mostrar el 👍/👎 o si ya votó)
    ratings_r = await db.execute(
        select(ChargerRating).where(ChargerRating.session_id.in_(session_ids))
    ) if session_ids else None
    my_rating = {r.session_id: r.good for r in ratings_r.scalars().all()} if ratings_r else {}

    def session_dict(s):
        d = s.to_dict()
        d["payment_status"] = pay_by_session.get(s.id, "unknown")
        d["my_rating"] = my_rating.get(s.id)   # True 👍 | False 👎 | None (sin calificar)
        return d

    return {
        "total_sessions": len(sessions),
        "total_kwh": round(total_kwh, 3),
        "total_paid_cop": round(total_paid),
        "unpaid_count": unpaid_count,
        "sessions": [session_dict(s) for s in sessions],
    }


@router.get("/my-sessions/{session_id}/receipt.pdf")
async def my_session_receipt(session_id: int, token: str, db: AsyncSession = Depends(get_db)):
    """Comprobante (factura RECARGA) de una carga propia, en PDF. Token va por query
    para poder abrirlo en el navegador. Solo el conductor dueño de la sesión accede."""
    from jose import jwt, JWTError
    from core.auth import SECRET_KEY, ALGORITHM
    from models import Invoice
    from services import storage, invoicing
    try:
        uid = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])["sub"]
    except (JWTError, KeyError):
        raise HTTPException(401, "Token inválido")
    user = await db.get(User, uid)
    session = await db.get(Session, session_id)
    if not user or not session or session.session_user != user.email:
        raise HTTPException(404, "Comprobante no encontrado")
    inv = (await db.execute(
        select(Invoice).where(Invoice.session_id == session_id, Invoice.kind == "RECARGA").limit(1)
    )).scalars().first()
    if not inv:
        raise HTTPException(404, "Comprobante aún no disponible")
    data = invoicing.render_invoice_pdf(inv) if inv.provider == "stub" \
        else storage.get_bytes(f"invoices/{inv.kind.lower()}/{inv.id}.pdf")
    if data is None:
        raise HTTPException(404, "Comprobante aún no disponible")
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="comprobante-{inv.number or inv.id}.pdf"'})



# ── CALIFICACIÓN DEL CARGADOR (conductor) ─────────────────────────────────────

class RateBody(BaseModel):
    good: bool   # True = 👍 funcionó bien · False = 👎 hubo problema


@router.post("/my-sessions/{session_id}/rate")
async def rate_session(session_id: int, body: RateBody,
                       current_user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    """Calificación discreta de una sesión propia. Una por sesión (editable).
    Ajusta los contadores agregados del cargador."""
    session = await db.get(Session, session_id)
    if not session or session.session_user != current_user.email:
        raise HTTPException(404, "Sesión no encontrada")
    charger = await db.get(Charger, session.charger_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")

    existing = await db.execute(select(ChargerRating).where(ChargerRating.session_id == session_id))
    rating = existing.scalar_one_or_none()
    if rating:
        if rating.good != body.good:   # cambió el voto → mover contadores
            if rating.good:
                charger.rating_up = max(0, (charger.rating_up or 0) - 1)
                charger.rating_down = (charger.rating_down or 0) + 1
            else:
                charger.rating_down = max(0, (charger.rating_down or 0) - 1)
                charger.rating_up = (charger.rating_up or 0) + 1
            rating.good = body.good
    else:
        db.add(ChargerRating(charger_id=charger.id, session_id=session_id,
                             user_id=current_user.id, good=body.good))
        if body.good:
            charger.rating_up = (charger.rating_up or 0) + 1
        else:
            charger.rating_down = (charger.rating_down or 0) + 1
    await db.commit()
    return {"ok": True, "good": body.good,
            "rating_up": charger.rating_up or 0, "rating_down": charger.rating_down or 0}


# ── WALLET / SALDO PREPAGO (conductor) ────────────────────────────────────────

class TopupBody(BaseModel):
    amount_cop: int
    payment_method_id: str


@router.get("/wallet")
async def my_wallet(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    bal = await _wallet_balance_cents(db, current_user.id)
    refundable = await _refundable_cents(db, current_user.id)
    movs = await db.execute(
        select(WalletTransaction).where(WalletTransaction.user_id == current_user.id)
        .order_by(WalletTransaction.created_at.desc()).limit(50)
    )
    return {
        "balance_cop": bal // 100,
        "default_topup_cop": WALLET_TOPUP_DEFAULT_COP,
        "min_topup_cop": WALLET_MIN_TOPUP_COP,
        "low_balance_cop": WALLET_LOW_BALANCE_COP,
        "refundable_cop": refundable // 100,
        "refund_cost_cop": REFUND_PROCESSING_COP,
        "movements": [m.to_dict() for m in movs.scalars().all()],
    }


@router.post("/wallet/refund-request")
async def wallet_refund_request(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """El conductor solicita la devolución de su saldo. Se procesa manualmente desde
    el back-office (mientras Wompi producción permita dispersión automática). Avisa
    al admin por correo. No mueve plata aquí."""
    refundable = await _refundable_cents(db, current_user.id)
    if refundable <= 0:
        raise HTTPException(400, "No tienes saldo reembolsable.")
    try:
        import os; from services import emailer
        ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "")
        if ADMIN_EMAIL:
            subj = "Solicitud de devolución de saldo"
            msg = (f"{current_user.name} ({current_user.email}) solicita devolución de "
                   f"${refundable // 100:,} COP. Procésala en admin → Usuarios.")
            asyncio.create_task(emailer.send_email(ADMIN_EMAIL, subj, f"<p>{msg}</p>", msg))
    except Exception as e:
        logger.warning(f"aviso devolución: {e}")
    return {"ok": True, "refundable_cop": refundable // 100}


@router.post("/wallet/topup")
async def wallet_topup(body: TopupBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Recarga el saldo con UNA transacción Wompi (cargo a la tarjeta guardada)."""
    if body.amount_cop < WALLET_MIN_TOPUP_COP:
        raise HTTPException(400, f"La recarga mínima es ${WALLET_MIN_TOPUP_COP:,} COP")
    method = await db.get(PaymentMethod, body.payment_method_id)
    if not method or method.user_id != current_user.id:
        raise HTTPException(404, "Método de pago no encontrado")
    if not method.wompi_payment_source_id:
        raise HTTPException(400, "Esta tarjeta no es válida. Elimínala y vuélvela a agregar.")

    amount_cents = body.amount_cop * 100
    reference = f"wallet-{current_user.id[:8]}-{int(datetime.now().timestamp())}"
    try:
        resp = await wompi_svc.capture_preauth(method.wompi_payment_source_id, amount_cents, current_user.email, reference)
    except Exception as e:
        logger.warning(f"Recarga wallet {reference}: error Wompi {e}")
        raise HTTPException(502, "No pudimos procesar la recarga. Intenta de nuevo.")

    data = resp.get("data", {})
    status = data.get("status") or ""
    wid = data.get("id")
    waited = 0
    while status == "PENDING" and wid and waited < 6:
        await asyncio.sleep(1); waited += 1
        data = (await wompi_svc.get_transaction(str(wid))).get("data", {})
        status = data.get("status") or ""

    if status != "APPROVED":
        raise HTTPException(402, f"La recarga no fue aprobada ({status or 'sin respuesta'}). Verifica tu tarjeta.")

    db.add(WalletTransaction(user_id=current_user.id, type="TOPUP", amount_cents=amount_cents,
                            reference=reference, wompi_id=str(wid) if wid else None,
                            description=f"Recarga de saldo ${body.amount_cop:,} COP"))
    # Faro ASUME la pasarela de la recarga (no el conductor): se registra como costo.
    fee_cents = round((amount_cents * WOMPI_FEE_PCT + WOMPI_FEE_FIXED_COP * 100) * (1 + IVA_RATE))
    db.add(LedgerEntry(owner_id=None, account=ACCT_FARO_GATEWAY, type="GATEWAY_COST",
                       amount_cents=-fee_cents, description=f"Pasarela recarga ${body.amount_cop:,} COP"))
    await db.commit()
    bal = await _wallet_balance_cents(db, current_user.id)
    return {"ok": True, "amount_cop": body.amount_cop, "balance_cop": bal // 100}


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
    payment_method_id: str | None = None   # ya no se usa en modo wallet (se cobra del saldo)


@router.post("/payments/initiate")
async def initiate_payment(
    body: InitiatePaymentBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Modo WALLET: arranca la carga contra el SALDO prepago del conductor. El cobro
    exacto se descuenta del saldo al terminar (sin transacción Wompi por sesión)."""
    charger = await db.get(Charger, body.charger_id)
    if not charger:
        raise HTTPException(400, "Cargador no disponible")
    # Bloquear si el dueño tiene la mensualidad de plataforma suspendida
    if charger.owner_id:
        owner = await db.get(User, charger.owner_id)
        if owner and not owner.subscription_active:
            raise HTTPException(400, "Cargador no disponible")
    if charger.status == "Reserved":
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

    # Verificar saldo suficiente (estimado de la carga)
    estimate = calc_preauth_cop(charger)
    balance = await _wallet_balance_cents(db, current_user.id)
    if balance < estimate:
        raise HTTPException(402, f"Saldo insuficiente. Recarga al menos ${estimate:,} COP para cargar aquí.")

    reference = f"wlt-{current_user.id[:8]}-{body.charger_id}-{int(datetime.now().timestamp())}"
    payment = PaymentTransaction(
        charger_id=body.charger_id,
        user_id=current_user.id,
        reference=reference,
        amount_cents=0,            # se fija al cobrar (débito del saldo)
        status="APPROVED",
        payment_type="WALLET",
    )
    db.add(payment)
    await db.commit()

    charger_conn = connected_chargers.get(body.charger_id)
    if charger_conn:
        try:
            await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.tag))
        except Exception as e:
            logger.warning(f"RemoteStart falló en {body.charger_id}: {e}")
            raise HTTPException(502, "No se pudo iniciar la carga en el cargador. Intenta de nuevo.")
    # Si venía de una separación: cúmplela (captura la cuota fija, libera el resto)
    await fulfill_reservation_if_any(db, current_user.id, body.charger_id)
    await db.commit()
    logger.info(f"Sesión WALLET autorizada para {current_user.email} en {body.charger_id} (saldo ${balance // 100:,} COP)")

    return {
        "reference":   reference,
        "status":      "APPROVED",
        "payment_id":  payment.id,
        "balance_cop": balance // 100,
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
                await charger_conn.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.tag))
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

