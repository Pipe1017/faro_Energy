import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T, STATUS_COLOR } from '../theme';
import { styles } from '../styles';
import { IVA_RATE, PLATFORM_MARGIN } from '../constants';
import { useApp } from '../context/AppContext';

// Tarjeta minimalista del cargador del DUEÑO: estado, specs, precio (solo lectura),
// fotos (agregar/quitar) y acciones (pausar / eliminar). La edición de precios se
// hace al crear el cargador; aquí la lista es para ver y administrar.
export function OwnerCard({ item }) {
  const {
    chargerPhotos, photoBusy, addPhoto, removePhoto, photoUri, setPhotoView,
    togglePause, deleteCharger, openEditCharger,
  } = useApp();

  const color      = STATUS_COLOR[item.status] || T.offline;
  const isCharging = item.status === 'Charging';
  const base       = item.price_per_kwh || 0;
  const finalP     = Math.round(base * (1 + IVA_RATE));
  const energy     = item.cost_per_kwh || 0;
  const net        = Math.round(base - base * PLATFORM_MARGIN * (1 + IVA_RATE) - energy);
  const photos     = chargerPhotos[item.id] || [];
  const busy       = photoBusy === item.id;

  return (
    <View style={[styles.card, styles.cardMine]}>
      <View style={styles.cardHeader}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        {item.icon ? <Text style={{ fontSize: 16, marginRight: 4 }}>{item.icon}</Text> : null}
        <Text style={styles.chargerId} numberOfLines={1}>{item.name || item.id}</Text>
        <Text style={[styles.statusText, { color, fontSize: 12 }]}>{item.status}</Text>
      </View>
      {item.name ? <Text style={{ color: T.textMuted, fontSize: 11, marginTop: -2, marginBottom: 2 }}>{item.id}</Text> : null}
      <Text style={styles.location}>{item.location}</Text>
      <View style={styles.specsRow}>
        {item.power_kw       && <View style={styles.specChip}><Text style={styles.specText}>⚡ {item.power_kw} kW</Text></View>}
        {item.connector_type && <View style={styles.specChip}><Text style={styles.specText}>{item.connector_type}</Text></View>}
        {base > 0 && <View style={styles.specChip}><Text style={styles.specText}>$ {finalP.toLocaleString('es-CO')}/kWh</Text></View>}
      </View>

      {/* Precio y ganancia — solo lectura (se define al crear el cargador) */}
      {base > 0 && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: T.surface, borderRadius: 10, padding: 10, marginTop: 4, borderWidth: 1, borderColor: T.cardBorder }}>
          <View>
            <Text style={{ color: T.textMuted, fontSize: 10.5 }}>Precio final (IVA incl.)</Text>
            <Text style={{ color: T.textPri, fontSize: 14, fontWeight: '700' }}>$ {finalP.toLocaleString('es-CO')} / kWh</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: T.textMuted, fontSize: 10.5 }}>Tu ganancia / kWh{energy > 0 ? '' : ' (s/ energía)'}</Text>
            <Text style={{ color: T.green, fontSize: 14, fontWeight: '800' }}>≈ $ {net.toLocaleString('es-CO')}</Text>
          </View>
        </View>
      )}

      {/* Sesión activa — vista del dueño */}
      {isCharging && item.current_kwh != null && (
        <View style={styles.sessionBox}>
          <View style={styles.sessionRow}>
            <Text style={styles.sessionLabel}>En uso ahora</Text>
            <Text style={styles.sessionValue}>{item.current_kwh} kWh</Text>
          </View>
          {item.session_user && (
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>Usuario</Text>
              <Text style={styles.sessionValue}>{item.session_user}</Text>
            </View>
          )}
        </View>
      )}

      {/* Fotos del cargador */}
      <View style={{ marginTop: 8 }}>
        <Text style={styles.priceLabel}>Fotos <Text style={{ color: T.textMuted }}>({photos.length}/6)</Text></Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
          {photos.map(p => (
            <View key={p.id} style={{ marginRight: 8 }}>
              <TouchableOpacity activeOpacity={0.9} onPress={() => setPhotoView({ url: photoUri(p) })}>
                <Image source={{ uri: photoUri(p) }} style={styles.ownerPhotoThumb} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.photoDelBtn} onPress={() => removePhoto(item.id, p.id)}>
                <Feather name="x" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
          ))}
          {photos.length < 6 && (
            <TouchableOpacity style={styles.photoAddBtn} onPress={() => addPhoto(item.id)} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color={T.green} />
                    : <><Feather name="camera" size={18} color={T.green} /><Text style={styles.photoAddText}>Agregar</Text></>}
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>

      {/* Acciones */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, borderTopWidth: 1, borderTopColor: T.cardBorder, paddingTop: 10 }}>
        <TouchableOpacity
          style={[styles.btn, { flex: 1, marginTop: 0, paddingVertical: 9, backgroundColor: T.greenFaint, borderWidth: 1, borderColor: T.greenDark }]}
          onPress={() => openEditCharger(item)}>
          <Feather name="edit-2" size={13} color={T.green} />
          <Text style={[styles.btnText, { fontSize: 12, color: T.green }]}>Editar</Text>
        </TouchableOpacity>
        {item.status !== 'Offline' && item.status !== 'Charging' && (
          <TouchableOpacity
            style={[styles.btn, { flex: 1, marginTop: 0, paddingVertical: 9,
              backgroundColor: item.status === 'Unavailable' ? T.greenFaint : T.surface,
              borderWidth: 1, borderColor: item.status === 'Unavailable' ? T.greenDark : T.cardBorder }]}
            onPress={() => togglePause(item)}>
            <Feather name={item.status === 'Unavailable' ? 'play' : 'pause'} size={13}
              color={item.status === 'Unavailable' ? T.green : T.textMuted} />
            <Text style={[styles.btnText, { fontSize: 12, color: item.status === 'Unavailable' ? T.green : T.textMuted }]}>
              {item.status === 'Unavailable' ? 'Reanudar' : 'Pausar'}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.btn, { flex: 1, marginTop: 0, paddingVertical: 9, backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]}
          onPress={() => deleteCharger(item)}>
          <Feather name="trash-2" size={13} color={T.dangerText} />
          <Text style={[styles.btnText, { fontSize: 12, color: T.dangerText }]}>Eliminar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
