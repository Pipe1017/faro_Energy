import json
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import String, Float, DateTime, Integer, ForeignKey, Boolean, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
from config import RESERVE_CONVENIENCE_COP

BOGOTA_TZ = ZoneInfo("America/Bogota")
PEAK_START_HOUR = 18   # franja pico Colombia: 18:00–22:00 hora Bogotá
PEAK_END_HOUR   = 22


def new_uuid() -> str:
    return str(uuid.uuid4())


import secrets as _secrets
# Alfabeto sin confusables (sin 0/O/1/I/L). El idTag OCPP cabe en 20 chars; usamos 10.
_TAG_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

def new_tag(n: int = 10) -> str:
    """Identificador corto y único del usuario para usar como idTag de OCPP."""
    return "".join(_secrets.choice(_TAG_ALPHABET) for _ in range(n))


def mask_email(email: str | None) -> str | None:
    """conductor1@cpo.com → c***@cpo.com — /status es público, el email no."""
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    return f"{local[0]}***@{domain}"


class User(Base):
    __tablename__ = "users"
    # Único por (email, rol): un correo puede tener UNA cuenta de conductor y UNA
    # de dueño, pero no dos del mismo rol.
    __table_args__ = (UniqueConstraint("email", "role", name="uq_user_email_role"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String)   # el índice único (email, role) cubre las búsquedas
    name: Mapped[str] = mapped_column(String)
    password_hash: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)  # "conductor" | "owner"
    tag: Mapped[str | None] = mapped_column(String, unique=True, index=True, default=new_tag)  # idTag OCPP (corto, único)
    # Datos fiscales del dueño (para facturación por mandato y para decidir si la
    # recarga lleva IVA). responsable_iva=True por defecto: la mayoría de comercios
    # lo son; el onboarding lo confirma.
    rut: Mapped[str | None] = mapped_column(String, nullable=True)
    responsable_iva: Mapped[bool] = mapped_column(Boolean, default=True)
    # Verificación de correo (ingreso con correos reales)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verify_token: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    # Suscripción de plataforma (dueños): si la mensualidad NO está al día, sus
    # cargadores se ocultan/bloquean. paid_until = hasta cuándo está cubierta.
    subscription_active: Mapped[bool] = mapped_column(Boolean, default=True)
    subscription_paid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Habeas Data (Ley 1581): consentimiento de T&C y Política de Privacidad.
    # Guardamos cuándo y qué versión aceptó (prueba del consentimiento).
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    terms_version: Mapped[str | None] = mapped_column(String, nullable=True)
    # Restablecer contraseña: token de un solo uso con expiración.
    reset_token: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    reset_expires: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    chargers: Mapped[list["Charger"]] = relationship("Charger", back_populates="owner")


# ── Perfil de marca de cargador ───────────────────────────────────────────────
# Estandariza la conexión según el fabricante: qué features OCPP soporta,
# sus quirks, y la guía de configuración que ve el dueño al vincularlo.
# El matching es automático: el BootNotification trae vendor/model.

class ChargerBrandProfile(Base):
    __tablename__ = "charger_brand_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True)        # "wallbox-pulsar-plus"
    vendor: Mapped[str] = mapped_column(String, index=True)          # como llega en BootNotification
    model: Mapped[str | None] = mapped_column(String, nullable=True) # NULL = aplica a todo el vendor
    display_name: Mapped[str] = mapped_column(String)
    ocpp_version: Mapped[str] = mapped_column(String, default="1.6J")
    connector_types: Mapped[str | None] = mapped_column(String, nullable=True)  # JSON: ["Type 2"]
    max_power_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    features: Mapped[str | None] = mapped_column(Text, nullable=True)   # JSON: {"remote_start": true, ...}
    quirks: Mapped[str | None] = mapped_column(Text, nullable=True)     # JSON: {"heartbeat_interval": 300, ...}
    setup_guide_md: Mapped[str | None] = mapped_column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "vendor": self.vendor,
            "model": self.model,
            "display_name": self.display_name,
            "ocpp_version": self.ocpp_version,
            "connector_types": json.loads(self.connector_types) if self.connector_types else [],
            "max_power_kw": self.max_power_kw,
            "features": json.loads(self.features) if self.features else {},
            "quirks": json.loads(self.quirks) if self.quirks else {},
            "setup_guide_md": self.setup_guide_md,
        }


