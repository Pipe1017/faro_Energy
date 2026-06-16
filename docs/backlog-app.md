# Backlog Faro — épicas derivadas del modelo nuevo

Estado: ✅ hecho · 🟡 parcial (hay que cambiar) · 🔴 nuevo
Prioridad: **P0** crítico para cobrar/operar · **P1** alto · **P2** después

---

## E1 · Wallet prepago 🔴 **P0** (la decisión #1 del modelo)
*Neutraliza el $700 fijo de Wompi: una transacción por recarga, no por sesión.*
- [ ] Modelo `Wallet`/saldo por conductor (saldo en centavos, movimientos).
- [ ] Recargar saldo vía Wompi (1 transacción; montos: default $50.000, configurables).
- [ ] Débito del saldo al terminar cada carga (no tocar tarjeta por sesión).
- [ ] Preautorización **contra saldo** (no tarjeta) antes de iniciar.
- [ ] Manejo de saldo insuficiente (avisar + ofrecer recarga en el momento).
- [ ] Bono de bienvenida en saldo (onboarding desde concesionarios).
- [ ] App: ver saldo, historial de movimientos, recarga rápida.
> Cambia el flujo actual de `/payments/initiate` (hoy pre-auth por tarjeta por sesión).

## E2 · Precios y comisión por segmento 🟡 **P1**
- [x] IVA condicional al estatus del dueño ✅
- [ ] Campo `segment` del cargador (casa / hotel-gym / mall / operador).
- [ ] **Comisión parametrizable por segmento (10–15%)** — hoy es 10% global fijo.
- [ ] Rangos de PVP por segmento (validar al fijar precio).
- [ ] **Tarifa por tiempo** (cargo/min tras X horas) para malls/parqueaderos.
- [ ] Tarifa SaaS mensual por cargador (mecanismo existe en $0) para operador grande.

## E3 · Reparto: Faro absorbe Wompi de su comisión 🟡 **P1** (cambio)
- [ ] Hoy `GATEWAY_BORNE_BY=owner` → cambiar a que **Faro absorba el costo Wompi de su
      comisión** y el neto del dueño quede limpio.
- [x] Bolsas (wallet dueño / revenue:faro / tax:iva) ✅

## E4 · Dispersión automática al dueño 🔴 **P1**
- [x] Pago manual desde el back-office ✅ (hoy)
- [ ] **Automatizar** la dispersión (Wompi prod) con **umbral mínimo + frecuencia**.
- [ ] Reactivar el job de liquidación cuando Wompi producción esté activo.

## E5 · Uptime como producto 🟡 **P1**
- [x] Detección de cargador offline (OCPP) + alerta ✅
- [ ] **Ocultar del mapa** los cargadores que no responden (no quemar la experiencia).
- [ ] Tablero de **disponibilidad + SLA por sitio**.
- [ ] **Tasa de éxito de carga** por punto (meta >95%).

## E6 · Onboarding del dueño "vista de amenidad" 🔴 **P2**
- [ ] Simulador de **payback** en el registro (igual al modelo financiero).
- [ ] Argumento de tráfico/retención de clientes (no solo "$/kWh").
- [ ] KYC ligero (cédula + cuenta + términos; RUT condicional).

## E7 · Panel del operador con métricas 🔴 **P2**
- [x] Conciliación / bolsas / facturas / mapa ✅
- [ ] **Utilización por cargador (kWh/día)**, recompra de conductores, uptime.
- [ ] **Avance a break-even** (cargadores activos vs. ~85–150 necesarios).

## E8 · Facturación electrónica DIAN real 🟡 **P1** (antes de cobrar real)
- [x] Pipeline + stub (PDF/MinIO) ✅
- [ ] Integrar **Factus** (CUFE real); estructura legal (mandato).

## E9 · Salir del sandbox 🔴 **P0** (para ingresos reales)
- [ ] **Wompi producción** (pre-auth/wallet + dispersiones activas).
- [ ] Mostrar precio/instrucciones/forma de pago (Res. 40123/2024).

---

## Orden sugerido
1. **E1 Wallet** (P0) — sin esto la economía de Faro no cierra.
2. **E2/E3** (precio por segmento + Faro absorbe Wompi) — margen correcto.
3. **E9 Wompi prod + E8 Factus** — habilitar plata real + legal.
4. **E4 dispersión automática** + **E5 uptime producto**.
5. **E6 onboarding amenidad** + **E7 métricas operador**.
