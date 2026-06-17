"""Configuracion: constantes de negocio, env, seeds y helpers puros."""
import os
from zoneinfo import ZoneInfo

PLATFORM_MARGIN = 0.15   # 15% comisión Faro (modelo nuevo)
IVA_RATE        = 0.19   # IVA Colombia
GATEWAY_FEE     = 0.03   # (legado; en wallet la pasarela va en la recarga, no por sesión)

# Tarifa real de Wompi por transacción (la asume FARO en cada recarga del wallet).
WOMPI_FEE_PCT       = 0.0265   # 2,65%
WOMPI_FEE_FIXED_COP = 700      # + $700 fijo

WOMPI_MIN_CENTS         = 150_000  # $1.500 COP — monto mínimo que acepta Wompi
CHARGE_MAX_ATTEMPTS     = 8        # reintentos de cobro antes de pasar a revisión manual
OFFLINE_SESSION_TIMEOUT = 300      # s sin señal del cargador antes de cerrar su sesión huérfana

# ── Modelo de plata "bolsas internas" (Modelo A — comisionista) ───────────────
# El conductor paga SOLO la recarga + IVA. La comisión y la pasarela se DEBITAN
# del saldo (bolsa) del dueño. Cada cobro CAPTURED se reparte en cuentas internas:
#   wallet:owner:<id>  → lo que Faro le debe al dueño (pasivo)
#   revenue:faro       → ingreso de Faro (comisión + mensualidad)
#   tax:iva            → IVA de los servicios de Faro, por girar a la DIAN
ACCT_FARO_REVENUE = "revenue:faro"   # bolsa de ingresos de Faro (comisión)
ACCT_FARO_IVA     = "tax:iva"        # bolsa de IVA recaudado por Faro (a la DIAN)
ACCT_FARO_GATEWAY = "cost:gateway"   # bolsa de costo de pasarela que Faro ASUME (negativa)

# Quién asume el costo de pasarela (3%): "owner" (se descuenta de su saldo) o
# "faro" (lo absorbe Faro como costo). Default: el dueño, para no erosionar margen.
GATEWAY_BORNE_BY = os.getenv("GATEWAY_BORNE_BY", "owner").lower()

# Mensualidad de plataforma por cargador: $50.000, o $30.000 si el dueño tiene
# MÁS de 5 cargadores. Igual para todos los segmentos.
SUBSCRIPTION_COP          = int(os.getenv("SUBSCRIPTION_COP", "50000"))         # 1–5 cargadores
SUBSCRIPTION_COP_5PLUS    = int(os.getenv("SUBSCRIPTION_COP_5PLUS", "30000"))   # >5 cargadores
SUBSCRIPTION_5PLUS_FROM   = int(os.getenv("SUBSCRIPTION_5PLUS_FROM", "5"))      # umbral

def monthly_fee_cop(n_chargers: int) -> int:
    """Mensualidad total del dueño según cuántos cargadores tenga."""
    rate = SUBSCRIPTION_COP_5PLUS if n_chargers > SUBSCRIPTION_5PLUS_FROM else SUBSCRIPTION_COP
    return rate * n_chargers

# Exigir correo verificado para iniciar sesión. Los usuarios sembrados y el admin
# se crean ya verificados, así que esto solo afecta a registros nuevos sin confirmar.
REQUIRE_EMAIL_VERIFICATION = os.getenv("REQUIRE_EMAIL_VERIFICATION", "true").lower() == "true"

# ── Wallet / saldo prepago del conductor ──────────────────────────────────────
WALLET_TOPUP_DEFAULT_COP = int(os.getenv("WALLET_TOPUP_DEFAULT_COP", "50000"))  # recarga sugerida
WALLET_MIN_TOPUP_COP     = int(os.getenv("WALLET_MIN_TOPUP_COP", "5000"))       # recarga mínima

MIN_WITHDRAW_COP        = 1_000    # retiro manual mínimo del dueño
SETTLEMENT_DAYS         = (5, 20)  # días de corte: giro automático (siguiente día hábil Colombia)
SETTLE_CHECK_INTERVAL   = 3600     # el job revisa cada hora si hoy es día de giro
# Pago automático a dueños (job días 5/20). Desactivado: los pagos se hacen
# manualmente desde el back-office. Activar con AUTO_SETTLEMENT=true.
AUTO_SETTLEMENT         = os.getenv("AUTO_SETTLEMENT", "false").lower() == "true"

# ── Separación / reserva de cargador ──────────────────────────────────────────
# El conductor "separa" un cargador: se RETIENE (no se cobra) una garantía en su
# tarjeta. Si llega y carga → solo se captura la cuota fija (el resto se libera).
# Si no llega (vence ventana + gracia) → se captura toda la garantía como multa
# que compensa al dueño por el espacio bloqueado.
RESERVE_MINUTES          = 20      # duración de la ventana de separación
RESERVE_GRACE_MINUTES    = 5       # gracia extra antes de marcar no-show (25 min total)
RESERVE_FEE_FACTOR       = 0.35    # fracción del valor de energía bloqueada que se retiene
RESERVE_FEE_MIN_COP      = 1_500   # mínimo (coincide con el mínimo de Wompi)
RESERVE_FEE_CAP_COP      = 8_000   # tope para no asustar al conductor
RESERVE_CONVENIENCE_COP  = 1_500   # cuota fija si SÍ llega (= mínimo Wompi; el resto se libera)
RESERVE_CHECK_INTERVAL   = 30      # s — cada cuánto el worker revisa reservas vencidas

