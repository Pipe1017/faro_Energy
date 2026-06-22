"""Almacenamiento de objetos (MinIO / S3-compatible) para facturas y documentos.

Guarda PDF/XML de facturas, documentos de onboarding del dueño, etc. Si MinIO no
está configurado (sin MINIO_ENDPOINT), cae a un fallback local en /tmp para que el
desarrollo no se bloquee. La factura nunca depende de que el almacén exista.

Config por env:
  MINIO_ENDPOINT     ej. "minio:9000" (sin esquema). Vacío = fallback local.
  MINIO_ACCESS_KEY / MINIO_SECRET_KEY
  MINIO_BUCKET       default "faro"
  MINIO_SECURE       "true"/"false" (TLS)
  MINIO_PUBLIC_BASE  base para URLs públicas (ej. https://files.faroenergy.lat)
"""
import os
import logging
from io import BytesIO
from pathlib import Path

logger = logging.getLogger(__name__)

MINIO_ENDPOINT    = os.getenv("MINIO_ENDPOINT", "").strip()
MINIO_ACCESS_KEY  = os.getenv("MINIO_ACCESS_KEY", "")
MINIO_SECRET_KEY  = os.getenv("MINIO_SECRET_KEY", "")
MINIO_BUCKET      = os.getenv("MINIO_BUCKET", "faro")
MINIO_SECURE      = os.getenv("MINIO_SECURE", "false").lower() == "true"
MINIO_PUBLIC_BASE = os.getenv("MINIO_PUBLIC_BASE", "").rstrip("/")

_LOCAL_DIR = Path("/tmp/faro_storage")
_client = None


def _get_client():
    """Cliente MinIO perezoso. None si no está configurado → fallback local."""
    global _client
    if not MINIO_ENDPOINT:
        return None
    if _client is None:
        from minio import Minio
        _client = Minio(MINIO_ENDPOINT, access_key=MINIO_ACCESS_KEY,
                        secret_key=MINIO_SECRET_KEY, secure=MINIO_SECURE)
        if not _client.bucket_exists(MINIO_BUCKET):
            _client.make_bucket(MINIO_BUCKET)
            logger.info(f"MinIO: bucket '{MINIO_BUCKET}' creado")
    return _client


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    """Sube bytes y devuelve una URL/locator. Usa MinIO si está configurado;
    si no, guarda en /tmp/faro_storage y devuelve un file://."""
    client = _get_client()
    if client is None:
        path = _LOCAL_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        logger.warning(f"MinIO no configurado — '{key}' guardado en {path}")
        return f"file://{path}"
    client.put_object(MINIO_BUCKET, key, BytesIO(data), length=len(data), content_type=content_type)
    if MINIO_PUBLIC_BASE:
        return f"{MINIO_PUBLIC_BASE}/{MINIO_BUCKET}/{key}"
    scheme = "https" if MINIO_SECURE else "http"
    return f"{scheme}://{MINIO_ENDPOINT}/{MINIO_BUCKET}/{key}"


def get_bytes(key: str) -> bytes | None:
    """Lee un objeto de MinIO (o del fallback local). None si no existe."""
    client = _get_client()
    if client is None:
        path = _LOCAL_DIR / key
        return path.read_bytes() if path.exists() else None
    try:
        resp = client.get_object(MINIO_BUCKET, key)
        data = resp.read()
        resp.close(); resp.release_conn()
        return data
    except Exception as e:
        logger.warning(f"get_bytes {key}: {e}")
        return None


def is_configured() -> bool:
    return bool(MINIO_ENDPOINT)
