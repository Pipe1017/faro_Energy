# Perfiles de marca de cargadores

Cada archivo `<id>.json` describe una marca/modelo de cargador: qué features
OCPP soporta, sus quirks y la guía de instalación que ve el dueño.

Se cargan automáticamente al arrancar el backend (ver `config.py`).
**Para integrar una marca nueva: agrega un archivo JSON aquí** — sin tocar código.

Campos: id, vendor, model (null = todo el vendor), display_name, ocpp_version,
connector_types, max_power_kw, features, quirks, setup_guide_md.

El matching con un cargador real usa `vendor`/`model` del BootNotification.
