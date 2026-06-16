"""Seed idempotente para el sandbox: tarjetas de los conductores y cuentas de
dispersión de los dueños. Corre al arrancar (tarea async, no bloquea el inicio)
y no repite nada que ya exista.

Datos de prueba Wompi sandbox:
  - Tarjeta 4242 4242 4242 4242 → APPROVED
  - Nequi 3991111111 → APPROVED (dispersión)
"""
import logging
from sqlalchemy import select

from database import AsyncSessionLocal
from models import User, PaymentMethod, DisbursementAccount
import wompi as wompi_svc

logger = logging.getLogger(__name__)

# Cuentas donde los dueños reciben sus ganancias (datos puros, sin llamar Wompi)
SEED_DISBURSEMENTS = [
    {"email": "carlos@cpo.com", "type": "BANK", "bank_code": "1007",
     "account_number": "12345678901", "account_type": "SAVINGS",
     "holder_name": "Carlos Operador", "holder_id": "1017123456"},
    {"email": "juanes@cpo.com", "type": "NEQUI", "phone": "3991111111",
     "holder_name": "Juanes Operador", "holder_id": "1017654321"},
]

# Tarjetas de prueba para conductores (se tokenizan contra Wompi)
SEED_CARDS = [
    {"email": "conductor1@cpo.com", "number": "4242424242424242", "cvc": "123",
     "exp_month": "12", "exp_year": "29", "holder": "CONDUCTOR UNO", "nickname": "Visa de prueba"},
    {"email": "conductor2@cpo.com", "number": "4242424242424242", "cvc": "123",
     "exp_month": "12", "exp_year": "29", "holder": "CONDUCTOR DOS", "nickname": "Visa de prueba"},
]


async def seed_payments():
    # 1) Cuentas de dispersión de dueños (rápido, sin red)
    async with AsyncSessionLocal() as db:
        for d in SEED_DISBURSEMENTS:
            u = (await db.execute(select(User).where(User.email == d["email"]))).scalar_one_or_none()
            if not u:
                continue
            exists = (await db.execute(
                select(DisbursementAccount).where(DisbursementAccount.user_id == u.id)
            )).scalar_one_or_none()
            if exists:
                continue
            db.add(DisbursementAccount(
                user_id=u.id, type=d["type"], phone=d.get("phone"),
                account_number=d.get("account_number"), bank_code=d.get("bank_code"),
                account_type=d.get("account_type"), holder_name=d["holder_name"],
                holder_id=d["holder_id"], verified=False,
            ))
            logger.info(f"Seed pago: cuenta de dispersión {d['type']} para {d['email']}")
        await db.commit()

    # 2) Tarjetas de conductores (tokeniza contra Wompi; si falla, no rompe)
    for c in SEED_CARDS:
        async with AsyncSessionLocal() as db:
            u = (await db.execute(select(User).where(User.email == c["email"]))).scalar_one_or_none()
            if not u:
                continue
            has_card = (await db.execute(
                select(PaymentMethod).where(PaymentMethod.user_id == u.id).limit(1)
            )).scalars().first()
            if has_card:
                continue
        try:
            tok = await wompi_svc.tokenize_card(c["number"], c["cvc"], c["exp_month"], c["exp_year"], c["holder"])
            if tok.get("status") != "CREATED":
                logger.warning(f"Seed tarjeta {c['email']}: token no creado")
                continue
            ps = await wompi_svc.save_card_as_payment_source(tok["data"]["id"], c["email"])
            ps_id = ps.get("data", {}).get("id")
            if not ps_id:
                logger.warning(f"Seed tarjeta {c['email']}: payment_source no creado")
                continue
            async with AsyncSessionLocal() as db:
                u = (await db.execute(select(User).where(User.email == c["email"]))).scalar_one_or_none()
                db.add(PaymentMethod(
                    user_id=u.id, type="CARD", wompi_payment_source_id=ps_id,
                    display=f"VISA •••• {c['number'][-4:]}", brand="VISA",
                    nickname=c["nickname"], is_default=True,
                ))
                await db.commit()
            logger.info(f"Seed pago: tarjeta VISA ••{c['number'][-4:]} para {c['email']}")
        except Exception as e:
            logger.warning(f"Seed tarjeta {c['email']} falló (se puede agregar desde la app): {e}")
