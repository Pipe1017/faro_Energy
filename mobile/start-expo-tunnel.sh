#!/bin/bash
# Inicia Expo con Cloudflare Tunnel (gratuito, sin límite de conexiones)

MOBILE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ Iniciando Cloudflare Tunnel para Expo..."

# Arranca cloudflared en background y captura la URL pública
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url http://localhost:8081 --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
CF_PID=$!

# Espera hasta que aparezca la URL (máximo 15 segundos)
for i in $(seq 1 30); do
    CF_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    [ -n "$CF_URL" ] && break
    sleep 0.5
done

if [ -z "$CF_URL" ]; then
    echo "❌ No se pudo obtener la URL de Cloudflare. Revisa tu conexión."
    kill $CF_PID 2>/dev/null
    exit 1
fi

echo ""
echo "✅ Tunnel activo: $CF_URL"
echo ""
echo "   Escanea el QR con Expo Go desde cualquier red"
echo ""

# Inicia Expo con el hostname de Cloudflare
cd "$MOBILE_DIR"
REACT_NATIVE_PACKAGER_HOSTNAME="${CF_URL#https://}" npx expo start

# Al salir, mata el tunnel
kill $CF_PID 2>/dev/null
rm -f "$TUNNEL_LOG"
