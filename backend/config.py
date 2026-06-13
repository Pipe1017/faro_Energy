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

# Perfiles de marca — el catálogo crece a medida que se integran fabricantes.
# El matching usa vendor/model del BootNotification; model NULL aplica a todo el vendor.
SEED_BRAND_PROFILES = [
    {
        "id": "faro-sim", "vendor": "CPO-Colombia", "model": "CPO-Sim-v1",
        "display_name": "Simulador Faro", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 150,
        "features": {"remote_start": True, "remote_stop": True, "reserve": True, "change_availability": True},
        "quirks": {},
        "setup_guide_md": "Cargador virtual para pruebas. Se conecta automáticamente al registrarlo — no requiere configuración.",
    },
    {
        "id": "wallbox-pulsar-plus", "vendor": "Wallbox", "model": "Pulsar Plus",
        "display_name": "Wallbox Pulsar Plus", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": True},
        "quirks": {"heartbeat_interval": 300, "config_via": "portal myWallbox"},
        "setup_guide_md": (
            "1. Entra a my.wallbox.com con la cuenta del cargador\n"
            "2. Selecciona tu Pulsar Plus → Configuración → OCPP\n"
            "3. Activa OCPP y pega la URL que te dimos\n"
            "4. En 'Charge Point ID' escribe el ID asignado por Faro\n"
            "5. Guarda — el cargador se reinicia y aparecerá En línea aquí"
        ),
    },
    {
        "id": "abb-terra-ac", "vendor": "ABB", "model": "Terra AC",
        "display_name": "ABB Terra AC", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": True, "change_availability": True},
        "quirks": {"config_via": "app TerraConfig"},
        "setup_guide_md": (
            "1. Descarga la app TerraConfig (ABB) y conéctate al cargador por Bluetooth\n"
            "2. Ve a Configuración → OCPP → Servidor\n"
            "3. Pega la URL de Faro y el ID asignado\n"
            "4. Reinicia el cargador desde la app"
        ),
    },
    {
        "id": "growatt-thor", "vendor": "Growatt", "model": None,
        "display_name": "Growatt THOR", "ocpp_version": "1.6J",
        "connector_types": ["Type 2"], "max_power_kw": 22,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": True},
        "quirks": {"config_via": "app ShinePhone"},
        "setup_guide_md": (
            "1. Abre ShinePhone y entra a tu cargador THOR\n"
            "2. Configuración → OCPP Server URL → pega la URL de Faro\n"
            "3. ChargePoint ID = el ID asignado por Faro\n"
            "4. Guarda y espera ~1 minuto a que reconecte"
        ),
    },
    {
        "id": "generic-ocpp16", "vendor": "Genérico", "model": None,
        "display_name": "Genérico OCPP 1.6", "ocpp_version": "1.6J",
        "connector_types": ["Type 2", "CCS2", "CHAdeMO", "Schuko"], "max_power_kw": None,
        "features": {"remote_start": True, "remote_stop": True, "reserve": False, "change_availability": False},
        "quirks": {},
        "setup_guide_md": (
            "Cualquier cargador con OCPP 1.6-J (la mayoría de marcas chinas lo soportan):\n"
            "1. Busca en la app o panel web del fabricante la opción 'OCPP' o 'Backend'\n"
            "2. Pega la URL de Faro como servidor OCPP\n"
            "3. Usa el ID asignado como ChargePoint ID / ChargeBox ID\n"
            "4. Asegúrate de elegir OCPP 1.6 JSON (no SOAP)\n"
            "Si la marca no aparece en nuestro catálogo, escríbenos y la integramos."
        ),
    },
]

