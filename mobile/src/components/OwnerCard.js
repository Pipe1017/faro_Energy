import React from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Image, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T, STATUS_COLOR } from '../theme';
import { styles } from '../styles';
import { apiFetch } from '../api';
import { IVA_RATE, PLATFORM_MARGIN } from '../constants';
import { useApp } from '../context/AppContext';

// Tarjeta de un cargador del DUEÑO: fotos, sesión activa, precio final + desglose,
// tarifa pico, costo de energía y acciones (pausar/eliminar).
export function OwnerCard({ item }) {
  const {
    editingPrice, newPrice, setNewPrice, setEditingPrice, savePrice, openEditCharger,
    chargerPhotos, photoBusy, addPhoto, removePhoto, photoUri, setPhotoView,
    togglePause, deleteCharger, fetchStatus, fetchEarnings, token,
  } = useApp();

  const color      = STATUS_COLOR[item.status] || T.offline;
  const isCharging = item.status === 'Charging';
  const isEditing  = editingPrice === item.id;

  return (
    <View style={[styles.card, styles.cardMine]}>
      <View style={styles.cardHeader}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.chargerId}>{item.id}</Text>
        <Text style={[styles.statusText, { color, fontSize: 12 }]}>{item.status}</Text>
      </View>
      <Text style={styles.location}>{item.location}</Text>
      <View style={styles.specsRow}>
        {item.power_kw       && <View style={styles.specChip}><Text style={styles.specText}>⚡ {item.power_kw} kW</Text></View>}
        {item.connector_type && <View style={styles.specChip}><Text style={styles.specText}>{item.connector_type}</Text></View>}
      </View>

      {/* Fotos del cargador — el dueño agrega/quita; el conductor las ve al tocarlo */}
      {(() => {
        const photos = chargerPhotos[item.id] || [];
        const busy   = photoBusy === item.id;
        return (
          <View style={{ marginTop: 4, marginBottom: 8 }}>
            <Text style={styles.priceLabel}>Fotos del cargador <Text style={{ color: T.textMuted }}>({photos.length}/6)</Text></Text>
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
        );
      })()}

      {/* Sesión activa — vista del dueño */}
      {isCharging && item.current_kwh != null && (
        <View style={styles.sessionBox}>
          <View style={styles.sessionRow}>
            <Text style={styles.sessionLabel}>En uso ahora</Text>
            <Text style={styles.sessionValue}>{item.current_kwh} kWh</Text>
          </View>
          <View style={styles.sessionRow}>
            <Text style={styles.sessionLabel}>Ingreso estimado</Text>
            <Text style={styles.sessionCost}>$ {Math.round(item.current_kwh * (item.price_per_kwh_now ?? item.price_per_kwh ?? 0)).toLocaleString('es-CO')} COP</Text>
          </View>
          {item.session_user && (
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>Usuario</Text>
              <Text style={styles.sessionValue}>{item.session_user}</Text>
            </View>
          )}
        </View>
      )}

      {/* Precio FINAL al conductor (IVA incluido) + desglose */}
      {(() => {
        const base       = item.price_per_kwh || 0;
        const finalP     = Math.round(base * (1 + IVA_RATE));            // lo que paga el conductor
        const iva        = finalP - base;                                // IVA a la DIAN
        const commission = Math.round(base * PLATFORM_MARGIN * (1 + IVA_RATE)); // comisión Faro + su IVA
        const energy     = item.cost_per_kwh || 0;                       // tu costo de electricidad
        const net        = Math.round(base - base * PLATFORM_MARGIN * (1 + IVA_RATE) - energy);
        if (isEditing) {
          return (
            <View style={styles.priceEditor}>
              <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
                keyboardType="numeric" placeholder="Precio final, ej: 1500" placeholderTextColor="#94866f" autoFocus />
              <Text style={styles.priceUnit}>COP/kWh</Text>
              <TouchableOpacity style={styles.priceSave} onPress={() => savePrice(item.id)}>
                <Feather name="check" size={18} color="#fdfbf7" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
                <Text style={styles.priceCancelText}>✕</Text>
              </TouchableOpacity>
            </View>
          );
        }
        return (
          <>
            <TouchableOpacity style={styles.priceRow} onPress={() => {
              if (isCharging) { Alert.alert('En uso', 'No puedes cambiar el precio mientras un conductor está cargando.'); return; }
              openEditCharger(item); }}>
              <View>
                <Text style={styles.priceLabel}>Precio final al conductor (IVA incl.)</Text>
                <Text style={styles.priceValue}>$ {finalP.toLocaleString('es-CO')} / kWh</Text>
              </View>
              <Feather name="edit-2" size={14} color={T.green} />
            </TouchableOpacity>
            {/* Desglose: de cada $final, a dónde va */}
            <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 10, marginTop: 6, borderWidth: 1, borderColor: T.cardBorder }}>
              <Text style={{ color: T.textMuted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
                DE CADA $ {finalP.toLocaleString('es-CO')} / kWh
              </Text>
              {[
                ['IVA (a la DIAN)', `− $ ${iva.toLocaleString('es-CO')}`],
                [`Comisión Faro (${Math.round(PLATFORM_MARGIN * 100)}% + IVA)`, `− $ ${commission.toLocaleString('es-CO')}`],
                [energy > 0 ? 'Tu energía (costo)' : 'Tu energía — defínela abajo', energy > 0 ? `− $ ${energy.toLocaleString('es-CO')}` : '—'],
              ].map(([l, v]) => (
                <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                  <Text style={{ color: T.textSec, fontSize: 12 }}>{l}</Text>
                  <Text style={{ color: T.textPri, fontSize: 12 }}>{v}</Text>
                </View>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTopWidth: 1, borderTopColor: T.cardBorder }}>
                <Text style={{ color: T.green, fontSize: 13, fontWeight: '800' }}>Tu ganancia / kWh{energy > 0 ? '' : ' (antes de energía)'}</Text>
                <Text style={{ color: T.green, fontSize: 13, fontWeight: '800' }}>≈ $ {net.toLocaleString('es-CO')}</Text>
              </View>
            </View>
          </>
        );
      })()}

      {/* Tarifa pico (6–10 pm) */}
      {editingPrice === `peak_${item.id}` ? (
        <View style={styles.priceEditor}>
          <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
            keyboardType="numeric" placeholder="Vacío = quitar" placeholderTextColor={T.textMuted} autoFocus />
          <Text style={styles.priceUnit}>COP/kWh</Text>
          <TouchableOpacity style={styles.priceSave} onPress={async () => {
            // El dueño escribe el precio pico FINAL (IVA incl.) → guardamos la base.
            const peakFinal = parseFloat(newPrice);
            const peakBase = peakFinal > 0 ? Math.round(peakFinal / (1 + IVA_RATE)) : null;
            try {
              await apiFetch(`/chargers/${item.id}/peak-price`, { method: 'PATCH',
                body: JSON.stringify({ peak_price_per_kwh: peakBase }) }, token);
              setEditingPrice(null); fetchStatus();
            } catch (e) { Alert.alert('Error', e.message); }
          }}>
            <Feather name="check" size={18} color="#fdfbf7" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
            <Feather name="x" size={18} color={T.textMuted} />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={[styles.priceRow, { marginTop: 4, borderTopWidth: 1, borderTopColor: T.cardBorder }]}
          onPress={() => {
            if (isCharging) { Alert.alert('En uso', 'No puedes cambiar el precio mientras un conductor está cargando.'); return; }
            openEditCharger(item); }}>
          <View>
            <Text style={styles.priceLabel}>Tarifa pico (6–10 pm) — final IVA incl.</Text>
            <Text style={[styles.priceValue, !item.peak_price_per_kwh && { color: T.textMuted, fontSize: 13 }]}>
              {item.peak_price_per_kwh ? `$ ${Math.round(item.peak_price_per_kwh * (1 + IVA_RATE)).toLocaleString('es-CO')} / kWh` : 'Sin tarifa pico'}
            </Text>
          </View>
          <Feather name="edit-2" size={14} color={item.peak_price_per_kwh ? T.green : T.textMuted} />
        </TouchableOpacity>
      )}

      {/* Costo electricidad */}
      {editingPrice === `cost_${item.id}` ? (
        <View style={styles.priceEditor}>
          <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
            keyboardType="numeric" placeholder="Ej: 650" placeholderTextColor={T.textMuted} autoFocus />
          <Text style={styles.priceUnit}>COP/kWh</Text>
          <TouchableOpacity style={styles.priceSave} onPress={async () => {
            const cost = parseFloat(newPrice);
            if (!cost || cost <= 0) return;
            await apiFetch(`/chargers/${item.id}/cost`, { method: 'PATCH', body: JSON.stringify({ cost_per_kwh: cost }) }, token);
            setEditingPrice(null); fetchStatus(); fetchEarnings();
          }}>
            <Feather name="check" size={18} color="#fdfbf7" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
            <Feather name="x" size={18} color={T.textMuted} />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={[styles.priceRow, { marginTop: 4, borderTopWidth: 1, borderTopColor: T.cardBorder }]}
          onPress={() => openEditCharger(item)}>
          <View>
            <Text style={styles.priceLabel}>Mi costo de electricidad</Text>
            <Text style={[styles.priceValue, { fontSize: 13 }]}>$ {(item.cost_per_kwh || 0).toLocaleString('es-CO')} / kWh</Text>
          </View>
          <Feather name="edit-2" size={14} color={T.textMuted} />
        </TouchableOpacity>
      )}

      {/* Acciones */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, borderTopWidth: 1, borderTopColor: T.cardBorder, paddingTop: 10, flexWrap: 'wrap' }}>
        {item.status !== 'Offline' && item.status !== 'Charging' && (
          <TouchableOpacity
            style={[styles.btn, { flex: 1, minWidth: 90, marginTop: 0, paddingVertical: 9,
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
          style={[styles.btn, { flex: 1, minWidth: 90, marginTop: 0, paddingVertical: 9,
            backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]}
          onPress={() => deleteCharger(item)}>
          <Feather name="trash-2" size={13} color={T.dangerText} />
          <Text style={[styles.btnText, { fontSize: 12, color: T.dangerText }]}>Eliminar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