class Charger(Base):
    __tablename__ = "chargers"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # OCPP id, e.g. FARO-7K2M
    owner_id: Mapped[str | None] = mapped_column(String, ForeignKey("users.id"), nullable=True)
    location: Mapped[str] = mapped_column(String, default="Sin ubicación")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String, default="Offline")
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    vendor: Mapped[str | None] = mapped_column(String, nullable=True)            # del BootNotification
    brand_profile_id: Mapped[str | None] = mapped_column(String, nullable=True)  # match automático o elegido por el dueño
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Specs técnicas
    power_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    connector_type: Mapped[str | None] = mapped_column(String, nullable=True)
    price_per_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)   # COP — precio base (valle)
    peak_price_per_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)  # COP — franja pico 18-22h (NULL = tarifa única)
    cost_per_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)    # COP — lo que paga el dueño a la electrica

    def price_at(self, dt: datetime | None = None) -> float:
        """Precio base vigente según la franja horaria (hora Bogotá)."""
        if not self.peak_price_per_kwh:
            return self.price_per_kwh or 0
        hour = (dt or datetime.now(timezone.utc)).astimezone(BOGOTA_TZ).hour
        return self.peak_price_per_kwh if PEAK_START_HOUR <= hour < PEAK_END_HOUR else (self.price_per_kwh or 0)

    # Runtime session state
    active_transaction: Mapped[int | None] = mapped_column(Integer, nullable=True)
    session_user: Mapped[str | None] = mapped_column(String, nullable=True)
    session_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)
    meter_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Live de la sesión en curso (de los MeterValues): potencia y % de batería (SoC,
    # solo si el cargador/carro lo reportan — típico en DC, casi nunca en AC).
    current_power_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_soc: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Calificación discreta: contadores 👍/👎 (denormalizados para leer barato)
    rating_up: Mapped[int] = mapped_column(Integer, default=0)
    rating_down: Mapped[int] = mapped_column(Integer, default=0)

    owner: Mapped["User | None"] = relationship("User", back_populates="chargers")
    sessions: Mapped[list["Session"]] = relationship("Session", back_populates="charger")

    def to_dict(self, public: bool = False) -> dict:
        """public=True (listado global /status): omite los datos de la sesión en
        curso (quién carga, cuánto lleva) — privacidad. Solo deja status, que es
        info operativa legítima (ocupado/libre). public=False: dueño/conductor
        viendo lo suyo, sí incluye el detalle de la sesión."""
        d = {
            "id": self.id,
            "owner": self.owner.name if self.owner else None,
            "owner_id": self.owner_id,
            "location": self.location,
            "lat": self.lat,
            "lng": self.lng,
            "status": self.status,
            "model": self.model,
            "vendor": self.vendor,
            "brand_profile_id": self.brand_profile_id,
            "power_kw": self.power_kw,
            "connector_type": self.connector_type,
            "price_per_kwh": self.price_per_kwh,
            "peak_price_per_kwh": self.peak_price_per_kwh,
            "price_per_kwh_now": self.price_at(),   # precio vigente en este momento (franja)
            "cost_per_kwh": self.cost_per_kwh,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "last_kwh": self.last_kwh,
            "rating_up": self.rating_up or 0,
            "rating_down": self.rating_down or 0,
            "rating_total": (self.rating_up or 0) + (self.rating_down or 0),
            "rating_pct": (
                round((self.rating_up or 0) * 100 / ((self.rating_up or 0) + (self.rating_down or 0)))
                if ((self.rating_up or 0) + (self.rating_down or 0)) else None
            ),
        }
        if not public:
            d.update({
                "active_transaction": self.active_transaction,
                "session_user": self.session_user,
                "session_started_at": self.session_started_at.isoformat() if self.session_started_at else None,
                "current_kwh": self.current_kwh,
                "current_power_kw": self.current_power_kw,
                "current_soc": self.current_soc,
            })
        return d


class ChargerPhoto(Base):
    """Fotos del cargador subidas por el dueño (guardadas en MinIO / fallback local).
    El conductor las ve al tocar el cargador. Los bytes viven en storage; aquí solo
    el metadato y la llave del objeto."""
    __tablename__ = "charger_photos"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    charger_id: Mapped[str] = mapped_column(String, ForeignKey("chargers.id"), index=True)
    storage_key: Mapped[str] = mapped_column(String)            # llave del objeto en MinIO
    content_type: Mapped[str] = mapped_column(String, default="image/jpeg")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        # URL relativa; el cliente le antepone su API base. El endpoint de bytes es
        # público (sin token) para que el componente <Image> pueda cargarlo por URL.
        return {"id": self.id, "charger_id": self.charger_id,
                "url": f"/chargers/{self.charger_id}/photos/{self.id}"}


class Reservation(Base):
    __tablename__ = "reservations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    charger_id: Mapped[str] = mapped_column(String, ForeignKey("chargers.id"))
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"))
    ocpp_reservation_id: Mapped[int] = mapped_column(Integer)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # no_show_at = end_time + gracia. Pasado este instante sin sesión, se cobra la multa.
    no_show_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # active | fulfilled | no_show | cancelled | released
    #   fulfilled = llegó y cargó (se capturó la cuota fija)
    #   no_show   = no llegó (se capturó la garantía completa = multa)
    #   cancelled = el conductor canceló a tiempo (se liberó la retención)
    #   released  = se liberó sin cobro por causa externa (cargador offline, etc.)
    status: Mapped[str] = mapped_column(String, default="active")
    # Plata: garantía retenida y lo realmente capturado al cerrar la reserva.
    fee_cents: Mapped[int] = mapped_column(Integer, default=0)          # garantía retenida
    captured_cents: Mapped[int] = mapped_column(Integer, default=0)     # capturado al final (cuota o multa)
    wompi_preauth_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payment_tx_id: Mapped[str | None] = mapped_column(String, ForeignKey("payment_transactions.id"), nullable=True)
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    settled: Mapped[bool] = mapped_column(Boolean, default=False)       # ya se procesó el desenlace (idempotencia)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    charger: Mapped["Charger"] = relationship("Charger")
    user: Mapped["User"] = relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "charger_id": self.charger_id,
            "location": self.charger.location if self.charger else None,
            "user_id": self.user_id,
            "user_name": self.user.name if self.user else None,
            "start_time": self.start_time.isoformat(),
            "end_time": self.end_time.isoformat(),
            "no_show_at": self.no_show_at.isoformat() if self.no_show_at else None,
            "status": self.status,
            "fee_cop": self.fee_cents // 100,
            "captured_cop": self.captured_cents // 100,
            "convenience_cop": RESERVE_CONVENIENCE_COP,
        }


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    charger_id: Mapped[str] = mapped_column(String, ForeignKey("chargers.id"))
    session_user: Mapped[str | None] = mapped_column(String, nullable=True)
    kwh_delivered: Mapped[float] = mapped_column(Float)
    price_per_kwh: Mapped[float] = mapped_column(Float)       # precio base del dueño
    price_to_user: Mapped[float] = mapped_column(Float)       # precio final/kWh al conductor = precio_base × (1 + IVA)
    revenue_owner: Mapped[float] = mapped_column(Float)         # ingreso bruto del dueño (precio_base × kWh)
    commission_cpo: Mapped[float] = mapped_column(Float)       # comisión Faro (PLATFORM_MARGIN, hoy 15%) sobre la base
    iva_amount: Mapped[float] = mapped_column(Float, default=0)         # IVA 19%
    gateway_fee: Mapped[float] = mapped_column(Float, default=0)        # pasarela 3%
    total_charged: Mapped[float] = mapped_column(Float)        # total final cobrado al conductor
    electricity_cost: Mapped[float] = mapped_column(Float, default=0)   # costo electricidad estimado
    net_profit_owner: Mapped[float] = mapped_column(Float, default=0)   # ganancia neta del dueño
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    charger: Mapped["Charger"] = relationship("Charger", back_populates="sessions")
    payment: Mapped["PaymentTransaction | None"] = relationship("PaymentTransaction", back_populates="session", uselist=False)
    disbursement: Mapped["DisbursementRecord | None"] = relationship("DisbursementRecord", back_populates="session", uselist=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "charger_id": self.charger_id,
            "location": self.charger.location if self.charger else None,
            "session_user": self.session_user,
            "kwh_delivered": round(self.kwh_delivered, 3),
            "price_per_kwh": self.price_per_kwh,
            "price_to_user": self.price_to_user,
            "revenue_owner": round(self.revenue_owner),
            "commission_cpo": round(self.commission_cpo),
            "iva_amount": round(self.iva_amount),
            "gateway_fee": round(self.gateway_fee),
            "electricity_cost": round(self.electricity_cost),
            "net_profit_owner": round(self.net_profit_owner),
            "total_charged": round(self.total_charged),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat(),
        }


