# Reglas del juego — Faro Energy

> Cómo funciona la plata: comisiones, pagos a dueños, facturas y la parte legal.
> Resumen claro para operar sin complicarse ni hacer nada indebido.

## Modelo: Faro es intermediario (comisionista)
Faro **no vende energía**: pone la plataforma. El dueño presta el servicio de recarga;
Faro cobra una **comisión**. Por eso Faro tributa **solo sobre su comisión**, no sobre
todo lo que pasa por la plataforma.

## 💰 Comisiones
- El **conductor paga**: recarga + IVA.
- **Faro cobra 10%**, descontado del dueño → bolsa "Ingreso Faro".
- En el back-office → **Comisiones**: total por periodo y por dueño.

## 🏦 Pagos a dueños
- Cada dueño acumula **saldo** = recarga − comisión − pasarela.
- Faro le paga. Hoy **manual**: transfieres por Nequi/banco y lo **registras** en el
  detalle del dueño (queda el registro y se descuenta su saldo).
- El dueño **recibe un correo** cuando se registra el pago ("Te enviamos tu liquidación").
- `AUTO_SETTLEMENT=false` → no hay giros automáticos; tú controlas cada pago.
- Futuro: modo Wompi (dispersión automática) — mismo flujo, solo cambia el "cómo".

## 🧾 Facturas / DIAN
- **Hoy son de PRUEBA (stub):** PDF válido pero **sin CUFE, no validado por la DIAN**.
  Dice "DOCUMENTO DE PRUEBA - NO VALIDO DIAN". **No son facturas legales.**
- Está bien **mientras se esté en beta con Wompi sandbox** (plata de mentira → no hay
  ventas reales → no se dispara obligación de facturar).
- Futuro: `INVOICE_PROVIDER=factus` → facturas DIAN reales, sin rehacer nada.

## ⚖️ ¿Legal? Sí, en beta. La línea es la plata real.
| Etapa | ¿Legal? | Qué se necesita |
|---|---|---|
| **Beta (Wompi sandbox)** | ✅ Sí | Nada — es un demo, no hay ventas reales |
| **Cobrar plata real** | ⚠️ Antes hay que | Wompi **producción** + facturas **DIAN** (Factus) + **contador** |

## 👤 Impuestos del dueño y documentación (KYC ligero)
- La ganancia del dueño **es ingreso suyo**; él la declara según su situación. No es
  papeleo que Faro recoja: es obligación de él (como un host de Airbnb o un conductor de Uber).
- Lo que Faro **sí** debe hacer al pagar: identificar al beneficiario y **reportar los
  pagos a la DIAN** (información exógena). Posible retención en la fuente (validar con contador).
- **Documentación mínima para entrar/pagar:**
  - **Cédula** ✅ · **Cuenta (Nequi/banco)** ✅ · **Aceptar términos** ✅
  - **RUT** ⚠️ condicional: solo si es responsable de IVA, para factura por mandato, o si hay retención.
- **Faro es MÁS simple que Airbnb:** la recarga no es turismo → **sin RNT, sin FONTUR,
  sin actividad 5519**. Airbnb sí exige RUT + RNT a sus anfitriones; aquí basta cédula + cuenta (+ RUT cuando crezca).

## Regla simple
> En beta no necesitas nada legal (es demo). Para cobrar de verdad: Wompi prod + Factus + contador.
> Al dueño le pides poco para entrar (cédula + cuenta); su ganancia la declara él; tú reportas el pago.

⚠️ Validar umbrales (retención, desde cuándo declara el dueño) con un **contador**. La estructura es esta.
