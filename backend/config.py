"""Configuracion: constantes de negocio, env, seeds y helpers puros."""
import os
from zoneinfo import ZoneInfo

PLATFORM_MARGIN = 0.10   # 10% comisión CPO
IVA_RATE        = 0.19   # IVA Colombia
GATEWAY_FEE     = 0.03   # pasarela de pagos

WOMPI_MIN_CENTS         = 150_000  # $1.500 COP — monto mínimo que acepta Wompi
CHARGE_MAX_ATTEMPTS     = 8        # reintentos de cobro antes de pasar a revisión manual
OFFLINE_SESSION_TIMEOUT = 300      # s sin señal del cargador antes de cerrar su sesión huérfana

MIN_WITHDRAW_COP        = 1_000    # retiro manual mínimo del dueño
SETTLEMENT_DAYS         = (5, 20)  # días de corte: giro automático (siguiente día hábil Colombia)
SETTLE_CHECK_INTERVAL   = 3600     # el job revisa cada hora si hoy es día de giro

# URL pública del WebSocket OCPP — lo que el dueño configura en su cargador
PUBLIC_WS_BASE = os.getenv("PUBLIC_WS_BASE", "wss://preseason-constable-sappiness.ngrok-free.dev/ocpp")

def ocpp_url(charger_id: str) -> str:
    return f"{PUBLIC_WS_BASE}/{charger_id}"


def price_to_conductor(price_per_kwh: float) -> float:
    """Precio final que paga el conductor por kWh, incluyendo todos los cargos."""
    return price_per_kwh * (1 + PLATFORM_MARGIN) * (1 + IVA_RATE) * (1 + GATEWAY_FEE)

ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "https://faroenergy.lat,http://localhost:5173,http://localhost:3000",
).split(",") if o.strip()]


BOGOTA = ZoneInfo("America/Bogota")
_PERIOD_HOURS = {"today": None, "week": 24 * 7, "month": 24 * 30}

SEED_DEMO_USERS = os.getenv("SEED_DEMO_USERS", "true").lower() == "true"
SEED_PASSWORD   = os.getenv("SEED_PASSWORD", "1234")

SEED_OWNERS = [
    {"email": "admin@cpo.com",      "name": "Admin CPO",   "role": "admin"},
    {"email": "carlos@cpo.com",     "name": "Carlos",      "role": "owner"},
    {"email": "juanes@cpo.com",     "name": "Juanes",      "role": "owner"},
    {"email": "conductor1@cpo.com", "name": "Conductor 1", "role": "conductor"},
    {"email": "conductor2@cpo.com", "name": "Conductor 2", "role": "conductor"},
] if SEED_DEMO_USERS else []
SEED_CHARGERS = []   # Los dueños agregan sus cargadores desde la app

# Perfiles de marca — cada uno en su archivo brand_profiles/<id>.json.
# Agregar una marca nueva = agregar un JSON, sin tocar código.
import json as _json
from pathlib import Path as _Path

_BRAND_DIR = _Path(__file__).parent / "brand_profiles"
SEED_BRAND_PROFILES = [
    _json.loads(f.read_text(encoding="utf-8"))
    for f in sorted(_BRAND_DIR.glob("*.json"))
]
