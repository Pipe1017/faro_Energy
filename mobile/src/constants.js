export const MEDELLIN = { latitude: 6.2100, longitude: -75.5700, latitudeDelta: 0.08, longitudeDelta: 0.08 };

// Tasas del modelo (Colombia). El conductor paga base × (1 + IVA); comisión Faro sobre la base.
export const IVA_RATE = 0.19;
export const PLATFORM_MARGIN = 0.15;

export function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
