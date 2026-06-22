"""Facturación electrónica — capa de proveedor.

El Modelo A factura por concepto:
  • RECARGA     → por MANDATO, a nombre del dueño, al conductor.
  • COMMISSION  → de Faro al dueño (comisión = PLATFORM_MARGIN).
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
from config import PLATFORM_MARGIN

logger = logging.getLogger(__name__)

INVOICE_PROVIDER = os.getenv("INVOICE_PROVIDER", "stub").lower()

_KIND_LABEL = {
    "RECARGA": "Servicio de recarga de vehículo eléctrico",
    "COMMISSION": f"Comisión de plataforma Faro Energy ({round(PLATFORM_MARGIN * 100)}%)",
    "SUBSCRIPTION": "Suscripción mensual plataforma Faro Energy",
}


def provider_name() -> str:
    return INVOICE_PROVIDER


def _placeholder_pdf(title: str, lines: list[str]) -> bytes:
    """Genera un PDF de una página VÁLIDO (se abre en cualquier visor) con el
    contenido de la factura. Es de PRUEBA — no es una factura DIAN real."""
    def esc(s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    rows = [f"({esc(title)}) Tj", "/F1 11 Tf"]
    y = 770
    for ln in [*lines, "", "*** DOCUMENTO DE PRUEBA - NO VALIDO DIAN ***"]:
        rows.append(f"1 0 0 1 50 {y} Tm")
        rows.append(f"({esc(ln)}) Tj")
        y -= 20
    stream = "BT\n/F1 17 Tf\n1 0 0 1 50 800 Tm\n" + "\n".join(rows) + "\nET"

    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    out = "%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{body}\nendobj\n"
    xref_at = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n"
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    return out.encode("latin-1")


def render_invoice_pdf(inv) -> bytes:
    """Genera (al vuelo) el PDF de una factura desde sus datos. Lo usa el stub para
    emitir y el back-office para mostrar/regenerar facturas de prueba."""
    label = _KIND_LABEL.get(inv.kind, inv.kind)
    number = inv.number or f"STUB-{inv.kind[:3]}-{inv.id[:8].upper()}"
    cufe = inv.cufe or hashlib.sha256(f"{inv.id}|{inv.total_cents}".encode()).hexdigest()
    return _placeholder_pdf(f"Factura {number}", [
        f"Concepto: {label}",
        f"Emisor: {inv.issuer}",
        f"Base:  ${inv.amount_cents // 100:,} COP",
        f"IVA:   ${inv.iva_cents // 100:,} COP",
        f"Total: ${inv.total_cents // 100:,} COP",
        f"CUFE:  {cufe}",
    ])


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
