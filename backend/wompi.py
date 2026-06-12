"""
Servicio Wompi — cobro a conductores y dispersión a dueños de cargadores.
Sandbox: https://sandbox.wompi.co/v1
"""
import hashlib
import logging
import os

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://sandbox.wompi.co/v1"

def _key(name: str) -> str:
    val = os.getenv(name, "")
    if not val:
        raise RuntimeError(f"Variable de entorno {name} no configurada. Verifica tu .env")
    return val


# ── Utilidades ────────────────────────────────────────────────────────────────

def integrity_hash(reference: str, amount_cents: int, currency: str = "COP") -> str:
    raw = f"{reference}{amount_cents}{currency}{_key('WOMPI_INTEGRITY_SECRET')}"
    return hashlib.sha256(raw.encode()).hexdigest()


def verify_webhook_signature(payload: dict) -> bool:
    try:
        checksum   = payload["signature"]["checksum"]
        properties = payload["signature"]["properties"]
        values = []
        for prop in properties:
            obj = payload["data"]
            for k in prop.split("."):
                obj = obj.get(k, "") if isinstance(obj, dict) else ""
            values.append(str(obj))
        # Wompi: checksum = SHA256(valores de properties + timestamp del evento + secret)
        values.append(str(payload["timestamp"]))
        values.append(_key("WOMPI_EVENTS_SECRET"))
        computed = hashlib.sha256("".join(values).encode()).hexdigest()
        return computed == checksum
    except Exception as e:
        logger.warning(f"Webhook signature error: {e}")
        return False


def _headers(use_public: bool = False) -> dict:
    key = _key("WOMPI_PUBLIC_KEY") if use_public else _key("WOMPI_PRIVATE_KEY")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


async def get_acceptance_tokens() -> tuple[str, str]:
    """
    Obtiene los dos tokens requeridos por Wompi:
    - acceptance_token: aceptación de términos (END_USER_POLICY)
    - personal_data_auth_token: autorización de datos personales (PERSONAL_DATA_AUTH)
    Ambos son obligatorios para crear transacciones.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/merchants/{_key('WOMPI_PUBLIC_KEY')}",
            headers=_headers(use_public=True),
        )
        data = resp.json().get("data", {})
        acceptance = data.get("presigned_acceptance", {}).get("acceptance_token", "")
        personal   = data.get("presigned_personal_data_auth", {}).get("acceptance_token", "")
        if not acceptance:
            logger.warning("No se pudo obtener acceptance_token")
        if not personal:
            logger.warning("No se pudo obtener personal_data_auth_token")
        return acceptance, personal


async def get_acceptance_token() -> str:
    """Compatibilidad: devuelve solo el acceptance_token."""
    acceptance, _ = await get_acceptance_tokens()
    return acceptance


# ── Tarjetas ──────────────────────────────────────────────────────────────────

async def tokenize_card(number: str, cvc: str, exp_month: str, exp_year: str, holder: str) -> dict:
    """
    Tokeniza una tarjeta. El número nunca pasa por nuestros servidores en prod
    (se usa el widget JS), pero en el MVP lo hacemos desde el backend.
    Devuelve el token de Wompi para guardarlo en DB.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/tokens/cards",
            headers=_headers(use_public=True),
            json={
                "number":      number,
                "cvc":         cvc,
                "exp_month":   exp_month,
                "exp_year":    exp_year,
                "card_holder": holder,
            },
        )
        data = resp.json()
        logger.info(f"Tokenize card: {data.get('status')}")
        return data


# ── Pre-autorización y Captura (flujo correcto Wompi Colombia) ────────────────
# Documentación: POST /payment_sources para pre-auth, POST /transactions para captura.
# NO usar capture_mode: MANUAL en /transactions — ese endpoint no soporta captura parcial.

async def save_card_as_payment_source(card_token: str, email: str) -> dict:
    """
    Guarda la tarjeta como fuente de pago persistente y reutilizable.
    Llama esto al agregar una tarjeta para obtener un payment_source_id
    que reemplaza al token de un solo uso.
    """
    acceptance_token, personal_data_token = await get_acceptance_tokens()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/payment_sources",
            headers=_headers(),
            json={
                "type":                 "CARD",
                "customer_email":       email,
                "token":                card_token,
                "acceptance_token":     acceptance_token,
                "accept_personal_auth": personal_data_token,
            },
        )
        data = resp.json()
        ps_id = data.get("data", {}).get("id")
        if resp.status_code not in (200, 201) or not ps_id:
            logger.warning(f"save_payment_source {resp.status_code}: {data}")
        else:
            logger.info(f"Tarjeta guardada como payment_source #{ps_id}")
        return data


