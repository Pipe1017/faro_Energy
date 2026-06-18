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
                    _mark_offline_after_grace, reservation_fee_cop)

logger = logging.getLogger(__name__)
router = APIRouter()

class ReserveBody(BaseModel):
    payment_method_id: str | None = None  # tarjeta para la garantía (opcional: usa la default)


@router.post("/reserve/{charge_point_id}")
async def reserve_charger(
    charge_point_id: str,
    body: ReserveBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Separa un cargador: RETIENE (no cobra) una garantía proporcional al espacio
    bloqueado. Si el conductor llega y carga, solo se captura la cuota fija; si no
    llega (vence ventana + gracia), se captura toda la garantía como multa al dueño."""
    charger_conn = connected_chargers.get(charge_point_id)
    if not charger_conn:
        raise HTTPException(400, "Cargador no conectado")
    charger = await db.get(Charger, charge_point_id)
    if not charger or charger.status != "Available":
        raise HTTPException(400, "Cargador no disponible para separar")
    if charger.owner_id == current_user.id:
        raise HTTPException(400, "No puedes separar tu propio cargador")
    if charger.owner_id:
        owner = await db.get(User, charger.owner_id)
        if owner and not owner.subscription_active:
            raise HTTPException(400, "Cargador no disponible")

    # No separar con cobros fallidos pendientes (igual que iniciar sesión)
    unpaid = await db.execute(
        select(PaymentTransaction).where(
            PaymentTransaction.user_id == current_user.id,
            PaymentTransaction.status.in_(["UNPAID", "PROCESSING"]),
        ).limit(1)
    )
    if unpaid.scalars().first():
        raise HTTPException(402, "Tienes un cobro pendiente. Págalo desde 'Mi uso' para poder separar.")

    # Una sola reserva activa por conductor a la vez
    mine = await db.execute(
        select(Reservation).where(
            Reservation.user_id == current_user.id, Reservation.status == "active"
        ).limit(1)
    )
    if mine.scalars().first():
        raise HTTPException(409, "Ya tienes una separación activa. Cancélala o úsala antes de separar otra.")

    # Tarjeta para la garantía
    if body.payment_method_id:
        method = await db.get(PaymentMethod, body.payment_method_id)
        if not method or method.user_id != current_user.id:
            raise HTTPException(404, "Método de pago no encontrado")
    else:
        res_m = await db.execute(
            select(PaymentMethod).where(PaymentMethod.user_id == current_user.id)
            .order_by(PaymentMethod.is_default.desc(), PaymentMethod.created_at.desc()).limit(1)
        )
        method = res_m.scalars().first()
    if not method or not method.wompi_payment_source_id:
        raise HTTPException(400, "Agrega una tarjeta válida para separar (se retiene una garantía).")

    fee_cop = reservation_fee_cop(charger)

    # Retención de la garantía ANTES de bloquear el cargador. Si el banco rechaza,
    # no se separa nada.
    preauth_id, pstatus = None, ""
    try:
        resp  = await wompi_svc.preauthorize_card(fee_cop * 100, current_user.email, method.wompi_payment_source_id)
        pdata = resp.get("data", {})
        preauth_id, pstatus = pdata.get("id"), (pdata.get("status") or "")
        waited = 0
        while preauth_id and pstatus == "PROCESSING" and waited < 6:
            await asyncio.sleep(1)
            waited += 1
            pdata   = (await wompi_svc.get_payment_source(preauth_id)).get("data", {})
            pstatus = pdata.get("status") or ""
    except Exception as e:
        logger.warning(f"Reserva: pre-auth no disponible ({e})")

    if pstatus in ("DECLINED", "ERROR", "VOIDED"):
        raise HTTPException(402, "Tu banco rechazó la retención de la garantía. Usa otra tarjeta.")
    if preauth_id is None:
        # Pre-auth no activa en esta cuenta Wompi (igual que el flujo de energía):
        # se separa sin retención y la cuota/multa se captura contra la tarjeta
        # guardada al cerrar la reserva. _capture_reservation cae a payment_source.
        logger.warning(f"Reserva sin retención (pre-auth no activa) — la cuota/multa se capturará contra la tarjeta guardada de {current_user.email}")

    now            = datetime.now(timezone.utc)
    end            = now + timedelta(minutes=RESERVE_MINUTES)
    no_show_at     = end + timedelta(minutes=RESERVE_GRACE_MINUTES)
    reservation_id = int(now.timestamp()) % 100000

    response = await charger_conn.call(call.ReserveNowPayload(
        connector_id=1,
        expiry_date=no_show_at.isoformat(),
        id_tag=current_user.tag,   # idTag OCPP = tag corto del usuario
        reservation_id=reservation_id,
    ))
    if response.status != "Accepted":
        raise HTTPException(400, f"El cargador rechazó la separación: {response.status}")

    reference = f"resv-{current_user.id[:8]}-{charge_point_id}-{int(now.timestamp())}"
    pay_tx = PaymentTransaction(
        charger_id=charge_point_id,
        user_id=current_user.id,
        reference=reference,
        wompi_payment_source_id=method.wompi_payment_source_id,
        wompi_preauth_id=preauth_id,
        amount_cents=0,            # se actualiza al capturar (cuota o multa)
        # Estado propio "HOLD": evita que _finalize_session lo confunda con el
        # cobro de energía (que busca status APPROVED + session_id nulo).
        status="HOLD",
        payment_type="CARD",
    )
    db.add(pay_tx)
    await db.flush()

    reservation = Reservation(
        charger_id=charge_point_id,
        user_id=current_user.id,
        ocpp_reservation_id=reservation_id,
        start_time=now,
        end_time=end,
        no_show_at=no_show_at,
        status="active",
        fee_cents=fee_cop * 100,
        wompi_preauth_id=preauth_id,
        payment_tx_id=pay_tx.id,
    )
    db.add(reservation)
    charger.status = "Reserved"
    await db.commit()
    logger.info(f"resv #{reservation.id}: {charge_point_id} separado por {current_user.email} — garantía ${fee_cop:,} COP retenida")
    return reservation.to_dict()


@router.delete("/reserve/{reservation_id}")
async def cancel_reservation(
    reservation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancela una separación a tiempo: libera la retención (sin cobro) y desbloquea
    el cargador. Solo el no-show (vencimiento) cobra la multa."""
    result = await db.execute(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .options(selectinload(Reservation.charger), selectinload(Reservation.user))
    )
    reservation = result.scalar_one_or_none()
    if not reservation or reservation.user_id != current_user.id:
        raise HTTPException(404, "Reserva no encontrada")
    if reservation.status != "active":
        raise HTTPException(400, f"La separación ya está '{reservation.status}'")

    charger_conn = connected_chargers.get(reservation.charger_id)
    if charger_conn:
        try:
            await charger_conn.call(call.CancelReservationPayload(reservation_id=reservation.ocpp_reservation_id))
        except Exception:
            pass

    # Cancelación a tiempo = sin cobro. La retención de Wompi se libera sola al
    # no capturarse (expira). Marcamos settled para que el worker la ignore.
    reservation.status  = "cancelled"
    reservation.settled = True
    if reservation.payment_tx_id:
        pay_tx = await db.get(PaymentTransaction, reservation.payment_tx_id)
        if pay_tx and pay_tx.status in ("HOLD", "APPROVED", "PENDING"):
            pay_tx.status = "VOID"
    charger = await db.get(Charger, reservation.charger_id)
    if charger and charger.status == "Reserved":
        charger.status = "Available"
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