# ── Métodos de pago del conductor ─────────────────────────────────────────────

class PaymentMethod(Base):
    __tablename__ = "payment_methods"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String)          # CARD | NEQUI
    wompi_token: Mapped[str | None] = mapped_column(String, nullable=True)          # fallback: token de un solo uso
    wompi_payment_source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # ID persistente en Wompi
    display: Mapped[str] = mapped_column(String)       # "Visa •••• 4242"
    brand: Mapped[str | None] = mapped_column(String, nullable=True)         # VISA | MASTERCARD
    nickname: Mapped[str | None] = mapped_column(String, nullable=True)      # nombre personalizado del usuario
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    user: Mapped["User"] = relationship("User")

    def to_dict(self) -> dict:
        return {"id": self.id, "type": self.type, "display": self.display, "brand": self.brand, "nickname": self.nickname, "is_default": self.is_default}


# ── Cuenta de dispersión del dueño ────────────────────────────────────────────

class DisbursementAccount(Base):
    __tablename__ = "disbursement_accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), unique=True)
    type: Mapped[str] = mapped_column(String)          # NEQUI | BANK
    phone: Mapped[str | None] = mapped_column(String, nullable=True)
    account_number: Mapped[str | None] = mapped_column(String, nullable=True)
    bank_code: Mapped[str | None] = mapped_column(String, nullable=True)
    account_type: Mapped[str | None] = mapped_column(String, nullable=True)  # SAVINGS | CHECKING
    holder_name: Mapped[str] = mapped_column(String)
    holder_id: Mapped[str] = mapped_column(String)     # cédula
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    user: Mapped["User"] = relationship("User")

    def to_dict(self) -> dict:
        display = f"Nequi {self.phone}" if self.type == "NEQUI" else f"Banco {self.bank_code} •••• {(self.account_number or '')[-4:]}"
        return {
            "id": self.id, "type": self.type, "display": display,
            "holder_name": self.holder_name, "verified": self.verified,
            "verified_at": self.verified_at.isoformat() if self.verified_at else None,
        }


