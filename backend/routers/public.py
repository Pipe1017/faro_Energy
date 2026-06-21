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
    # Ocultar del mapa los cargadores de dueños con la mensualidad suspendida.
    visible = [c for c in chargers if c.owner is None or c.owner.subscription_active]
    return {
        "connected": list(connected_chargers.keys()),
        "total": len(visible),
        "chargers": {c.id: c.to_dict(public=True) for c in visible},
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



# ── Cargadores externos (Open Charge Map): públicos que aún no son Faro ────────
_ocm_cache = {"at": None, "data": []}

def _haversine_m(a_lat, a_lng, b_lat, b_lng):
    import math
    R = 6371000
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat); dl = math.radians(b_lng - a_lng)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))


@router.get("/external-chargers")
async def external_chargers(db: AsyncSession = Depends(get_db)):
    """Cargadores públicos a nivel nacional (Open Charge Map) que AÚN NO son Faro.
    Se muestran como 'próximamente' en el mapa. Cacheado para no golpear la API.
    Requiere OCM_API_KEY (gratis en openchargemap.org). Crédito a OCM obligatorio."""
    import httpx
    from config import OCM_API_KEY, OCM_COUNTRY, OCM_MAX_RESULTS, OCM_CACHE_HOURS
    if not OCM_API_KEY:
        return {"chargers": [], "source": None, "attribution": None}

    now = datetime.now(timezone.utc)
    if _ocm_cache["at"] and (now - _ocm_cache["at"]).total_seconds() < OCM_CACHE_HOURS * 3600:
        return {"chargers": _ocm_cache["data"], "source": "openchargemap",
                "attribution": "Datos de Open Charge Map"}

    # Coordenadas de los cargadores Faro para descartar duplicados (~80 m)
    faro = (await db.execute(select(Charger).where(Charger.lat.isnot(None)))).scalars().all()
    faro_pts = [(c.lat, c.lng) for c in faro if c.lat and c.lng]

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get("https://api.openchargemap.io/v3/poi/", params={
                "key": OCM_API_KEY, "countrycode": OCM_COUNTRY,
                "maxresults": OCM_MAX_RESULTS, "compact": "true", "verbose": "false",
                "output": "json",
            })
            r.raise_for_status()
            pois = r.json()
    except Exception as e:
        logger.warning(f"OCM fetch: {e}")
        return {"chargers": _ocm_cache["data"], "source": "openchargemap",
                "attribution": "Datos de Open Charge Map"}

    out = []
    for p in pois:
        ai = p.get("AddressInfo") or {}
        lat, lng = ai.get("Latitude"), ai.get("Longitude")
        if lat is None or lng is None:
            continue
        if any(_haversine_m(lat, lng, fl, fg) < 80 for fl, fg in faro_pts):
            continue  # ya es un cargador Faro
        op = (p.get("OperatorInfo") or {}).get("Title")
        # Potencia máx y tipo de conector desde las conexiones del POI
        conns = p.get("Connections") or []
        powers = [c.get("PowerKW") for c in conns if c.get("PowerKW")]
        power_kw = round(max(powers)) if powers else None
        conn_type = None
        for c in conns:
            ct = (c.get("ConnectionType") or {}).get("Title")
            if ct:
                conn_type = ct
                break
        out.append({
            "id": f"ocm-{p.get('ID')}",
            "lat": lat, "lng": lng,
            "title": ai.get("Title") or "Cargador público",
            "town": ai.get("Town"),
            "address": ai.get("AddressLine1"),
            "operator": op,
            "power_kw": power_kw,
            "connector": conn_type,
            "connections": len(conns) or None,
        })
    _ocm_cache["at"] = now
    _ocm_cache["data"] = out
    logger.info(f"OCM: {len(out)} cargadores externos (no-Faro) cacheados")
    return {"chargers": out, "source": "openchargemap", "attribution": "Datos de Open Charge Map"}


@router.get("/config/public")
async def public_config():
    """Config para el cliente: la llave pública de Wompi es pública por diseño —
    la app la usa para tokenizar la tarjeta directo contra Wompi (PCI)."""
    return {
        "wompi_api": wompi_svc.BASE_URL,
        "wompi_public_key": os.getenv("WOMPI_PUBLIC_KEY", ""),
    }

