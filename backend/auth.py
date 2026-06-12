import os
from datetime import datetime, timedelta, timezone
import bcrypt
from dotenv import load_dotenv
from jose import jwt, JWTError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db
import models

# load_dotenv aquí porque este módulo se importa antes del load_dotenv() de main.py
load_dotenv()
SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY no configurada. Agrégala a backend/.env")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_token(user_id: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "role": role, "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> models.User:
    if not creds:
        raise HTTPException(status_code=401, detail="No autenticado")
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload["sub"]
    except (JWTError, KeyError):
        raise HTTPException(status_code=401, detail="Token inválido")
    user = await db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Usuario no encontrado")
    return user