# ── Transacción de pago del conductor ─────────────────────────────────────────

class PaymentTransaction(Base):
    __tablename__ = "payment_transactions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    charger_id: Mapped[str] = mapped_column(String, ForeignKey("chargers.id"))
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"))
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    reference: Mapped[str] = mapped_column(String, unique=True, index=True)
    wompi_payment_source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)   # payment_source de la tarjeta guardada
    wompi_preauth_id: Mapped[int | None] = mapped_column(Integer, nullable=True)          # payment_source de la pre-autorización (retención)
    wompi_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)        # ID de la transacción de captura
    amount_cents: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String, default="PENDING")   # PENDING | APPROVED | CAPTURED | DECLINED | VOID
    payment_type: Mapped[str] = mapped_column(String)                # CARD
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    session: Mapped["Session | None"] = relationship("Session", back_populates="payment")

    def to_dict(self) -> dict:
        return {"id": self.id, "reference": self.reference, "amount_cents": self.amount_cents,
                "status": self.status, "payment_type": self.payment_type, "wompi_id": self.wompi_id}


# ── Cobro pendiente (outbox) ──────────────────────────────────────────────────
# Al terminar una sesión se registra aquí el cobro a ejecutar. Un worker lo
# procesa con reintentos — si el backend se reinicia, ningún cobro se pierde.

