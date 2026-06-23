import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { KbSheet } from '../hooks';
import { useApp } from '../context/AppContext';

// Gestión de Unidades (cargadores privados) del dueño: crear, ver código de
// invitación, administrar miembros (agregar por correo / quitar) y borrar.
export function UnitsModal() {
  const { units, createUnit, addMember, removeMember, deleteUnit, setUnitsModal } = useApp();
  const [newName, setNewName]   = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(null);   // unit.id abierto
  const [email, setEmail]       = useState('');
  const [busy, setBusy]         = useState(false);

  const onCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try { await createUnit(newName.trim()); setNewName(''); }
    catch (e) { Alert.alert('Error', e.message); }
    finally { setCreating(false); }
  };
  const onAddMember = async (unitId) => {
    if (!email.trim()) return;
    setBusy(true);
    try { await addMember(unitId, email.trim()); setEmail(''); }
    catch (e) { Alert.alert('No se pudo agregar', e.message); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.modalOverlay}>
      <TouchableOpacity style={{ flex: 1 }} onPress={() => setUnitsModal(false)} activeOpacity={1} />
      <KbSheet>
        <ScrollView style={{ maxHeight: '100%', flexGrow: 0 }} contentContainerStyle={styles.modal}
          keyboardShouldPersistTaps="handled" bounces={false}>
          <View style={styles.mapPanelHandle} />
          <View style={styles.mapPanelHeader}>
            <View>
              <Text style={styles.modalTitle}>Unidades</Text>
              <Text style={styles.mapPanelLocation}>Cargadores privados: solo los miembros pueden cargar.</Text>
            </View>
            <TouchableOpacity onPress={() => setUnitsModal(false)} style={{ padding: 4 }}>
              <Feather name="x" size={20} color={T.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Crear unidad */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
            <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} placeholder="Nueva unidad (ej: Torre 2)"
              placeholderTextColor={T.textMuted} value={newName} onChangeText={setNewName} autoCapitalize="words" />
            <TouchableOpacity style={[styles.btn, styles.btnStart, { marginTop: 0, paddingHorizontal: 16 }]} onPress={onCreate} disabled={creating}>
              {creating ? <ActivityIndicator size="small" color="#fdfbf7" /> : <Text style={styles.btnText}>Crear</Text>}
            </TouchableOpacity>
          </View>

          {units.length === 0 ? (
            <Text style={[styles.emptyHint, { marginTop: 8 }]}>Aún no tienes unidades. Crea una y asígnale cargadores al editarlos.</Text>
          ) : units.map(u => {
            const open = expanded === u.id;
            return (
              <View key={u.id} style={[styles.card, { marginBottom: 10 }]}>
                <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  onPress={() => { setExpanded(open ? null : u.id); setEmail(''); }}>
                  <Feather name="home" size={16} color={T.green} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 14 }}>{u.name}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>{u.members_count} miembro(s) · {u.chargers_count} cargador(es)</Text>
                  </View>
                  <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={T.textMuted} />
                </TouchableOpacity>

                {/* Código de invitación */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.greenFaint, borderRadius: 10, padding: 10, marginTop: 8, borderWidth: 1, borderColor: T.greenDark }}>
                  <Feather name="key" size={14} color={T.green} />
                  <Text style={{ color: T.textSec, fontSize: 12, flex: 1 }}>Código de invitación: <Text style={{ fontWeight: '800', color: T.green, letterSpacing: 1 }}>{u.join_code}</Text></Text>
                </View>

                {open && (
                  <View style={{ marginTop: 10 }}>
                    {/* Miembros */}
                    <Text style={styles.priceLabel}>Miembros</Text>
                    {(u.members || []).map(m => (
                      <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.cardBorder }}>
                        <Feather name="user" size={13} color={T.textMuted} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: T.textPri, fontSize: 12.5 }}>{m.name || m.email}</Text>
                          {m.name ? <Text style={{ color: T.textMuted, fontSize: 10.5 }}>{m.email}</Text> : null}
                        </View>
                        <TouchableOpacity onPress={() => removeMember(u.id, m.user_id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Feather name="x-circle" size={16} color={T.dangerText} />
                        </TouchableOpacity>
                      </View>
                    ))}

                    {/* Agregar por correo */}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} placeholder="Correo del residente"
                        placeholderTextColor={T.textMuted} value={email} onChangeText={setEmail}
                        autoCapitalize="none" keyboardType="email-address" />
                      <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 0, paddingHorizontal: 14 }]} onPress={() => onAddMember(u.id)} disabled={busy}>
                        {busy ? <ActivityIndicator size="small" color="#fdfbf7" /> : <Text style={styles.btnText}>Agregar</Text>}
                      </TouchableOpacity>
                    </View>
                    <Text style={{ color: T.textMuted, fontSize: 10.5, marginTop: 6 }}>
                      También pueden unirse solos con el código de arriba.
                    </Text>

                    <TouchableOpacity style={[styles.btn, { marginTop: 12, paddingVertical: 9, backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]} onPress={() => deleteUnit(u)}>
                      <Feather name="trash-2" size={13} color={T.dangerText} />
                      <Text style={[styles.btnText, { fontSize: 12, color: T.dangerText }]}>Borrar unidad</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      </KbSheet>
    </View>
  );
}
