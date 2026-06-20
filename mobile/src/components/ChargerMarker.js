import React, { memo, useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { Marker } from 'react-native-maps';
import { T, STATUS_COLOR } from '../theme';

// NOTA DE ESTABILIDAD: los marcadores de react-native-maps deben ser SOLO View+Text.
// Meter react-native-svg o íconos de fuente dentro de un <Marker> hace que en Android
// los pines DESAPAREZCAN al hacer zoom/redibujar el mapa. Por eso aquí no hay SVG.

export const ChargerMarker = memo(({ charger, isSelected, isMine, onPress }) => {
  const color   = STATUS_COLOR[charger.status] || T.offline;
  const price   = Math.round((charger.price_per_kwh_now ?? charger.price_per_kwh ?? 0) * 1.19);
  const isCharg = charger.status === 'Charging';
  const isDown  = charger.status === 'Offline' || charger.status === 'Unavailable' || charger.status === 'Faulted';
  const specs   = [charger.power_kw ? `${charger.power_kw} kW` : null, charger.connector_type]
                    .filter(Boolean).join(' · ');

  // Re-captura el snapshot un instante al cambiar algo real, luego lo congela.
  // El render NO depende del zoom → mover/zoom no re-dibuja el pin.
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [charger.status, charger.price_per_kwh, charger.price_per_kwh_now, isSelected, isMine, specs]);

  const d = isSelected ? 30 : 24;

  return (
    <Marker identifier={charger.id} coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={tracks} anchor={{ x: 0.5, y: 1.0 }}>
      <View style={{ alignItems: 'center' }}>
        {/* Burbuja: precio + potencia + enchufe */}
        {(price > 0 || specs) && (
          <View style={{ backgroundColor: '#fff', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 3,
            marginBottom: 3, borderWidth: 1, borderColor: color, alignItems: 'center',
            shadowColor: '#2b2520', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 }}>
            {price > 0 && !isDown && (
              <Text style={{ color: '#2b2520', fontWeight: '800', fontSize: 11 }}>${price.toLocaleString('es-CO')}/kWh</Text>
            )}
            {!!specs && <Text style={{ color: '#6b5d4a', fontWeight: '600', fontSize: 9.5 }}>{specs}</Text>}
          </View>
        )}

        {/* Pin: círculo de color (estado) con centro claro. Sin SVG/íconos. */}
        <View style={{
          width: d, height: d, borderRadius: d / 2, backgroundColor: color,
          alignItems: 'center', justifyContent: 'center',
          opacity: isDown ? 0.5 : 1,
          borderWidth: isMine ? 3 : 2, borderColor: isMine ? '#faf7f1' : 'rgba(255,255,255,0.7)',
          shadowColor: '#2b2520', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4,
        }}>
          {/* centro: marfil si está cargando (resalta), si no un punto pequeño */}
          <View style={{ width: isCharg ? d * 0.5 : d * 0.32, height: isCharg ? d * 0.5 : d * 0.32,
            borderRadius: d, backgroundColor: isCharg ? '#faf7f1' : 'rgba(255,255,255,0.85)' }} />
        </View>

        {/* Punta hacia la ubicación */}
        <View style={{ width: 0, height: 0, marginTop: -1,
          borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
          borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: color,
          opacity: isDown ? 0.5 : 1 }} />
      </View>
    </Marker>
  );
}, (prev, next) =>
  prev.charger.status === next.charger.status &&
  prev.charger.price_per_kwh === next.charger.price_per_kwh &&
  prev.charger.price_per_kwh_now === next.charger.price_per_kwh_now &&
  prev.charger.power_kw === next.charger.power_kw &&
  prev.charger.connector_type === next.charger.connector_type &&
  prev.isSelected === next.isSelected &&
  prev.isMine === next.isMine
);

// Cargador externo (Open Charge Map) — punto hueco gris, claramente distinto.
// Solo View, sin íconos → estable.
export const ExternalMarker = memo(({ charger, onPress }) => (
  <Marker coordinate={{ latitude: charger.lat, longitude: charger.lng }}
    onPress={onPress} tracksViewChanges={false} anchor={{ x: 0.5, y: 0.5 }} opacity={0.9}>
    <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#faf7f1',
      borderWidth: 2, borderColor: T.textMuted }} />
  </Marker>
), (prev, next) => prev.charger.id === next.charger.id);
