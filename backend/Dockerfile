FROM python:3.12-slim

WORKDIR /app

# Dependencias primero — se cachean entre builds
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# IMPORTANTE: un solo worker — el estado OCPP (cargadores conectados,
# simuladores) vive en memoria del proceso
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