# URL pública del WebSocket OCPP — lo que el dueño configura en su cargador
PUBLIC_WS_BASE = os.getenv("PUBLIC_WS_BASE", "wss://preseason-constable-sappiness.ngrok-free.dev/ocpp")

def ocpp_url(charger_id: str) -> str:
    return f"{PUBLIC_WS_BASE}/{charger_id}"


def price_to_conductor(price_per_kwh: float, responsable_iva: bool = True) -> float:
    """Precio final que paga el conductor por kWh (Modelo A): recarga + IVA.
    La comisión y la pasarela NO se le suman al conductor — se descuentan del
    saldo del dueño en la liquidación. Si el dueño no es responsable de IVA,
    la recarga no lleva IVA."""
    return price_per_kwh * (1 + IVA_RATE) if responsable_iva else price_per_kwh

ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS",
    "https://faroenergy.lat,https://admin.faroenergy.lat,"
    "http://localhost:5173,http://localhost:5174,http://localhost:3000",
).split(",") if o.strip()]


BOGOTA = ZoneInfo("America/Bogota")
_PERIOD_HOURS = {"today": None, "week": 24 * 7, "month": 24 * 30}

SEED_DEMO_USERS = os.getenv("SEED_DEMO_USERS", "true").lower() == "true"
SEED_PASSWORD   = os.getenv("SEED_PASSWORD", "1234")

SEED_OWNERS = [
    {"email": "1017felipe@gmail.com",  "name": "felipe_Cargadores", "role": "owner"},
    {"email": "felip_1017@outlook.com", "name": "Felipe_Conductor",  "role": "conductor"},
] if SEED_DEMO_USERS else []
# El admin (faro.energy.26@gmail.com) se crea por ADMIN_EMAIL, no aquí.
# 10 cargadores en Medellín, todos del dueño felipe_Cargadores.
# Se siembran al arrancar si no existen (idempotente). Los simuladores
# arrancan solos para cada uno. Precio en COP/kWh (base del dueño).
SEED_CHARGERS = [
    # ── Carlos (5) ──
    {"id": "FARO-MED-01", "owner": "1017felipe@gmail.com", "location": "CC El Tesoro, El Poblado", "lat": 6.1959, "lng": -75.5550, "power_kw": 50,  "connector": "CCS2",   "price": 1900, "cost": 750},
    {"id": "FARO-MED-02", "owner": "1017felipe@gmail.com", "location": "CC Santafé, El Poblado",   "lat": 6.1976, "lng": -75.5736, "power_kw": 22,  "connector": "Type 2", "price": 1500, "cost": 700},
    {"id": "FARO-MED-03", "owner": "1017felipe@gmail.com", "location": "Parque Lleras, El Poblado", "lat": 6.2092, "lng": -75.5680, "power_kw": 11,  "connector": "Type 2", "price": 1400, "cost": 680},
    {"id": "FARO-MED-04", "owner": "1017felipe@gmail.com", "location": "Universidad de Antioquia",  "lat": 6.2675, "lng": -75.5686, "power_kw": 7.4, "connector": "Type 2", "price": 1300, "cost": 650},
    {"id": "FARO-MED-05", "owner": "1017felipe@gmail.com", "location": "Estadio Atanasio Girardot", "lat": 6.2566, "lng": -75.5903, "power_kw": 150, "connector": "CCS2",   "price": 2000, "cost": 800},
    # ── Juanes (5) ──
    {"id": "FARO-MED-06", "owner": "1017felipe@gmail.com", "location": "CC Oviedo, El Poblado",     "lat": 6.1985, "lng": -75.5605, "power_kw": 50,  "connector": "CCS2",   "price": 1850, "cost": 740},
    {"id": "FARO-MED-07", "owner": "1017felipe@gmail.com", "location": "CC Premium Plaza, Aguacatala","lat": 6.2245, "lng": -75.5760, "power_kw": 22,  "connector": "Type 2", "price": 1550, "cost": 710},
    {"id": "FARO-MED-08", "owner": "1017felipe@gmail.com", "location": "CC Unicentro, Laureles",    "lat": 6.2447, "lng": -75.5920, "power_kw": 22,  "connector": "Type 2", "price": 1500, "cost": 700},
    {"id": "FARO-MED-09", "owner": "1017felipe@gmail.com", "location": "Aeropuerto Olaya Herrera",  "lat": 6.2197, "lng": -75.5905, "power_kw": 11,  "connector": "Type 2", "price": 1450, "cost": 690},
    {"id": "FARO-MED-10", "owner": "1017felipe@gmail.com", "location": "CC Los Molinos, Belén",     "lat": 6.2308, "lng": -75.6044, "power_kw": 150, "connector": "CCS2",   "price": 1950, "cost": 790},
]

# Perfiles de marca — cada uno en su archivo brand_profiles/<id>.json.
# Agregar una marca nueva = agregar un JSON, sin tocar código.
import json as _json
from pathlib import Path as _Path

_BRAND_DIR = _Path(__file__).parent / "brand_profiles"
SEED_BRAND_PROFILES = [
    _json.loads(f.read_text(encoding="utf-8"))
    for f in sorted(_BRAND_DIR.glob("*.json"))
]
