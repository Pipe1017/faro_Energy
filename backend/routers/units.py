"""Unidades residenciales: cargadores privados + lista de miembros autorizados.

El dueño crea una Unidad (conjunto/edificio), comparte su código de invitación y/o
agrega miembros por correo. Sus cargadores asignados a la unidad son PRIVADOS: solo
los miembros (y el dueño) pueden cargar. El bloqueo se aplica en /payments/initiate.
"""
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models import User, Unit, UnitMember, Charger
from core.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()

_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sin confusables


async def _gen_code(db: AsyncSession) -> str:
    for _ in range(20):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if not (await db.execute(select(Unit.id).where(Unit.join_code == code))).scalar():
            return code
    raise HTTPException(500, "No se pudo generar el código")


async def _owner_unit(db: AsyncSession, unit_id: str, user: User) -> Unit:
    unit = await db.get(Unit, unit_id)
    if not unit:
        raise HTTPException(404, "Unidad no encontrada")
    if unit.owner_id != user.id:
        raise HTTPException(403, "No es tu unidad")
    return unit


class UnitBody(BaseModel):
    name: str


@router.post("/units")
async def create_unit(body: UnitBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo dueños de cargadores")
    code = await _gen_code(db)
    unit = Unit(owner_id=current_user.id, name=(body.name.strip() or "Mi unidad"), join_code=code)
    db.add(unit)
    await db.flush()
    db.add(UnitMember(unit_id=unit.id, user_id=current_user.id))  # el dueño es miembro
    await db.commit()
    # Re-consultar para que la relación 'members' (lazy=selectin) quede cargada y
    # to_dict no dispare un lazy-load en async (que falla / da 500).
    unit = (await db.execute(select(Unit).where(Unit.id == unit.id))).scalar_one()
    return unit.to_dict(chargers_count=0)


@router.get("/my-units")
async def my_units(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role != "owner":
        raise HTTPException(403, "Solo dueños de cargadores")
    rows = (await db.execute(
        select(Unit).where(Unit.owner_id == current_user.id).order_by(Unit.created_at)
    )).scalars().all()
    out = []
    for u in rows:
        cnt = (await db.execute(
            select(func.count(Charger.id)).where(Charger.unit_id == u.id, Charger.archived.isnot(True))
        )).scalar()
        out.append(u.to_dict(chargers_count=cnt or 0))
    return {"units": out}


@router.delete("/units/{unit_id}")
async def delete_unit(unit_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    unit = await _owner_unit(db, unit_id, current_user)
    chs = (await db.execute(select(Charger).where(Charger.unit_id == unit_id))).scalars().all()
    for c in chs:
        c.unit_id = None  # los cargadores vuelven a públicos
    await db.delete(unit)  # members caen por cascade
    await db.commit()
    return {"ok": True}


class MemberBody(BaseModel):
    email: str


@router.post("/units/{unit_id}/members")
async def add_member(unit_id: str, body: MemberBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _owner_unit(db, unit_id, current_user)
    email = body.email.strip().lower()
    u = (await db.execute(
        select(User).where(func.lower(User.email) == email, User.role == "conductor")
    )).scalars().first()
    if not u:
        raise HTTPException(404, "No hay un conductor con ese correo en Faro")
    exists = (await db.execute(
        select(UnitMember.id).where(UnitMember.unit_id == unit_id, UnitMember.user_id == u.id)
    )).scalar()
    if exists:
        raise HTTPException(409, "Esa persona ya es miembro de la unidad")
    db.add(UnitMember(unit_id=unit_id, user_id=u.id))
    await db.commit()
    return {"ok": True, "name": u.name, "email": u.email}


@router.delete("/units/{unit_id}/members/{user_id}")
async def remove_member(unit_id: str, user_id: str, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _owner_unit(db, unit_id, current_user)
    m = (await db.execute(
        select(UnitMember).where(UnitMember.unit_id == unit_id, UnitMember.user_id == user_id)
    )).scalars().first()
    if m:
        await db.delete(m)
        await db.commit()
    return {"ok": True}


class JoinBody(BaseModel):
    code: str


@router.post("/units/join")
async def join_unit(body: JoinBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """El conductor se une a una unidad con el código que le compartió el dueño."""
    code = body.code.strip().upper()
    unit = (await db.execute(select(Unit).where(Unit.join_code == code))).scalars().first()
    if not unit:
        raise HTTPException(404, "Código inválido")
    exists = (await db.execute(
        select(UnitMember.id).where(UnitMember.unit_id == unit.id, UnitMember.user_id == current_user.id)
    )).scalar()
    if not exists:
        db.add(UnitMember(unit_id=unit.id, user_id=current_user.id))
        await db.commit()
    return {"ok": True, "unit": unit.name}


@router.get("/my-memberships")
async def my_memberships(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """unit_ids a los que pertenece el usuario — la app marca qué privados puede usar."""
    rows = (await db.execute(
        select(UnitMember.unit_id).where(UnitMember.user_id == current_user.id)
    )).scalars().all()
    return {"unit_ids": list(rows)}