class PendingCharge(Base):
    __tablename__ = "pending_charges"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    session_id: Mapped[int] = mapped_column(Integer, ForeignKey("sessions.id"))
    payment_tx_id: Mapped[str | None] = mapped_column(String, ForeignKey("payment_transactions.id"), nullable=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String, default="PENDING")  # PENDING | WAITING_CONFIRM | DONE | UNPAID | REVIEW
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    wompi_tx_id: Mapped[str | None] = mapped_column(String, nullable=True)   # tx creada en Wompi, esperando confirmación
    last_error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id, "session_id": self.session_id, "amount_cop": self.amount_cents // 100,
            "status": self.status, "attempts": self.attempts, "last_error": self.last_error,
            "created_at": self.created_at.isoformat(),
        }


# ── Registro de dispersión al dueño ───────────────────────────────────────────

class DisbursementRecord(Base):
    __tablename__ = "disbursement_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    # NULL = liquidación de saldo acumulado (agrupa varias sesiones vía ledger)
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    owner_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"))
    amount_cents: Mapped[int] = mapped_column(Integer)
    wompi_disbursement_id: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="PENDING")   # PENDING | SENT | FAILED | PENDING_ACTIVATION
    method: Mapped[str] = mapped_column(String, default="WOMPI")     # WOMPI | MANUAL
    note: Mapped[str | None] = mapped_column(String, nullable=True)  # referencia del pago manual
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    session: Mapped["Session | None"] = relationship("Session", back_populates="disbursement")

    def to_dict(self) -> dict:
        return {
            "id": self.id, "session_id": self.session_id, "owner_id": self.owner_id,
            "amount_cop": self.amount_cents // 100, "status": self.status,
            "method": self.method, "note": self.note,
            "wompi_disbursement_id": self.wompi_disbursement_id,
            "created_at": self.created_at.isoformat(),
        }


# ── Eventos del dueño (centro de alertas in-app) ─────────────────────────────
# Push remoto no funciona en Expo Go (SDK 53+) — estas alertas se consultan
# desde la app; cuando haya dev build, el mismo registro alimentará el push.

class OwnerEvent(Base):
    __tablename__ = "owner_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    owner_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True)
    charger_id: Mapped[str | None] = mapped_column(String, nullable=True)
    type: Mapped[str] = mapped_column(String)   # CHARGER_OFFLINE | SESSION_STARTED | SESSION_COMPLETED | PAYMENT_UNPAID | SETTLEMENT_SENT
    message: Mapped[str] = mapped_column(String)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id, "type": self.type, "charger_id": self.charger_id,
            "message": self.message, "read": self.read,
            "created_at": self.created_at.isoformat(),
        }


# ── Libro mayor / bolsas (ledger) ─────────────────────────────────────────────
# Cada movimiento de plata queda registrado con monto FIRMADO. Hay dos clases
# de bolsa (cuenta), según owner_id:
#   • Bolsa del dueño (owner_id = su id, account NULL): es su saldo = lo que Faro
#     le debe. EARNING (+ recarga cobrada), COMMISSION/GATEWAY/SUBSCRIPTION (−),
#     DISBURSEMENT (− al liquidar). Saldo dueño = SUM(amount_cents WHERE owner_id).
#   • Bolsa de Faro (owner_id NULL, account = "revenue:faro" | "tax:iva"):
#     ingresos de la plataforma e IVA por girar a la DIAN.
# La suma de todas las bolsas de una sesión = lo recaudado del conductor (cuadra).

