#!/bin/bash
# Arranca todo el entorno de desarrollo CPO Colombia

ROOT="$(cd "$(dirname "$0")" && pwd)"
SIM="$ROOT/simulator"

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
echo "▶ Iniciando backend FastAPI..."
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT/backend' && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000\""

sleep 3

# 3. Cargadores — uno por terminal
# Los simuladores ahora se gestionan internamente desde el backend.
# Cada cargador que se agrega en la app auto-arranca su simulador.
# No se necesitan terminales externas.

sleep 2

# 4. ngrok con dominio fijo
echo "▶ Iniciando túnel ngrok..."
osascript -e "tell application \"Terminal\" to do script \"ngrok http --url=preseason-constable-sappiness.ngrok-free.dev 8000\""

sleep 2

# 5. Expo — sin flags, funciona con WiFi y escaneo de QR
echo "▶ Iniciando app móvil con Expo..."
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT/mobile' && npx expo start\""

echo ""
echo "✅ Todo listo — 8 terminales abiertas en Terminal.app"
echo ""
echo "   Backend:  https://preseason-constable-sappiness.ngrok-free.dev"
echo "   API Docs: https://preseason-constable-sappiness.ngrok-free.dev/docs"
echo ""
echo "   Escanea el QR de Expo con la cámara del iPhone"
echo "   (el iPhone y el Mac deben estar en la misma WiFi)"
echo ""
