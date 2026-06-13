// ─────────────────────────────────────────────────────────────────────────────
// Geolocalización y navegación — ubicación del usuario, cargador más cercano y
// apertura de apps de mapas (Google Maps / Waze / Apple Maps).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useCallback } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import * as Location from 'expo-location';

// ── Distancia Haversine en kilómetros entre dos { latitude, longitude } ────────
export function haversineKm(a, b) {
  const R = 6371; // radio terrestre (km)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Texto legible de distancia: "850 m" / "3.2 km"
export function formatDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// ── Cargador más cercano ───────────────────────────────────────────────────────
// Prioriza los 'Available'; si no hay ninguno disponible, cae al más cercano sin
// importar el estado. Devuelve { charger, km } o null.
export function nearestCharger(coords, chargers) {
  if (!coords || !Array.isArray(chargers)) return null;
  const withGeo = chargers
    .filter((c) => c.lat != null && c.lng != null)
    .map((c) => ({
      charger: c,
      km: haversineKm(coords, { latitude: c.lat, longitude: c.lng }),
    }));
  if (withGeo.length === 0) return null;

  const available = withGeo.filter((x) => x.charger.status === 'Available');
  const pool = available.length ? available : withGeo;
  pool.sort((a, b) => a.km - b.km);
  return pool[0];
}

// ── Hook de ubicación del usuario ───────────────────────────────────────────────
// El permiso se pide de forma perezosa (al llamar request()), no al montar, para
// respetar la privacidad y no disparar el diálogo del sistema sin acción del usuario.
// status: 'idle' | 'granted' | 'denied' | 'error'
export function useUserLocation() {
  const [coords, setCoords] = useState(null);
  const [status, setStatus] = useState('idle');
  const [loading, setLoading] = useState(false);

  const request = useCallback(async () => {
    setLoading(true);
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setStatus('denied');
        return null;
      }
      setStatus('granted');
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const c = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setCoords(c);
      return c;
    } catch (e) {
      setStatus('error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { coords, status, loading, request };
}

// ── Abrir direcciones en Google Maps / Waze / Apple Maps ────────────────────────
// Muestra un menú con las apps disponibles. Para cada una intenta primero el
// esquema nativo (deep-link directo a navegación) y cae al enlace https universal,
// que el SO resuelve a la app instalada o al navegador.
export async function openDirections({ lat, lng, label = 'Cargador' }) {
  if (lat == null || lng == null) {
    Alert.alert('Sin ubicación', 'Este cargador no tiene coordenadas registradas.');
    return;
  }
  const dest = `${lat},${lng}`;

  const candidates = [
    {
      name: 'Google Maps',
      app: Platform.select({
        ios: `comgooglemaps://?daddr=${dest}&directionsmode=driving`,
        android: `google.navigation:q=${dest}`,
      }),
      web: `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`,
    },
    {
      name: 'Waze',
      app: `waze://?ll=${dest}&navigate=yes`,
      web: `https://waze.com/ul?ll=${dest}&navigate=yes`,
    },
  ];
  if (Platform.OS === 'ios') {
    candidates.push({
      name: 'Apple Maps',
      app: `http://maps.apple.com/?daddr=${dest}&dirflg=d`,
      web: `http://maps.apple.com/?daddr=${dest}&dirflg=d`,
    });
  }

  const launch = async ({ app, web }) => {
    try {
      if (app && (await Linking.canOpenURL(app))) {
        await Linking.openURL(app);
        return;
      }
    } catch (_) {
      // sigue al fallback https
    }
    Linking.openURL(web).catch(() =>
      Alert.alert('No se pudo abrir', 'No hay una app de mapas disponible.')
    );
  };

  const buttons = candidates.map((c) => ({ text: c.name, onPress: () => launch(c) }));
  buttons.push({ text: 'Cancelar', style: 'cancel' });

  Alert.alert('Cómo llegar', label, buttons, { cancelable: true });
}
