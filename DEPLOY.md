# Despliegue — producción de prueba en tu servidor Ubuntu

Stack completo en un i7 7ma gen / 16 GB: sobra máquina (el stack usa < 500 MB RAM).

## 1. Levantar el backend en el servidor

```bash
# En el servidor Ubuntu
git clone https://github.com/Pipe1017/faro_Energy.git
cd faro_Energy

# Crear backend/.env con los secretos (NUNCA van al repo):
cat > backend/.env <<'EOF'
SECRET_KEY=<genera uno: openssl rand -hex 32>
WOMPI_PUBLIC_KEY=pub_test_...
WOMPI_PRIVATE_KEY=prv_test_...
WOMPI_EVENTS_SECRET=...
WOMPI_INTEGRITY_SECRET=...
PUBLIC_WS_BASE=wss://TU-DOMINIO/ocpp
SEED_PASSWORD=<clave para los usuarios demo — NO dejar 1234>
EOF

docker compose -f docker-compose.prod.yml up -d --build
curl localhost:8000/status   # → JSON con cargadores
```

Notas:
- **Un solo worker de uvicorn** (ya configurado en el Dockerfile): el estado
  OCPP vive en memoria. No escalar a más workers sin rediseñar eso.
- La DB persiste en el volumen `faro_pgdata`. Backup diario recomendado:
  `docker exec <db> pg_dump -U postgres cpo_db > backup_$(date +%F).sql` (cron).

## 2. Exponerlo a internet (para que otros lo prueben)

Tu servidor casero está detrás del router — dos opciones, de menor a mayor esfuerzo:

**Opción A — ngrok (5 min, ya lo usas):** instala ngrok en el servidor y usa tu
mismo dominio estático. La app móvil ya apunta ahí — cero cambios.
```bash
ngrok http --url=preseason-constable-sappiness.ngrok-free.dev 8000
```
Límite: el plan free tiene tope de tráfico mensual; suficiente para pruebas.

**Opción B — Cloudflare Tunnel (recomendada, gratis y estable):** ya tienes
faroenergy.lat. Pon el DNS en Cloudflare y:
```bash
# en el servidor
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && sudo dpkg -i cf.deb
cloudflared tunnel login
cloudflared tunnel create faro
cloudflared tunnel route dns faro api.faroenergy.lat
cloudflared tunnel run --url http://localhost:8000 faro
```
Resultado: `https://api.faroenergy.lat` con TLS y WebSockets (wss://) incluidos,
sin abrir puertos en el router. Luego:
- Cambiar `API_URL` en `mobile/App.js` a `https://api.faroenergy.lat`
- `PUBLIC_WS_BASE=wss://api.faroenergy.lat/ocpp` en backend/.env
- Actualizar la URL del webhook en el dashboard de Wompi

## 3. Que otras personas prueben la APP

**Hoy (mismo WiFi):** Expo Go + QR — solo funciona en tu red.

**Remoto sin compilar — EAS Update:** publica el JS y cualquiera con Expo Go
lo abre con un link/QR desde cualquier lugar:
```bash
cd mobile
npm i -g eas-cli && eas login        # cuenta gratis en expo.dev
eas update:configure                  # una sola vez
eas update --branch preview --message "beta 1"
```
Compartes el link de expo.dev → el tester instala Expo Go → abre tu app.

**Android serio — APK instalable (EAS Build, gratis con cola):**
```bash
eas build -p android --profile preview
```
Te da un .apk que mandas por WhatsApp — el tester lo instala directo, sin Expo Go.
(iOS requiere cuenta Apple Developer US$99/año + TestFlight — para después.)

## 4. Checklist de seguridad antes de invitar gente

- [ ] `SECRET_KEY` nuevo (no el de desarrollo)
- [ ] `SEED_PASSWORD` fuerte o `SEED_DEMO_USERS=false`
- [ ] Llaves Wompi de **sandbox** (plata de prueba — nadie paga de verdad)
- [ ] Webhook de Wompi apuntando al dominio nuevo
- [ ] Backup de la DB programado (cron + pg_dump)
- [ ] `docker compose logs -f backend` a la mano el primer día
