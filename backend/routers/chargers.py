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

@router.post("/remote-start/{charge_point_id}")
async def remote_start(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
):
    """DIAGNÓSTICO (solo admin): arranca una carga sin pasar por el saldo. El flujo
    real del conductor es /payments/initiate, que valida saldo, deuda y suscripción.
    Este endpoint NO cobra al wallet, por eso queda restringido a admin."""
    if current_user.role != "admin":
        raise HTTPException(403, "Inicia la carga desde la app (se valida tu saldo).")
    charger = connected_chargers.get(charge_point_id)
    if not charger:
        return {"error": "Cargador no conectado"}
    response = await charger.call(call.RemoteStartTransactionPayload(connector_id=1, id_tag=current_user.tag or current_user.email[:20]))
    return {"status": response.status}


@router.post("/remote-stop/{charge_point_id}")
async def remote_stop(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger or not charger.active_transaction:
        return {"error": "Sin sesión activa"}

    # Solo puede detener: el conductor que inició la carga, el dueño del
    # cargador (emergencia) o un admin. Nadie detiene la carga de otro.
    is_session_user = charger.session_user == current_user.email
    is_owner        = charger.owner_id == current_user.id
    is_admin        = current_user.role == "admin"
    if not (is_session_user or is_owner or is_admin):
        raise HTTPException(403, "No puedes detener una carga que no es tuya")

    charger_conn = connected_chargers.get(charge_point_id)
    if not charger_conn:
        # Cargador sin conexión: cerrar la sesión con el último consumo medido
        # y encolar el cobro — el conductor paga solo lo que se alcanzó a medir
        await _finalize_session(db, charger, charger.current_kwh or 0.0, final_status="Offline")
        await db.commit()
        return {"error": "Cargador sin conexión — sesión cerrada con el último consumo medido", "manual": True}
    response = await charger_conn.call(call.RemoteStopTransactionPayload(transaction_id=charger.active_transaction))
    return {"status": response.status}


# ── MIS CARGADORES (dueños) ───────────────────────────────────────────────────

@router.get("/my-chargers")
async def my_chargers(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños de cargadores")
    result = await db.execute(
        select(Charger).where(Charger.owner_id == current_user.id).options(selectinload(Charger.owner))
    )
    chargers = result.scalars().all()
    return {"chargers": [c.to_dict() for c in chargers]}



import re as _re_charger

# Alfabeto sin caracteres confundibles (sin 0/O, 1/I/L) — el dueño lo teclea
# en el panel de su cargador, debe ser imposible equivocarse
_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

async def _generate_charger_id(db: AsyncSession) -> str:
    for _ in range(20):
        cid = "FARO-" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(4))
        if not await db.get(Charger, cid):
            return cid
    raise HTTPException(500, "No se pudo generar un ID único — reintenta")


class AddChargerBody(BaseModel):
    location: str
    lat: float
    lng: float
    power_kw: float
    connector_type: str              # "Type 2" | "CCS2" | "CHAdeMO" | "Schuko"
    price_per_kwh: float
    cost_per_kwh: float = 0.0
    brand_profile_id: str | None = None   # marca elegida por el dueño (opcional)
    id: str | None = None                 # legacy: si no llega, el sistema lo genera

@router.post("/chargers")
async def add_charger(
    body: AddChargerBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo para dueños")

    if body.id:
        if not _re_charger.match(r'^[A-Za-z0-9_\-]{3,30}$', body.id):
            raise HTTPException(400, "ID inválido. Usa letras, números, guiones (3-30 caracteres).")
        if await db.get(Charger, body.id):
            raise HTTPException(409, f"Ya existe un cargador con ID '{body.id}'")
        charger_id = body.id
    else:
        charger_id = await _generate_charger_id(db)

    if body.brand_profile_id and not await db.get(ChargerBrandProfile, body.brand_profile_id):
        raise HTTPException(400, "Marca no encontrada en el catálogo")

    charger = Charger(
        id=charger_id, owner_id=current_user.id,
        location=body.location, lat=body.lat, lng=body.lng,
        power_kw=body.power_kw, connector_type=body.connector_type,
        price_per_kwh=body.price_per_kwh, cost_per_kwh=body.cost_per_kwh,
        brand_profile_id=body.brand_profile_id,
        status="Offline",
    )
    db.add(charger)
    await db.commit()
    logger.info(f"Cargador {charger_id} registrado por {current_user.email}")

    # Auto-arrancar simulador para el nuevo cargador
    async def _start_sim():
        await asyncio.sleep(1)
        sim_mgr.start(charger_id, body.power_kw)
    asyncio.create_task(_start_sim())

    return {**charger.to_dict(), "ocpp_url": ocpp_url(charger_id)}


@router.get("/brand-profiles")
async def list_brand_profiles(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ChargerBrandProfile).order_by(ChargerBrandProfile.display_name))
    return {"profiles": [p.to_dict() for p in result.scalars().all()]}


@router.get("/chargers/{charge_point_id}/setup")
async def charger_setup(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Guía de vinculación del cargador: URL OCPP, ID, y los pasos según su marca."""
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")

    profile = None
    if charger.brand_profile_id:
        profile = await db.get(ChargerBrandProfile, charger.brand_profile_id)
    if not profile:
        profile = await db.get(ChargerBrandProfile, "generic-ocpp16")

    return {
        "charger_id": charger.id,
        "ocpp_url": ocpp_url(charger.id),
        "connected": charger.id in connected_chargers,
        "status": charger.status,
        "last_seen": charger.last_seen.isoformat() if charger.last_seen else None,
        "detected_vendor": charger.vendor,
        "detected_model": charger.model,
        "brand_profile": profile.to_dict() if profile else None,
    }

@router.delete("/chargers/{charge_point_id}")
async def delete_charger(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if charger.active_transaction:
        raise HTTPException(400, "Hay una sesión activa — detén la carga primero")
    # Detener simulador si está corriendo
    sim_mgr.stop(charge_point_id)
    # Limpiar conexión OCPP activa
    connected_chargers.pop(charge_point_id, None)
    await db.delete(charger)
    await db.commit()
    logger.info(f"Cargador {charge_point_id} eliminado por {current_user.email}")
    return {"ok": True}

class PauseBody(BaseModel):
    pause: bool   # True = pausar, False = reanudar

@router.patch("/chargers/{charge_point_id}/availability")
async def set_availability(
    charge_point_id: str,
    body: PauseBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if charger.active_transaction and body.pause:
        raise HTTPException(400, "Hay una sesión activa, detén la carga primero")

    availability = AvailabilityType.inoperative if body.pause else AvailabilityType.operative
    ocpp_status  = "Unavailable" if body.pause else "Available"

    charger_conn = connected_chargers.get(charge_point_id)
    if charger_conn:
        try:
            resp = await charger_conn.call(call.ChangeAvailabilityPayload(
                connector_id=0, type=availability,
            ))
            logger.info(f"ChangeAvailability {charge_point_id} → {availability}: {resp.status}")
        except Exception as e:
            logger.warning(f"ChangeAvailability falló: {e} — actualizando DB de todas formas")

    charger.status = ocpp_status
    await db.commit()
    return {"ok": True, "status": ocpp_status}


# ── SIMULADORES (gestión desde la app) ───────────────────────────────────────

@router.get("/simulators")
async def list_simulators(current_user: User = Depends(get_current_user)):
    return {"running": sim_mgr.list_running()}

@router.post("/simulators/{charge_point_id}")
async def start_simulator(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if sim_mgr.is_running(charge_point_id):
        return {"ok": True, "message": "Ya estaba corriendo"}
    sim_mgr.start(charge_point_id, charger.power_kw or 22.0)
    logger.info(f"Simulador iniciado para {charge_point_id} por {current_user.email}")
    return {"ok": True, "message": f"Simulador de {charge_point_id} iniciado"}

@router.delete("/simulators/{charge_point_id}")
async def stop_simulator(
    charge_point_id: str,
    current_user: User = Depends(get_current_user),
):
    stopped = sim_mgr.stop(charge_point_id)
    logger.info(f"Simulador {charge_point_id} detenido por {current_user.email}")
    return {"ok": True, "stopped": stopped}


class PriceBody(BaseModel):
    price_per_kwh: float

class CostBody(BaseModel):
    cost_per_kwh: float


@router.patch("/chargers/{charge_point_id}/price")
async def update_price(
    charge_point_id: str,
    body: PriceBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if body.price_per_kwh <= 0:
        raise HTTPException(400, "El precio debe ser mayor a 0")
    charger.price_per_kwh = body.price_per_kwh
    await db.commit()
    final = price_to_conductor(body.price_per_kwh)
    return {
        "price_per_kwh": body.price_per_kwh,
        "price_to_user": round(final),
        "breakdown": {
            "base": body.price_per_kwh,
            "comision_cpo": round(body.price_per_kwh * PLATFORM_MARGIN),
            "iva": round(body.price_per_kwh * (1 + PLATFORM_MARGIN) * IVA_RATE),
            "pasarela": round(body.price_per_kwh * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * GATEWAY_FEE),
            "total": round(final),
        }
    }


class PeakPriceBody(BaseModel):
    peak_price_per_kwh: float | None = None   # None = quitar tarifa pico (tarifa única)


@router.patch("/chargers/{charge_point_id}/peak-price")
async def update_peak_price(
    charge_point_id: str,
    body: PeakPriceBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    if body.peak_price_per_kwh is not None and body.peak_price_per_kwh <= 0:
        raise HTTPException(400, "El precio pico debe ser mayor a 0 (o null para quitarlo)")
    charger.peak_price_per_kwh = body.peak_price_per_kwh
    await db.commit()
    return {
        "price_per_kwh": charger.price_per_kwh,
        "peak_price_per_kwh": charger.peak_price_per_kwh,
        "peak_window": "18:00–22:00 (hora Colombia)",
    }


@router.patch("/chargers/{charge_point_id}/cost")
async def update_cost(
    charge_point_id: str,
    body: CostBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    charger = await db.get(Charger, charge_point_id)
    if not charger:
        raise HTTPException(404, "Cargador no encontrado")
    if charger.owner_id != current_user.id:
        raise HTTPException(403, "No es tu cargador")
    charger.cost_per_kwh = body.cost_per_kwh
    await db.commit()
    margin_cop = round((charger.price_per_kwh or 0) - body.cost_per_kwh)
    return {"cost_per_kwh": body.cost_per_kwh, "margin_cop_per_kwh": margin_cop}