async def preauthorize_card(
    amount_cents: int,
    email: str,
    payment_source_id: int,
) -> dict:
    """
    Crea una pre-autorización usando un payment_source_id persistente.
    Devuelve data.id = pre-auth payment_source_id y data.status = PROCESSING.
    Cuando status llegue a AVAILABLE, se puede capturar.
    """
    acceptance_token, personal_data_token = await get_acceptance_tokens()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/payment_sources",
            headers=_headers(),
            json={
                "type":                 "CARD",
                "customer_email":       email,
                "financial_operation":  "PREAUTHORIZATION",
                "payment_source_id":    payment_source_id,
                "acceptance_token":     acceptance_token,
                "accept_personal_auth": personal_data_token,
                "data": {
                    "amount_in_cents": amount_cents,
                    "currency":        "COP",
                },
            },
        )
        data = resp.json()
        ps = data.get("data", {})
        if resp.status_code not in (200, 201):
            logger.warning(f"Pre-auth error {resp.status_code}: {data}")
        else:
            logger.info(f"Pre-auth ps#{ps.get('id')}: {ps.get('status')} (${amount_cents//100:,} COP)")
        return data


async def get_payment_source(payment_source_id: int) -> dict:
    """Consulta el estado de una pre-autorización. Esperar status = AVAILABLE para capturar."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/payment_sources/{payment_source_id}",
            headers=_headers(),
        )
        return resp.json()


async def capture_preauth(
    payment_source_id: int,
    amount_cents: int,
    email: str,
    reference: str,
) -> dict:
    """
    Captura el monto real sobre una pre-autorización AVAILABLE.
    Crea una nueva transacción de tipo CAPTURE. Devuelve data.id = transaction_id.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/transactions",
            headers=_headers(),
            json={
                "amount_in_cents":    amount_cents,
                "public_key":         _key("WOMPI_PUBLIC_KEY"),
                "currency":           "COP",
                "customer_email":     email,
                "reference":          reference,
                "payment_source_id":  payment_source_id,
                "payment_method":     {"installments": 1},
                "signature":          integrity_hash(reference, amount_cents),
            },
        )
        data = resp.json()
        tx = data.get("data", {})
        if resp.status_code not in (200, 201):
            logger.warning(f"Capture ps#{payment_source_id} error {resp.status_code}: {data}")
        else:
            logger.info(f"Capture ps#{payment_source_id}: {tx.get('status')} ${amount_cents//100:,} COP → tx#{tx.get('id')}")
        return data


async def capture_transaction(wompi_id: str, amount_cents: int) -> dict:
    """Captura el monto real al terminar la sesión (máx = monto pre-autorizado)."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{BASE_URL}/transactions/{wompi_id}/capture",
                headers=_headers(),
                json={"amount_in_cents": amount_cents},
            )
            if resp.status_code == 404:
                logger.warning(
                    f"Capture {wompi_id}: 404 — feature NO habilitado en esta cuenta Wompi. "
                    f"Activa 'Captura manual' en sandbox.wompi.co o contáctalos."
                )
                return {"error": "CAPTURE_NOT_ENABLED", "status_code": 404}
            if resp.status_code not in (200, 201, 204):
                body = resp.json() if resp.content else {}
                logger.warning(f"Capture {wompi_id}: HTTP {resp.status_code} — {body}")
                return {"error": body, "status_code": resp.status_code}
            logger.info(f"Capture {wompi_id}: OK ${amount_cents//100:,} COP")
            return resp.json() if resp.content else {"status": "OK"}
    except Exception as e:
        logger.warning(f"Capture {wompi_id} error: {e}")
        return {"error": str(e)}


async def void_transaction(wompi_id: str) -> dict:
    """Anula una pre-autorización."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{BASE_URL}/transactions/{wompi_id}/void",
                headers=_headers(),
            )
            logger.info(f"Void {wompi_id}: {resp.status_code}")
            return resp.json() if resp.content else {"status": "OK"}
    except Exception as e:
        logger.warning(f"Void {wompi_id} error: {e}")
        return {"error": str(e)}


