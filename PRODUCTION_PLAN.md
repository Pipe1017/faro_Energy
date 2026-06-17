# Plan de Producción — Faro Energy

> Objetivo: pasar del MVP actual (sandbox, testers por Expo Go) a una operación
> real que cobra dinero a desconocidos en Colombia, de forma legal y confiable.
>
> Estado de partida: backend FastAPI modular + OCPP 1.6 + Wompi **sandbox** +
> ledger/liquidaciones funcionando E2E. App en Expo Go vía EAS Update. Landing en
> Netlify. **Sin** facturación, **sin** OAuth, **sin** reviews, **sin** backups
> automáticos, **sin** tests, **sin** monitoreo. Un solo worker uvicorn.

Leyenda de prioridad: 🔴 bloqueante real · 🟡 necesario pronto · 🟢 mejora.
Cada item tiene **Hecho cuando** (criterio de aceptación verificable).

---

## 📊 Estado al 2026-06-15

Avanzamos en **infraestructura y operación**, pero **los portones que habilitan cobrar
plata real al público siguen cerrados**.

| Fase / item | Estado | Nota |
|---|---|---|
| 0.1 Estructura tributaria | 🟡 parcial | Modelo A decidido e implementado en código; **falta validación de contador** + `docs/facturacion.md` |
| 0.2 T&C + Habeas Data | 🔴 sin hacer | No hay textos ni aceptación en el registro |
| 0.3 Contrato dueño↔Faro | 🔴 sin hacer | |
| 1.1 Backups Postgres | 🔴 sin hacer | Riesgo: perder el ledger |
| 1.2 Monitoreo (Sentry) | 🔴 sin hacer | |
| 1.3 Tests del motor de plata | 🔴 sin hacer | **Siguen en cero** |
| 1.4 CI | 🔴 sin hacer | |
| 1.5 **Wompi producción** | 🔴 sin hacer | **Sigue en SANDBOX → nadie paga de verdad** |
| 2.1 MinIO | ✅ hecho | |
| 2.2 Facturación DIAN | 🟡 parcial | Pipeline + outbox listos, pero **stub** (no factura DIAN real) |
| 2.3 Email transaccional | ✅ hecho | Gmail SMTP + plantillas |
| 3.1 Estado de cargadores | 🟡 parcial | Mapa en el **admin** (para ti); falta en la app del **conductor** |
| 3.2 Reviews | 🔴 sin hacer | |
| 4.2 Verificación de correo | ✅ hecho | (falta "recuperar contraseña") |
| 4.3 KYC del dueño | 🔴 sin hacer | RUT = "Falta" en el admin |
| 4.1 OAuth Google · 4.4 Push | 🔴 sin hacer | |
| **Extra (no estaba en el plan)** | ✅ hecho | **Back-office web admin** (dashboard, mapa, usuarios, facturas) |

**Lectura honesta:** para un **beta gratis** (testers, plata de mentira) ya estás listo.
Para **operación comercial real** faltan los bloqueantes 🔴: Wompi producción, factura DIAN
real, legal/contable (T&C, Habeas Data, KYC) y confiabilidad (backups, tests).

---

## Decisiones que TÚ debes tomar antes (no son código)

Estas definen el diseño del resto. Conviene resolverlas con un contador/abogado:

- [ ] **D1 — Estructura de facturación.** ¿Quién factura a quién?
  - Opción A: Faro factura al conductor el total; el dueño le factura a Faro su parte.
  - Opción B: el dueño factura al conductor; Faro solo factura su comisión al dueño.
  - Impacto: define IVA, retenciones (ReteFuente/ReteIVA/ReteICA) y qué endpoints/modelos se construyen. **Bloquea la Fase 2.**
- [ ] **D2 — Proveedor de facturación electrónica DIAN.** Alegra / Factus / Siigo / FacturaTech, o habilitación directa. (Recomendado empezar con un proveedor tecnológico con API: mucho menos esfuerzo que habilitarte directo).
- [ ] **D3 — Cuenta Wompi de producción** y activación de pre-autorizaciones + dispersiones (hoy degradan: 500/404 en sandbox).
- [ ] **D4 — Rol en signup social.** ¿Cómo elige conductor vs. owner quien entra con Google/Outlook? (pantalla post-login que fija el rol una sola vez).
- [ ] **D5 — Tolerancia al reinicio.** ¿Aceptamos que un reinicio del backend tumba sesiones OCPP activas (1 worker, estado en memoria) con monitoreo, o lo rediseñamos ya? Recomendación: aceptar con monitoreo en v1, rediseñar en Fase 5.

