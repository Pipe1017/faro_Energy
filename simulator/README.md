# Simuladores de cargadores OCPP

Hay dos, con propósitos distintos:

- **`backend/sim.py`** (interno): el backend lo arranca solo para cada cargador
  registrado. Es el que se usa en desarrollo normal — no requiere terminal aparte.

- **`simulator/charger.py`** (externo, este archivo): simula un cargador físico
  REAL conectándose desde afuera por WebSocket. Útil para validar el endpoint
  OCPP con un cliente externo (como hará el hardware real).
  Uso: `python charger.py <CHARGER_ID> [potencia_kw]`
