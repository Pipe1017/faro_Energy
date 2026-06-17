# Faro Energy — Modelo de negocio y decisiones de producto

> Documento de contexto oficial. Reemplaza el modelo anterior (comisión 10% genérica).
> Fecha: 2026-06.

## 1. Qué es (en una línea)
Plataforma de recarga de VE para **Medellín**, **marketplace de dos lados** (dueño de
cargador ↔ conductor), con foco en **carga de destino AC** (hoteles, malls, gimnasios,
edificios), cobro por app y **reparto automático** al dueño.

## 2. Realidad financiera (Medellín 2026)
**Inputs verificados:** energía comercial EPM ≈ $800/kWh · Wompi 2,65% + $700 fijo + IVA
por transacción · cargador AC instalado ≈ $6.000.000 · PVP sugerido $1.400/kWh · comisión
Faro 15%.

**Payback del dueño** (margen neto dueño = $390/kWh; depende 100% de la utilización):
- Pesimista (15 kWh/día): $135.500/mes → payback 44 meses, ROI año 1 −73%.
- Base (30 kWh/día): $311.000/mes → payback 19 meses, ROI año 1 −38%.
- Optimista (60 kWh/día): $662.000/mes → payback 9 meses, ROI año 1 +32%.

> **La utilización lo es todo.** Faro no le vende un cargador al dueño: le vende
> **densidad de conductores + uptime**.

**Economía de Faro** (gana ~$210/kWh de comisión, menos pasarela):
- Pago sesión por sesión: en carga de 5 kWh Faro queda en **−$3,7** (pierde) por el $700 fijo de Wompi.
- Con **saldo prepago (wallet)**: el fijo se amortiza → margen de contribución **~$142/kWh**.

**Break-even de Faro** (burn $25M/mes): Pesimista ~240 cargadores · Base ~149 · Optimista ~84.
> Es **negocio de escala**: no hay equilibrio con 20 cargadores. Concentrar para subir
> utilización baja el break-even casi a la mitad.

## 3. Decisiones estratégicas (las 5 que cambian el modelo)
1. **Saldo prepago (wallet)** en vez de pago por sesión → neutraliza el $700 fijo de Wompi.
2. **Comisión fija 15% para todos** + **mensualidad de plataforma** ($50.000/cargador, o $30.000/cargador si tiene **más de 5**). Faro asume la pasarela en la recarga (no el conductor ni el dueño).
3. **Reposicionar al dueño:** de "ingreso pasivo" a **"amenidad que atrae clientes premium"**.
4. **Foco en destino AC + densidad geográfica** (una zona: El Poblado/Laureles) → más kWh por transacción.
5. **Uptime como producto** (monitoreo + SLA) — la restricción real no es el hardware, es la operación (lección de Monta, Europa).

## 4. Precios por segmento
| Segmento | Potencia | PVP $/kWh | Comisión | Pago | Foco |
|---|---|---|---|---|---|
| Casa/edificio (vecinos) | AC 7 kW | 900–1.100 | 10–12% | wallet | bajo, no inicial |
| Hotel/restaurante/gimnasio | AC 7–22 kW | 1.300–1.600 | 15% | wallet | **principal** |
| Centro comercial/parqueadero | AC 22 kW | 1.400–1.800 | 15% + tarifa/tiempo tras X h | wallet | sí |
| Operador grande (cadena/flota) | — | — | SaaS + 5–8%, white-label | — | sí |
| Carga rápida DC en corredor | DC | — | — | — | **NO foco** (CapEx alto, dominado por Terpel/Enel) |

## 5. Qué debe hacer la app (requisitos de producto)
**A. Wallet prepago (prioridad #1):** el conductor recarga saldo (default $50.000,
configurable) y se descuenta por carga. Una sola transacción Wompi por recarga, no por
sesión. Mostrar saldo, historial, recarga rápida, bono de bienvenida, manejo de saldo insuficiente.

**B. Motor de precios y comisiones configurable:** PVP por dueño dentro de rangos por
segmento; comisión parametrizable por segmento (10–15%); tarifa por tiempo (cargo/min tras
X h) en malls; tarifa mensual SaaS por cargador (hoy $0) para grandes; IVA según responsable o no.

**C. Reparto automático (bolsas + dispersión):** por sesión bruto → comisión → costo Wompi
→ neto al dueño. **Faro absorbe el Wompi de su comisión** (deja el neto del dueño limpio).
**Automatizar la dispersión** a Nequi/banco (hoy manual: no escala, riesgo de error/fraude);
definir umbral mínimo y frecuencia.

**D. Mapa con densidad y disponibilidad en vivo:** precio, potencia (kW), tipo (AC/DC),
estado en vivo (libre/ocupado/fuera de servicio); filtros por zona; priorizar cercanos y disponibles.

**E. Monitoreo de uptime (es producto, no soporte):** vía OCPP detectar caídos en tiempo
real, alertar a dueño y a Faro, **ocultar del mapa** los que no responden; tablero de
disponibilidad + SLA por sitio; "tasa de éxito de carga" por punto (meta >95%).

**F. Flujo de carga robusto:** preautorización **contra saldo** (no tarjeta directa),
medición kWh en vivo (OCPP), cobro exacto al terminar; cobro proporcional si se corta.

**G. Facturación electrónica DIAN:** definir estructura legal antes de cobrar real (Faro
factura su comisión al dueño; la carga al conductor la factura el dueño o Faro por mandato);
integrar Factus; comprobante por carga + consolidado por recarga.

**H. Onboarding del dueño con "vista de amenidad":** mostrar simulador de payback (igual al
modelo) + argumento de tráfico/retención, no solo "$/kWh"; registro OCPP 1.6, precio, datos de pago.

**I. Panel del operador (Faro):** conciliación, dispersiones, facturas, mapa, y métricas
clave: **utilización por cargador (kWh/día), recompra de conductores, uptime, avance a
break-even** (activos vs. ~85–150 necesarios).

## 6. Go-to-market
1. Salir del sandbox con **5–10 sitios de destino reales en UNA zona densa** (El Poblado/Laureles).
2. Wompi en producción + DIAN mínima + dispersión automática.
3. Sembrar demanda con **concesionarios** (Tesla, BYD): registrar al comprador con saldo de regalo.
4. Medir **recompra y uptime**, no cobertura.
5. Dominar esa zona, luego replicar polígono por polígono.

## 7. Riesgos a manejar
- **Res. 40123/2024:** mostrar precio, instrucciones, tiempo y forma de pago. La carga es
  legalmente un **"servicio"** (no reventa de energía) → cualquiera puede ofrecerlo.
- **CREG de movilidad eléctrica** se define hacia 2027 → aspirar a ser la **capa de
  interoperabilidad/roaming**, no pelearla.
- **Hardware del dueño** (uptime variable) → curar/certificar equipos OCPP.
