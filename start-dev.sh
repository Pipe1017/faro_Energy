#!/bin/bash
# Arranca todo el entorno de desarrollo CPO Colombia

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "========================================"
echo "  CPO Colombia — Entorno de desarrollo"
echo "========================================"
echo ""

# 1. Docker (DB + Redis)
echo "▶ Levantando base de datos y Redis..."
docker compose -f "$ROOT/docker-compose.yml" up -d
echo ""

# 2. Backend FastAPI
echo "▶ Iniciando backend FastAPI en puerto 8000..."
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT/backend' && source venv/bin/activate && uvicorn main:app --reload --host 0.0.0.0 --port 8000\""

sleep 2

# 3. Simulador OCPP
echo "▶ Iniciando simulador de cargadores..."
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT/simulator' && source venv/bin/activate && python3 simulate.py\""

sleep 2

# 4. ngrok con dominio fijo
echo "▶ Iniciando túnel ngrok..."
osascript -e "tell application \"Terminal\" to do script \"ngrok http --url=preseason-constable-sappiness.ngrok-free.dev 8000\""

sleep 2

# 5. Expo
echo "▶ Iniciando app móvil con Expo..."
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT/mobile' && npx expo start\""

echo ""
echo "✅ Todo listo:"
echo "   Backend:   https://preseason-constable-sappiness.ngrok-free.dev"
echo "   API Docs:  https://preseason-constable-sappiness.ngrok-free.dev/docs"
echo "   Estado:    https://preseason-constable-sappiness.ngrok-free.dev/status"
echo ""
echo "   Escanea el QR de Expo con la cámara del iPhone"
echo ""