---

## Fase 0 — Legal y contable (paralelo, no bloquea código no-financiero)

🔴 **0.1 — Estructura tributaria definida** (D1). Documento de una página con el flujo de dinero y quién emite cada factura.
  - Hecho cuando: existe `docs/facturacion.md` con el modelo aprobado por contador.

🔴 **0.2 — Términos y Condiciones + Política de Tratamiento de Datos (Ley 1581 / Habeas Data).**
  - Aceptación obligatoria en el registro (checkbox + timestamp guardado en `User`).
  - Registro en RNBD de la SIC si aplica por umbral.
  - Hecho cuando: textos publicados en la landing y `User` guarda `accepted_terms_at`.

🟡 **0.3 — Marco contractual dueño↔Faro** (responsabilidad civil, SLA del cargador).
  - Hecho cuando: contrato de vinculación disponible en el onboarding del dueño.

🟢 **0.4 — Leer y commitear** `REFERENCIAS ESTATALES/Cartilla Electromovilidad MinMinas` y extraer requisitos operativos a `docs/regulatorio.md`.

---

## Fase 1 — Confiabilidad (porque ya mueves dinero) 🔴

**1.1 — Backups automáticos de Postgres.**
  - `pg_dump` diario por cron en el servidor → retención 7/30 días → copia off-site (otro disco o bucket).
  - Probar **una restauración real** en limpio.
  - Hecho cuando: existe `scripts/backup_db.sh`, está en crontab, y se restauró con éxito un dump en un Postgres vacío.

**1.2 — Monitoreo y alertas.**
  - Sentry (o equivalente) en backend FastAPI para excepciones.
  - Healthcheck externo (UptimeRobot/Healthchecks.io) golpeando `/status` → alerta a tu celular/email si cae.
  - Hecho cuando: un error forzado aparece en Sentry y una caída simulada dispara alerta.

**1.3 — Tests del núcleo financiero.**
  - `pytest` sobre: `config.price_to_conductor`, `engine` (cálculo de cobro, captura, liquidación, ledger con montos firmados), idempotencia de cobros, no-show de reservas.
  - Hecho cuando: `pytest` corre verde con cobertura del flujo de dinero (cobro→captura→ledger→giro).

**1.4 — CI en GitHub Actions.**
  - Workflow que corre `pytest` (backend) y `expo export` (mobile build check) en cada push/PR.
  - Hecho cuando: el badge de CI está verde y un PR con test roto se bloquea.

**1.5 — Wompi a producción** (D3).
  - Llaves de producción en `backend/.env`, pre-auth y dispersiones activadas, webhook de prod registrado, probado E2E con un cobro real pequeño.
  - Hecho cuando: una sesión real cobra, captura, dispersa al dueño y concilia en el dashboard de Wompi producción.

---

## Fase 2 — Facturación electrónica + almacenamiento 🔴

> Depende de D1 y D2. MinIO es solo el **almacén**; la factura la emite el proveedor DIAN.

**2.1 — Montar MinIO** en el `docker-compose.prod.yml` (servicio + volumen + credenciales en `.env`).
  - Buckets: `invoices/`, `onboarding/` (RUT/cédula del dueño), `chargers/` (fotos).
  - Helper `backend/storage.py` (cliente S3-compatible, p. ej. `boto3` o `minio`).
  - Hecho cuando: el backend sube y recupera un archivo de MinIO vía URL firmada.

**2.2 — Integración con proveedor DIAN** (D2).
  - `backend/invoicing.py`: al confirmar pago (estado CAPTURED en `engine`), llamar al proveedor → recibir XML+PDF+CUFE.
  - Nuevo modelo `Invoice` (ligado a `Session`/`PaymentTransaction`): número, CUFE, estado DIAN, URLs en MinIO.
  - Reintentos/outbox como ya haces con `pending_charges` (no bloquear el cobro si la factura falla).
  - Hecho cuando: una sesión pagada genera factura validada por DIAN, guardada en MinIO y consultable por el conductor.

