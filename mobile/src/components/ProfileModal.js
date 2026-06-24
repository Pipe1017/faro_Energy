import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, ActivityIndicator, Alert, Linking } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { KbSheet } from '../hooks';
import { API_URL } from '../api';
import { useApp } from '../context/AppContext';

// Perfil — minimalista "Faro Claro": foto, nombre, correo, cambiar contraseña, salir.
export function ProfileModal() {
  const { user, updateName, changePassword, uploadAvatar, removeAvatar, handleLogout, setProfileModal, avatarBust } = useApp();
  const [name, setName]       = useState(user?.name || '');
  const [savingName, setSavingName] = useState(false);
  const [pwOpen, setPwOpen]   = useState(false);
  const [cur, setCur]         = useState('');
  const [nw, setNw]           = useState('');
  const [cf, setCf]           = useState('');
  const [pwBusy, setPwBusy]   = useState(false);

  const nameChanged = name.trim().length >= 2 && name.trim() !== user?.name;
  const isOwner = user?.role === 'owner';

  const onSaveName = async () => {
    setSavingName(true);
    try { await updateName(name.trim()); }
    catch (e) { Alert.alert('Error', e.message); }
    finally { setSavingName(false); }
  };
  const onChangePw = async () => {
    if (nw.length < 6) { Alert.alert('Contraseña', 'La nueva debe tener al menos 6 caracteres.'); return; }
    if (nw !== cf) { Alert.alert('Contraseña', 'La nueva y la confirmación no coinciden.'); return; }
    setPwBusy(true);
    try {
      await changePassword(cur, nw);
      setCur(''); setNw(''); setCf(''); setPwOpen(false);
      Alert.alert('Listo', 'Tu contraseña fue actualizada.');
    } catch (e) { Alert.alert('No se pudo', e.message); }
    finally { setPwBusy(false); }
  };
  const confirmLogout = () => Alert.alert('Cerrar sesión', '¿Salir de tu cuenta?', [
    { text: 'Cancelar' }, { text: 'Cerrar sesión', style: 'destructive', onPress: handleLogout },
  ]);

  const avatarUri = user?.avatar_url ? `${API_URL}${user.avatar_url}?v=${avatarBust}` : null;

  return (
    <View style={styles.modalOverlay}>
      <TouchableOpacity style={{ flex: 1 }} onPress={() => setProfileModal(false)} activeOpacity={1} />
      <KbSheet>
        <ScrollView contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled" bounces={false}>
          <View style={styles.mapPanelHandle} />
          <View style={styles.mapPanelHeader}>
            <Text style={styles.modalTitle}>Mi perfil</Text>
            <TouchableOpacity onPress={() => setProfileModal(false)} style={{ padding: 4 }}>
              <Feather name="x" size={20} color={T.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Avatar */}
          <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 18 }}>
            <TouchableOpacity activeOpacity={0.85} onPress={uploadAvatar}
              style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: T.greenFaint, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1, borderColor: T.greenDark }}>
              {avatarUri
                ? <Image source={{ uri: avatarUri }} style={{ width: '100%', height: '100%' }} />
                : <Text style={{ color: T.green, fontSize: 38, fontWeight: '800' }}>{user?.name?.[0]?.toUpperCase()}</Text>}
              <View style={{ position: 'absolute', bottom: 0, right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: T.green, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: T.bg }}>
                <Feather name="camera" size={14} color="#fdfbf7" />
              </View>
            </TouchableOpacity>
            {avatarUri ? (
              <TouchableOpacity onPress={removeAvatar} style={{ marginTop: 8 }}>
                <Text style={{ color: T.textMuted, fontSize: 12 }}>Quitar foto</Text>
              </TouchableOpacity>
            ) : null}
            <View style={{ marginTop: 10, backgroundColor: T.surface, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: T.cardBorder }}>
              <Text style={{ color: T.textSec, fontSize: 11, fontWeight: '700' }}>{isOwner ? 'Dueño de cargadores' : 'Conductor'}</Text>
            </View>
          </View>

          {/* Nombre */}
          <Text style={styles.priceLabel}>Nombre</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} value={name} onChangeText={setName}
              placeholder="Tu nombre" placeholderTextColor={T.textMuted} autoCapitalize="words" maxLength={40} />
            {nameChanged && (
              <TouchableOpacity style={[styles.btn, styles.btnStart, { marginTop: 0, paddingHorizontal: 16 }]} onPress={onSaveName} disabled={savingName}>
                {savingName ? <ActivityIndicator size="small" color="#fdfbf7" /> : <Text style={styles.btnText}>Guardar</Text>}
              </TouchableOpacity>
            )}
          </View>

          {/* Correo (solo lectura) */}
          <Text style={[styles.priceLabel, { marginTop: 14 }]}>Correo</Text>
          <View style={[styles.input, { marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
            <Text style={{ color: T.textSec, fontSize: 14 }}>{user?.email}</Text>
            {user?.email_verified
              ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Feather name="check-circle" size={13} color={T.green} /><Text style={{ color: T.green, fontSize: 11, fontWeight: '600' }}>Verificado</Text></View>
              : null}
          </View>

          {/* Cambiar contraseña */}
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingVertical: 4 }}
            onPress={() => setPwOpen(o => !o)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Feather name="lock" size={15} color={T.textSec} />
              <Text style={{ color: T.textPri, fontSize: 14, fontWeight: '600' }}>Cambiar contraseña</Text>
            </View>
            <Feather name={pwOpen ? 'chevron-up' : 'chevron-down'} size={18} color={T.textMuted} />
          </TouchableOpacity>
          {pwOpen && (
            <View style={{ marginTop: 8, gap: 8 }}>
              <TextInput style={styles.input} placeholder="Contraseña actual" placeholderTextColor={T.textMuted} secureTextEntry value={cur} onChangeText={setCur} />
              <TextInput style={styles.input} placeholder="Nueva contraseña" placeholderTextColor={T.textMuted} secureTextEntry value={nw} onChangeText={setNw} />
              <TextInput style={styles.input} placeholder="Confirmar nueva" placeholderTextColor={T.textMuted} secureTextEntry value={cf} onChangeText={setCf} />
              <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={onChangePw} disabled={pwBusy}>
                {pwBusy ? <ActivityIndicator size="small" color="#fdfbf7" /> : <Text style={styles.btnText}>Actualizar contraseña</Text>}
              </TouchableOpacity>
            </View>
          )}

          {/* Legal */}
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 18, marginTop: 22 }}>
            <TouchableOpacity onPress={() => Linking.openURL('https://faroenergy.lat/terminos.html')}>
              <Text style={{ color: T.textMuted, fontSize: 12 }}>Términos</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL('https://faroenergy.lat/privacidad.html')}>
              <Text style={{ color: T.textMuted, fontSize: 12 }}>Privacidad</Text>
            </TouchableOpacity>
          </View>

          {/* Cerrar sesión */}
          <TouchableOpacity style={[styles.btn, { marginTop: 16, paddingVertical: 11, backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]} onPress={confirmLogout}>
            <Feather name="log-out" size={15} color={T.dangerText} />
            <Text style={[styles.btnText, { color: T.dangerText }]}>Cerrar sesión</Text>
          </TouchableOpacity>
        </ScrollView>
      </KbSheet>
    </View>
  );
}
