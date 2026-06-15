"""Envío de correo transaccional (SMTP).

Arranca con el Gmail de la empresa (faro.energy.26@gmail.com) usando una
"Contraseña de aplicación" (no la clave normal — Google bloquea SMTP con ella).
Cuando crezca el volumen, cambiar a un proveedor con el dominio (no-reply@faroenergy.lat)
solo requiere cambiar las env SMTP_*.

El envío corre en un hilo (smtplib es bloqueante) para no frenar el event loop.
Si no hay credenciales, es un no-op seguro: la app sigue funcionando sin email.

Env:
  SMTP_HOST (default smtp.gmail.com), SMTP_PORT (587)
  SMTP_USER, SMTP_PASSWORD   ← App Password de 16 caracteres
  EMAIL_FROM (default = SMTP_USER), EMAIL_FROM_NAME (default "Faro Energy")
  PUBLIC_API_BASE            ← para los links (default https://api.faroenergy.lat)
"""
import os
import ssl
import smtplib
import asyncio
import logging
from email.message import EmailMessage

logger = logging.getLogger(__name__)

SMTP_HOST       = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT       = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER       = os.getenv("SMTP_USER", "")
SMTP_PASSWORD   = os.getenv("SMTP_PASSWORD", "")
EMAIL_FROM      = os.getenv("EMAIL_FROM", SMTP_USER or "no-reply@faroenergy.lat")
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Faro Energy")
PUBLIC_API_BASE = os.getenv("PUBLIC_API_BASE", "https://api.faroenergy.lat").rstrip("/")


def is_configured() -> bool:
    return bool(SMTP_USER and SMTP_PASSWORD)


def _send_sync(to: str, subject: str, html: str, text: str):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{EMAIL_FROM_NAME} <{EMAIL_FROM}>"
    msg["To"] = to
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        s.starttls(context=ctx)
        s.login(SMTP_USER, SMTP_PASSWORD)
        s.send_message(msg)


async def send_email(to: str, subject: str, html: str, text: str = "") -> bool:
    """Envía un correo. Devuelve True si salió. Nunca lanza: registra y sigue."""
    if not to or "@" not in to:
        return False
    if not is_configured():
        logger.warning(f"SMTP no configurado — email a {to} ('{subject}') NO enviado")
        return False
    try:
        await asyncio.to_thread(_send_sync, to, subject, html, text or "Abre este correo en un cliente con HTML.")
        logger.info(f"✉ Email a {to}: {subject}")
        return True
    except Exception as e:
        logger.warning(f"Error enviando email a {to}: {e}")
        return False


# ── Plantillas (paleta Faro Claro: marfil, cobre, espresso) ─────────────────────

def _layout(title: str, body_html: str, cta_text: str = "", cta_url: str = "") -> str:
    cta = ""
    if cta_text and cta_url:
        cta = (
            f'<tr><td style="padding:8px 0 4px;">'
            f'<a href="{cta_url}" style="display:inline-block;background:#b45309;color:#fdfbf7;'
            f'text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;">{cta_text}</a>'
            f'</td></tr>'
        )
    return f"""\
<!doctype html><html><body style="margin:0;background:#fdfbf7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#2e2620;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfbf7;padding:28px 0;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #ece5dc;border-radius:16px;padding:28px;">
<tr><td style="font-size:22px;font-weight:800;color:#2e2620;padding-bottom:4px;">Faro <span style="color:#b45309;">Energy</span></td></tr>
<tr><td style="font-size:18px;font-weight:700;padding:14px 0 6px;">{title}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#3b332c;">{body_html}</td></tr>
{cta}
<tr><td style="font-size:12px;color:#8a7d72;padding-top:22px;border-top:1px solid #ece5dc;margin-top:18px;">
Faro Energy · Recarga de vehículos eléctricos · faroenergy.lat</td></tr>
</table></td></tr></table></body></html>"""


def verification_email(name: str, token: str) -> tuple[str, str, str]:
    link = f"{PUBLIC_API_BASE}/auth/verify?token={token}"
    html = _layout(
        f"¡Bienvenido, {name}!",
        "Confirma tu correo para activar tu cuenta en Faro Energy. "
        "Solo toma un clic:",
        "Confirmar mi correo", link,
    )
    text = f"Hola {name}, confirma tu correo en Faro Energy: {link}"
    return "Confirma tu correo · Faro Energy", html, text


def receipt_email(name: str, location: str, kwh: float, total_cop: int, invoice_url: str = "") -> tuple[str, str, str]:
    body = (
        f"Gracias por cargar con Faro Energy. Aquí está tu recibo:<br><br>"
        f"<b>Lugar:</b> {location}<br>"
        f"<b>Energía:</b> {kwh:.2f} kWh<br>"
        f"<b>Total:</b> ${total_cop:,} COP<br>"
    )
    cta_t, cta_u = ("Ver factura", invoice_url) if invoice_url else ("", "")
    html = _layout("Tu recarga terminó", body, cta_t, cta_u)
    text = f"Recibo Faro Energy — {location}: {kwh:.2f} kWh, ${total_cop:,} COP"
    return "Tu recibo de recarga · Faro Energy", html, text


def owner_alert_email(name: str, title: str, message: str) -> tuple[str, str, str]:
    html = _layout(title, message)
    return f"{title} · Faro Energy", html, message