async def get_transaction(wompi_id: str) -> dict:
    """Consulta el estado de una transacción."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/transactions/{wompi_id}",
            headers=_headers(),
        )
        return resp.json()


async def get_transaction_by_reference(reference: str) -> dict | None:
    """
    Busca una transacción por nuestra referencia única.
    Permite recuperar un cobro cuya respuesta se perdió (reintento idempotente):
    si Wompi rechaza la referencia por duplicada, aquí encontramos la tx original.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/transactions",
            headers=_headers(),
            params={"reference": reference},
        )
        txs = resp.json().get("data", [])
        return txs[0] if txs else None


async def get_merchant_transactions(from_date: str = "2020-01-01", until_date: str = "2030-12-31") -> list:
    """Obtiene todas las transacciones del merchant desde la API de Wompi."""
    all_txs = []
    page = 1
    async with httpx.AsyncClient() as client:
        while True:
            resp = await client.get(
                f"{BASE_URL}/transactions",
                headers=_headers(),
                params={"page": page, "page_size": 50, "from_date": from_date, "until_date": until_date},
            )
            data = resp.json()
            txs = data.get("data", [])
            all_txs.extend(txs)
            meta = data.get("meta", {})
            if not txs or page >= (meta.get("total_pages") or 1):
                break
            page += 1
    return all_txs


# ── Dispersión (pago al dueño) ────────────────────────────────────────────────
# NOTA: Wompi requiere activar "Dispersiones" en el panel merchant.
# Mientras no esté activo, el POST /disbursements retorna 404.
# El sistema registra igualmente los montos pendientes para pagarlos cuando se active.

def _parse_disbursement_response(resp: httpx.Response, reference: str) -> dict:
    """El 404 de dispersiones-no-activas llega con cuerpo no-JSON —
    normalizarlo a {'error': ...} para que el caller lo trate como PENDING_ACTIVATION."""
    if resp.status_code == 404:
        logger.warning(f"Disbursement {reference}: 404 — dispersiones no activas en esta cuenta Wompi")
        return {"error": {"type": "NOT_ENABLED", "reason": "Dispersiones no activas en esta cuenta Wompi"}}
    try:
        return resp.json()
    except Exception:
        logger.warning(f"Disbursement {reference}: respuesta no-JSON (HTTP {resp.status_code})")
        return {"error": {"type": "BAD_RESPONSE", "reason": f"HTTP {resp.status_code} sin cuerpo JSON"}}


async def disburse_nequi(reference: str, amount_cents: int, phone: str, description: str) -> dict:
    """
    Envía dinero al Nequi del dueño del cargador.
    Requiere que la cuenta Wompi tenga habilitada la dispersión.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/disbursements",
            headers=_headers(),
            json={
                "reference":       reference,
                "amount_in_cents": amount_cents,
                "currency":        "COP",
                "description":     description,
                "payment_method":  {
                    "type":         "NEQUI",
                    "phone_number": phone,
                },
            },
        )
        data = _parse_disbursement_response(resp, reference)
        logger.info(f"Disbursement {reference} → Nequi {phone}: {data.get('data', {}).get('status') or data.get('error', {}).get('type')}")
        return data


async def disburse_bank(
    reference: str,
    amount_cents: int,
    account_number: str,
    bank_code: str,
    account_type: str,
    holder_name: str,
    holder_id: str,
    description: str,
) -> dict:
    """Envía dinero a cuenta bancaria del dueño."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/disbursements",
            headers=_headers(),
            json={
                "reference":       reference,
                "amount_in_cents": amount_cents,
                "currency":        "COP",
                "description":     description,
                "payment_method":  {
                    "type":            "BANK_TRANSFER",
                    "user_type":       "PERSON",
                    "account_number":  account_number,
                    "financial_institution_code": bank_code,
                    "account_type":    account_type,
                    "holder_name":     holder_name,
                    "holder_id":       holder_id,
                },
            },
        )
        data = _parse_disbursement_response(resp, reference)
        logger.info(f"Disbursement {reference} → banco {bank_code}: {data.get('data', {}).get('status') or data.get('error', {}).get('type')}")
        return data
