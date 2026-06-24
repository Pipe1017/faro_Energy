import React, { memo, useState, useEffect, useRef } from 'react';
import { View, Text, Platform, Animated } from 'react-native';
import { Marker } from 'react-native-maps';
import { T, ACCESS_COLOR } from '../theme';

// MARCADORES SOLO View+Text (sin SVG ni íconos de fuente — en Android desaparecen
// dentro de un <Marker>).
//
// RECORTE EN ANDROID ("media burbuja / un cuarto del pin / solo el precio"):
//   En Android la sombra (elevation/shadow*) se dibuja FUERA de los límites de la
//   vista; cuando react-native-maps toma el snapshot del marcador, lo recorta a esos
//   límites y se "come" la parte con sombra. Por eso: nada de elevation/shadow en
//   Android (solo iOS), sin márgenes negativos y con un padding de respiro alrededor.
//
// FLICKER: tracksViewChanges arranca true; se congela poco después de medir
//   (onLayout + respaldo por tiempo) y se re-activa solo si cambia el contenido.

// Sombra suave SOLO en iOS (en Android causa recorte del marcador).
const softShadow = Platform.OS === 'ios'
  ? { shadowColor: '#2b2520', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } }
  : null;
const pinShadow = Platform.OS === 'ios'
  ? { shadowColor: '#2b2520', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }
  : null;

// tracksViewChanges por plataforma:
//   ANDROID: SIEMPRE true. Al ponerlo en false Android guarda UNA sola foto del
//     marcador y en muchos equipos sale recortada (media burbuja / 1/4 del precio)
//     y se queda así. Manteniéndolo true se redibuja a tamaño completo (parpadeo leve).
//   iOS: congelar tras medir (sin parpadeo, allá no recorta).
function useFreeze(deps) {
  const [tracks, setTracks] = useState(true);
  const timer = useRef(null);
  useEffect(() => {
    if (Platform.OS === 'android') { setTracks(true); return; }
    setTracks(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTracks(false), 350);
    return () => timer.current && clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return tracks;
}

export const ChargerMarker = memo(({ charger, isSelected, isMine, onPress, zoom, access }) => {
  // El color del pin identifica el ACCESO (público/unidad/restringido). El estado
  // (offline/charging) se ve por la opacidad y el centro del pin.
  const color   = ACCESS_COLOR[access] || ACCESS_COLOR.public;
  const price   = Math.round((charger.price_per_kwh_now ?? charger.price_per_kwh ?? 0) * 1.19);
  const isCharg = charger.status === 'Charging';
  const isDown  = charger.status === 'Offline' || charger.status === 'Unavailable' || charger.status === 'Faulted';
  const specs   = [charger.power_kw ? `${charger.power_kw} kW` : null, charger.connector_type]
                    .filter(Boolean).join(' · ');
  // Burbuja con precio SOLO cerca o si está seleccionado. Lejos/medio → solo el punto
  // (evita la "montonera" al alejar el mapa). El foco define qué se muestra.
  const showBubble = isSelected || zoom === 'close';

  const tracks = useFreeze([
    charger.status, charger.price_per_kwh, charger.price_per_kwh_now,
    charger.power_kw, charger.connector_type, isSelected, isMine, showBubble, access,
  ]);

  // "Pop" SOLO en el marcador seleccionado (uno a la vez → barato). Ocurre dentro de
  // la ventana de captura (tracks vuelve a true al cambiar isSelected). duration<350ms
  // para que termine antes de congelar en iOS.
  const pop = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isSelected) return;
    pop.setValue(0.84);
    Animated.timing(pop, { toValue: 1, duration: 220, useNativeDriver: false }).start();
  }, [isSelected, pop]);

  const d = isSelected ? 30 : 24;

  return (
    <Marker identifier={charger.id} coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={tracks} anchor={{ x: 0.5, y: 1.0 }}
      zIndex={isSelected ? 9 : 5}>
      {/* padding de respiro: evita que el borde del snapshot recorte la vista en Android */}
      <Animated.View style={{ alignItems: 'center', padding: 4, transform: [{ scale: pop }] }} collapsable={false}>
        {/* Burbuja: precio + potencia + enchufe — solo cerca o seleccionado */}
        {showBubble && (price > 0 || specs) && (
          <View style={{ backgroundColor: '#fff', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 3,
            marginBottom: 3, borderWidth: 1, borderColor: color, alignItems: 'center',
            elevation: 0, ...softShadow }}>
            {price > 0 && !isDown && (
              <Text style={{ color: '#2b2520', fontWeight: '800', fontSize: 11 }}>${price.toLocaleString('es-CO')}/kWh</Text>
            )}
            {!!specs && <Text style={{ color: '#6b5d4a', fontWeight: '600', fontSize: 9.5 }}>{specs}</Text>}
          </View>
        )}

        {/* Pin: círculo de color (estado) con centro claro. */}
        <View style={{
          width: d, height: d, borderRadius: d / 2, backgroundColor: color,
          alignItems: 'center', justifyContent: 'center',
          opacity: isDown ? 0.5 : 1,
          borderWidth: isMine ? 3 : 2, borderColor: isMine ? '#faf7f1' : 'rgba(255,255,255,0.7)',
          elevation: 0, ...pinShadow }}>
          <View style={{ width: isCharg ? d * 0.5 : d * 0.32, height: isCharg ? d * 0.5 : d * 0.32,
            borderRadius: d, backgroundColor: isCharg ? '#faf7f1' : 'rgba(255,255,255,0.85)' }} />
        </View>

        {/* Punta hacia la ubicación (sin margen negativo: recorta en Android) */}
        <View style={{ width: 0, height: 0,
          borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
          borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: color,
          opacity: isDown ? 0.5 : 1 }} />
      </Animated.View>
    </Marker>
  );
}, (prev, next) =>
  prev.charger.status === next.charger.status &&
  prev.charger.price_per_kwh === next.charger.price_per_kwh &&
  prev.charger.price_per_kwh_now === next.charger.price_per_kwh_now &&
  prev.charger.power_kw === next.charger.power_kw &&
  prev.charger.connector_type === next.charger.connector_type &&
  prev.isSelected === next.isSelected &&
  prev.isMine === next.isMine &&
  prev.zoom === next.zoom &&
  prev.access === next.access
);
