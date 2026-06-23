import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { KbSheet } from '../hooks';
import { useApp } from '../context/AppContext';

// El conductor se une a una unidad con el código que le compartió el dueño.
export function JoinUnitModal() {
  const { joinUnit, setJoinUnitModal } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const onJoin = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const r = await joinUnit(code.trim());
      setJoinUnitModal(false);
      Alert.alert('¡Listo!', `Ya puedes cargar en los cargadores de ${r.unit || 'la unidad'}.`);
    } catch (e) { Alert.alert('Código inválido', e.message); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.modalOverlay}>
      <TouchableOpacity style={{ flex: 1 }} onPress={() => setJoinUnitModal(false)} activeOpacity={1} />
      <KbSheet>
      <View style={styles.modal}>
        <View style={styles.mapPanelHandle} />
        <View style={styles.mapPanelHeader}>
          <View>
            <Text style={styles.modalTitle}>Unirme a una unidad</Text>
            <Text style={styles.mapPanelLocation}>Ingresa el código que te compartió el administrador.</Text>
          </View>
          <TouchableOpacity onPress={() => setJoinUnitModal(false)} style={{ padding: 4 }}>
            <Feather name="x" size={20} color={T.textMuted} />
          </TouchableOpacity>
        </View>
        <TextInput style={[styles.input, { marginTop: 14, letterSpacing: 2, textAlign: 'center', fontSize: 18, fontWeight: '700' }]}
          placeholder="CÓDIGO" placeholderTextColor={T.textMuted} value={code}
          onChangeText={t => setCode(t.toUpperCase())} autoCapitalize="characters" maxLength={6} />
        <TouchableOpacity style={[styles.btn, styles.btnStart, { marginTop: 14 }]} onPress={onJoin} disabled={busy}>
          {busy ? <ActivityIndicator size="small" color="#fdfbf7" /> : <Text style={styles.btnText}>Unirme</Text>}
        </TouchableOpacity>
      </View>
      </KbSheet>
    </View>
  );
}
