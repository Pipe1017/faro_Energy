"""Estado runtime en memoria (no se persiste)."""
from typing import Dict

# WebSocket connections OCPP — viven en memoria del proceso
connected_chargers: Dict[str, object] = {}
