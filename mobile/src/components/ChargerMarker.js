import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { Marker, Callout } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import { T, STATUS_COLOR } from '../theme';
import { styles } from '../styles';

export const ChargerMarker = memo(({ charger, isSelected, isMine, onPress, zoom }) => {
  const color   = STATUS_COLOR[charger.status] || T.offline;
  const price   = Math.round((charger.price_per_kwh_now ?? charger.price_per_kwh ?? 0) * 1.19);
  const isCharg = charger.status === 'Charging';

  // Lejos → solo bolita de color (mismo comportamiento que antes)
  if (zoom === 'far' && !isSelected) {
    return (
      <Marker identifier={charger.id}
        coordinate={{ latitude: charger.lat, longitude: charger.lng }}
        onPress={onPress} tracksViewChanges={false} anchor={{ x: 0.5, y: 0.5 }}>
        <View style={[styles.mapPin, { borderColor: isMine ? T.green : color }]}>
          <View style={[styles.mapPinDot, { backgroundColor: color }]} />
          {isMine && <View style={styles.mapPinMark} />}
        </View>
      </Marker>
    );
  }

  // Cerca/seleccionado → burbuja con precio
  const bubbleBg    = isSelected ? '#2b2520' : '#ffffff';
  const priceColor  = isSelected ? '#ffffff' : '#2b2520';
  const specColor   = isSelected ? 'rgba(255,255,255,0.6)' : '#94866f';
  const borderColor = isSelected ? color : 'rgba(0,0,0,0.12)';
  const tipColor    = isSelected ? '#2b2520' : '#ffffff';

  return (
    <Marker identifier={charger.id}
      coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={isSelected} anchor={{ x: 0.5, y: 1.0 }}>
      <View style={{ alignItems: 'center' }}>
        <View style={[styles.mapBubble, { backgroundColor: bubbleBg, borderColor,
          borderWidth: isSelected ? 2 : 1,
          transform: [{ scale: isSelected ? 1.08 : 1 }],
        }]}>
          {/* Bolita de estado si está cargando */}
          {isCharg && <View style={[styles.mapBubbleStatusDot, { backgroundColor: color }]} />}
          <Text style={{ color: priceColor, fontWeight: '800', fontSize: 15, letterSpacing: -0.3 }}>
            {price > 0 ? `$${price.toLocaleString('es-CO')}/kWh` : charger.status}
          </Text>
          {/* Potencia y tipo de enchufe en la burbuja flotante */}
          {(charger.power_kw || charger.connector_type) && (
            <Text style={{ color: specColor, fontSize: 11, marginTop: 1 }}>
              {[charger.power_kw ? `${charger.power_kw} kW` : null, charger.connector_type]
                .filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
        {/* Punta triangular que apunta a la ubicación */}
        <View style={[styles.mapBubbleTip, { borderTopColor: tipColor }]} />
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

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