class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    owner_id: Mapped[str | None] = mapped_column(String, ForeignKey("users.id"), index=True, nullable=True)
    account: Mapped[str | None] = mapped_column(String, nullable=True, index=True)  # bolsa de Faro: "revenue:faro" | "tax:iva"
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    disbursement_id: Mapped[str | None] = mapped_column(String, ForeignKey("disbursement_records.id"), nullable=True)
    # EARNING | COMMISSION | GATEWAY | SUBSCRIPTION | DISBURSEMENT | ADJUSTMENT
    # | COMMISSION_INCOME | SUBSCRIPTION_INCOME | IVA_COLLECTED
    type: Mapped[str] = mapped_column(String)
    amount_cents: Mapped[int] = mapped_column(Integer)   # firmado: ingresos > 0, cargos/giros < 0
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id, "type": self.type, "amount_cop": self.amount_cents // 100,
            "session_id": self.session_id, "description": self.description,
            "created_at": self.created_at.isoformat(),
        }


# ── Factura electrónica ───────────────────────────────────────────────────────
# Una factura por concepto. La recarga se factura POR MANDATO a nombre del dueño;
# la comisión y la mensualidad las factura Faro al dueño. El PDF/XML emitido por
# el proveedor (DIAN) se guarda en MinIO y se enlaza aquí. Outbox: si la emisión
# falla, el cobro NO se bloquea — un worker reintenta.

class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    kind: Mapped[str] = mapped_column(String)                # RECARGA | COMMISSION | SUBSCRIPTION
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    issuer: Mapped[str] = mapped_column(String)              # "faro" | "owner:<id>" (mandato)
    owner_id: Mapped[str | None] = mapped_column(String, ForeignKey("users.id"), nullable=True)
    recipient_user_id: Mapped[str | None] = mapped_column(String, ForeignKey("users.id"), nullable=True)
    amount_cents: Mapped[int] = mapped_column(Integer)       # base sin IVA
    iva_cents: Mapped[int] = mapped_column(Integer, default=0)
    total_cents: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String, default="stub")   # stub | factus | ...
    provider_invoice_id: Mapped[str | None] = mapped_column(String, nullable=True)
    number: Mapped[str | None] = mapped_column(String, nullable=True)
    cufe: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="PENDING")  # PENDING | ISSUED | FAILED | VOID
    pdf_url: Mapped[str | None] = mapped_column(String, nullable=True)
    xml_url: Mapped[str | None] = mapped_column(String, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "session_id": self.session_id,
            "issuer": self.issuer, "amount_cop": self.amount_cents // 100,
            "iva_cop": self.iva_cents // 100, "total_cop": self.total_cents // 100,
            "status": self.status, "number": self.number, "cufe": self.cufe,
            "pdf_url": self.pdf_url, "created_at": self.created_at.isoformat(),
        }


# ── Calificación de un cargador ───────────────────────────────────────────────
# Discreta: solo 👍/👎 ("¿funcionó bien el servicio?"). Atada a una sesión cerrada
# (one-per-session) → solo quien cargó puede calificar, una sola vez (editable).
# Los contadores agregados viven en Charger.rating_up/down.

class ChargerRating(Base):
    __tablename__ = "charger_ratings"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    charger_id: Mapped[str] = mapped_column(String, ForeignKey("chargers.id"), index=True)
    session_id: Mapped[int] = mapped_column(Integer, ForeignKey("sessions.id"), unique=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True)
    good: Mapped[bool] = mapped_column(Boolean)   # True = 👍, False = 👎
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ── Wallet (saldo prepago del conductor) ──────────────────────────────────────
# Modelo nuevo: el conductor recarga saldo (1 transacción Wompi) y las cargas se
# descuentan de aquí — neutraliza el costo fijo de la pasarela por sesión.
# Saldo = SUM(amount_cents). Firmado: TOPUP/BONUS/REFUND > 0, CHARGE < 0.

class WalletTransaction(Base):
    __tablename__ = "wallet_transactions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String)            # TOPUP | CHARGE | REFUND | BONUS
    amount_cents: Mapped[int] = mapped_column(Integer)   # firmado
    reference: Mapped[str | None] = mapped_column(String, nullable=True)
    wompi_id: Mapped[str | None] = mapped_column(String, nullable=True)
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id, "type": self.type, "amount_cop": self.amount_cents // 100,
            "description": self.description, "session_id": self.session_id,
            "created_at": self.created_at.isoformat(),
        }
