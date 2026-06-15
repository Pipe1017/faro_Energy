"""Facturación electrónica — capa de proveedor.

El Modelo A factura por concepto:
  • RECARGA     → por MANDATO, a nombre del dueño, al conductor.
  • COMMISSION  → de Faro al dueño (comisión 10%).
  • SUBSCRIPTION→ de Faro al dueño (mensualidad).

Hoy hay un StubProvider que simula la emisión (genera CUFE/número falsos y un PDF
placeholder, lo guarda en MinIO). Cuando exista la cuenta sandbox de Factus se
implementa FactusProvider con la misma interfaz `issue(inv) -> dict` y se cambia
INVOICE_PROVIDER=factus — sin tocar el resto del sistema.

Config por env:
  INVOICE_PROVIDER   "stub" (default) | "factus"
  FACTUS_* (cuando se implemente el real)
"""
import os
import hashlib
import logging
from datetime import datetime, timezone

import storage

logger = logging.getLogger(__name__)

INVOICE_PROVIDER = os.getenv("INVOICE_PROVIDER", "stub").lower()

_KIND_LABEL = {
    "RECARGA": "Servicio de recarga de vehículo eléctrico",
    "COMMISSION": "Comisión de plataforma Faro Energy (10%)",
    "SUBSCRIPTION": "Suscripción mensual plataforma Faro Energy",
}


def provider_name() -> str:
    return INVOICE_PROVIDER


def _placeholder_pdf(title: str, lines: list[str]) -> bytes:
    """PDF placeholder mínimo para el stub (no es una factura DIAN real)."""
    body = "\n".join([title, "-" * 40, *lines, "", "*** DOCUMENTO DE PRUEBA — NO VÁLIDO DIAN ***"])
    return ("%PDF-1.4 (stub)\n" + body + "\n%%EOF\n").encode("utf-8")


def _stub_issue(inv) -> dict:
    """Simula la respuesta de un proveedor DIAN."""
    cufe = hashlib.sha256(f"{inv.id}|{inv.total_cents}".encode()).hexdigest()
    number = f"STUB-{inv.kind[:3]}-{inv.id[:8].upper()}"
    label = _KIND_LABEL.get(inv.kind, inv.kind)
    pdf = _placeholder_pdf(f"Factura {number}", [
        f"Concepto: {label}",
        f"Emisor: {inv.issuer}",
        f"Base:  ${inv.amount_cents // 100:,} COP",
        f"IVA:   ${inv.iva_cents // 100:,} COP",
        f"Total: ${inv.total_cents // 100:,} COP",
        f"CUFE:  {cufe}",
    ])
    xml = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<Invoice provider="stub" kind="{inv.kind}">'
        f'<Number>{number}</Number><CUFE>{cufe}</CUFE>'
        f'<Total>{inv.total_cents // 100}</Total></Invoice>'
    ).encode("utf-8")
    return {"provider_invoice_id": number, "number": number, "cufe": cufe,
            "pdf_bytes": pdf, "xml_bytes": xml}


def _issue_with_provider(inv) -> dict:
    if INVOICE_PROVIDER == "stub":
        return _stub_issue(inv)
    # if INVOICE_PROVIDER == "factus": return _factus_issue(inv)   # pendiente
    raise RuntimeError(f"Proveedor de facturación no soportado: {INVOICE_PROVIDER}")


async def issue_invoice(db, inv) -> None:
    """Emite la factura contra el proveedor y guarda PDF/XML en MinIO.
    Actualiza la fila Invoice (status=ISSUED). Lanza excepción si falla (el worker
    cuenta el intento). NO toca la plata: el reparto en bolsas ya ocurrió."""
    res = _issue_with_provider(inv)
    base_key = f"invoices/{inv.kind.lower()}/{inv.id}"
    pdf_url = storage.put_bytes(f"{base_key}.pdf", res["pdf_bytes"], "application/pdf")
    xml_url = storage.put_bytes(f"{base_key}.xml", res["xml_bytes"], "application/xml")

    inv.provider = INVOICE_PROVIDER
    inv.provider_invoice_id = res.get("provider_invoice_id")
    inv.number = res.get("number")
    inv.cufe = res.get("cufe")
    inv.pdf_url = pdf_url
    inv.xml_url = xml_url
    inv.status = "ISSUED"
    inv.issued_at = datetime.now(timezone.utc)
    inv.last_error = None
    logger.info(f"Factura {inv.number} ({inv.kind}) emitida [{INVOICE_PROVIDER}] → {pdf_url}")