**2.3 — Envío de correo** (necesario para mandar facturas y para la Fase 4).
  - `backend/email.py` con SMTP o un proveedor transaccional (Resend/SendGrid/SES).
  - Plantillas: factura, recibo, verificación de email, recuperación de contraseña.
  - Hecho cuando: el conductor recibe su factura por email al terminar de cargar.

---

## Fase 3 — Confianza del usuario (alto impacto, bajo costo) 🟡

**3.1 — Estado operativo del cargador en el mapa/lista.**
  - Exponer claramente al conductor **antes** de reservar/cargar: `EN_LINEA` / `FUERA_DE_LINEA` / `CON_FALLAS_REPORTADAS`. Ya tienes la señal OCPP (`connected_chargers`) y el evento `CHARGER_OFFLINE`.
  - Hecho cuando: el mapa muestra el estado en tiempo real y se bloquea/advierte reservar uno fuera de línea.

**3.2 — Reviews y reportes.**
  - Modelo `ChargerReview` (rating 1–5, comentario, `cargo_bien` bool) ligado a una `Session` cerrada — solo quien cargó puede reseñar (anti-spam).
  - Botón "Reportar problema" → crea `OwnerEvent` para el dueño + marca el cargador como `CON_FALLAS_REPORTADAS` si varios reportes coinciden.
  - Mostrar rating promedio en la ficha del cargador.
  - Hecho cuando: un conductor que cargó puede calificar/reportar y el promedio aparece en la ficha.

---

## Fase 4 — Adopción / crecimiento 🟡

**4.1 — OAuth Google y Microsoft (Outlook).**
  - Backend: `password_hash` nullable; endpoints `/auth/google` y `/auth/microsoft` que validan `id_token`, hacen upsert de `User` y emiten tu JWT. Pantalla post-signup para fijar rol (D4).
  - Mobile: `expo-auth-session`.
  - Apps registradas en Google Cloud Console y Azure AD.
  - Hecho cuando: un usuario entra con Google y con Microsoft y queda con rol asignado.

**4.2 — Verificación de email + recuperación de contraseña** (usa Fase 2.3).
  - Hecho cuando: registro email/clave exige verificar correo y existe flujo de reset.

**4.3 — Onboarding/KYC del dueño** (para dispersar plata real).
  - Subir RUT/cédula (a MinIO), validar cuenta bancaria antes de habilitar dispersiones.
  - Hecho cuando: un dueño no puede recibir giros hasta completar KYC.

**4.4 — Push notifications reales.**
  - Requiere dev build / EAS Build con `expo-notifications` (no funciona en Expo Go). `owner_events` ya alimenta.
  - Hecho cuando: el dueño recibe push de sesión iniciada / cargador caído.

---

## Fase 5 — Escala y robustez 🟢

**5.1 — Sacar el estado OCPP de la memoria del proceso** (D5) → Redis/DB, para permitir reinicios sin tumbar sesiones y >1 worker.

**5.2 — Alembic** para migraciones versionadas (hoy son best-effort al arranque).

**5.3 — Publicación en stores:** Google Play (Android) y, si aplica, Apple Developer + TestFlight/App Store (iOS, US$99/año).

**5.4 — Flujo de disputas/reembolsos** para "pagué y el cargador no entregó energía" (más allá del estado `REVIEW` de `PendingCharge`).

---

## Orden recomendado de ejecución

1. **Arrancar Fase 0 (legal) en paralelo desde hoy** — es lo que más tarda y bloquea la facturación.
2. **Fase 1 completa** — antes de invitar a un solo usuario que pague de verdad.
3. **Fase 3** (estado + reviews) — rápida, visible, genera confianza mientras avanza lo legal.
4. **Fase 2** (facturación) — apenas estén D1/D2 resueltas.
5. **Fase 4** y **Fase 5** — crecimiento y robustez.

---

## Quick wins (se pueden hacer ya, sin depender de decisiones)

- [ ] 1.1 Backups automáticos (1 tarde).
- [ ] 1.2 Sentry + healthcheck externo (1 tarde).
- [ ] 3.1 Estado del cargador en el mapa (la señal ya existe).
- [ ] 2.1 Montar MinIO (sirve para todo lo demás).
- [ ] 1.3 Primeros tests del cálculo financiero.
