import React, { memo, useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { Marker } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { T, STATUS_COLOR } from '../theme';
import { styles } from '../styles';

// Faro (linterna) en un solo color — el símbolo de marca, ahora como pin del mapa.
function Faro({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size * 48 / 78} height={size} viewBox="36 28 48 78">
      <Path d="M50 44 L60 34 L70 44 Z" fill={color} />
      <Rect x="52" y="44" width="16" height="14" rx="3" fill={color} />
      <Path d="M53 58 L67 58 L72 98 L48 98 Z" fill={color} />
      <Rect x="42" y="98" width="36" height="5" rx="2.5" fill={color} />
    </Svg>
  );
}

export const ChargerMarker = memo(({ charger, isSelected, isMine, onPress, zoom }) => {
  const color   = STATUS_COLOR[charger.status] || T.offline;
  const price   = Math.round((charger.price_per_kwh_now ?? charger.price_per_kwh ?? 0) * 1.19);
  const isCharg = charger.status === 'Charging';
  const isDown  = charger.status === 'Offline' || charger.status === 'Unavailable' || charger.status === 'Faulted';

  // Los cargadores Faro son POCOS → mantenemos tracksViewChanges=true para que el
  // pin nunca se "congele" ni desaparezca cuando entran los pines de la API.
  // Lejos → bolita de color (limpio, sin saturar el mapa)
  if (zoom === 'far' && !isSelected) {
    return (
      <Marker identifier={charger.id} coordinate={{ latitude: charger.lat, longitude: charger.lng }}
        onPress={onPress} tracksViewChanges={true} anchor={{ x: 0.5, y: 0.5 }}>
        <View style={[styles.mapPin, { borderColor: isMine ? T.green : color }]}>
          <View style={[styles.mapPinDot, { backgroundColor: color }]} />
        </View>
      </Marker>
    );
  }

  const d        = isSelected ? 42 : 34;          // diámetro del faro
  const showInfo = zoom === 'close' || isSelected;

  return (
    <Marker identifier={charger.id} coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={true} anchor={{ x: 0.5, y: 1.0 }}>
      <View style={{ alignItems: 'center' }}>
        {/* Burbuja de precio (cargadores disponibles) */}
        {showInfo && price > 0 && !isDown && (
          <View style={{ backgroundColor: '#fff', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2,
            marginBottom: 3, borderWidth: 1, borderColor: color,
            shadowColor: '#2b2520', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 }}>
            <Text style={{ color: '#2b2520', fontWeight: '800', fontSize: 11 }}>${price.toLocaleString('es-CO')}</Text>
          </View>
        )}

        {/* El faro */}
        <View style={{
          width: d, height: d, borderRadius: d / 2, backgroundColor: color,
          alignItems: 'center', justifyContent: 'center',
          opacity: isDown ? 0.55 : 1,
          borderWidth: isMine ? 3 : 1.5, borderColor: isMine ? '#faf7f1' : 'rgba(255,255,255,0.55)',
          shadowColor: '#2b2520', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4,
          transform: [{ scale: isSelected ? 1.05 : 1 }],
        }}>
          <Faro size={d * 0.56} color="#faf7f1" />

          {/* Badge: cargando (rayo índigo) */}
          {isCharg && (
            <View style={{ position: 'absolute', top: -3, right: -3, width: 15, height: 15, borderRadius: 8,
              backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.charging }}>
              <Feather name="zap" size={9} color={T.charging} />
            </View>
          )}
          {/* Badge: es MÍO (dueño) */}
          {isMine && !isCharg && (
            <View style={{ position: 'absolute', top: -3, right: -3, width: 15, height: 15, borderRadius: 8,
              backgroundColor: '#faf7f1', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.green }}>
              <Feather name="home" size={8} color={T.green} />
            </View>
          )}
        </View>

        {/* Punta que apunta a la ubicación */}
        <View style={{ width: 0, height: 0, marginTop: -1,
          borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
          borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: color,
          opacity: isDown ? 0.55 : 1 }} />
      </View>
    </Marker>
  );
}, (prev, next) =>
  prev.charger.status === next.charger.status &&
  prev.charger.price_per_kwh === next.charger.price_per_kwh &&
  prev.charger.price_per_kwh_now === next.charger.price_per_kwh_now &&
  prev.isSelected === next.isSelected &&
  prev.isMine === next.isMine &&
  prev.zoom === next.zoom
);

// Pin de cargador externo (Open Charge Map) — claramente NO es un faro: punto
// tenue con enchufe, para que se distinga de los cargadores Faro.
export const ExternalMarker = memo(({ charger, onPress, zoom }) => {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 700);
    return () => clearTimeout(t);
  }, [zoom]);
  return (
    <Marker coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={tracks} anchor={{ x: 0.5, y: 0.5 }} opacity={0.92}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
        alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: T.textMuted, borderStyle: 'dashed' }}>
        <Feather name="zap" size={11} color={T.textMuted} />
      </View>
    </Marker>
  );
}, (prev, next) => prev.charger.id === next.charger.id && prev.zoom === next.zoom);

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
