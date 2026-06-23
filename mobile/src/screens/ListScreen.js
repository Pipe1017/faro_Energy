import React from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { useApp } from '../context/AppContext';
import { OwnerCard } from '../components/OwnerCard';

// Pantalla "Mis cargadores" (dueño): lista de sus cargadores + botón Agregar.
export function ListScreen() {
  const { myChargers, refreshing, fetchStatus, openNewCharger, serverOk, archivedChargers, restoreCharger, units, setUnitsModal } = useApp();
  return (
    <FlatList
      data={myChargers}
      keyExtractor={item => item.id}
      renderItem={({ item }) => <OwnerCard item={item} />}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchStatus(true)} tintColor={T.green} />}
      ListFooterComponent={(archivedChargers && archivedChargers.length > 0) ? (
        <View style={{ marginTop: 18 }}>
          <Text style={[styles.sectionTitle, { color: T.textMuted }]}>Dados de baja ({archivedChargers.length})</Text>
          {archivedChargers.map(c => (
            <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: T.cardBorder, opacity: 0.85 }}>
              <Feather name="archive" size={15} color={T.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textSec, fontSize: 13, fontWeight: '600' }}>{c.id}</Text>
                <Text style={{ color: T.textMuted, fontSize: 11 }} numberOfLines={1}>{c.location}</Text>
              </View>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.greenFaint, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: T.greenDark }}
                onPress={() => restoreCharger(c)}>
                <Feather name="rotate-ccw" size={12} color={T.green} />
                <Text style={{ color: T.green, fontSize: 12, fontWeight: '700' }}>Reactivar</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      ListHeaderComponent={(
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <Text style={styles.sectionTitle}>Mis cargadores</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 6, borderWidth: 1, borderColor: T.cardBorder }}
              onPress={() => setUnitsModal(true)}>
              <Feather name="home" size={13} color={T.textSec} />
              <Text style={{ color: T.textSec, fontSize: 12, fontWeight: '700' }}>Unidades{units?.length ? ` (${units.length})` : ''}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.greenFaint, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: T.greenDark }}
              onPress={openNewCharger}>
              <Feather name="plus" size={13} color={T.green} />
              <Text style={{ color: T.green, fontSize: 12, fontWeight: '700' }}>Agregar</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Feather name={serverOk === false ? 'wifi-off' : 'zap-off'} size={40} color={T.textMuted} />
          <Text style={[styles.emptyText, { marginTop: 16 }]}>
            {refreshing ? 'Conectando...' : serverOk === false ? 'Sin conexión' : 'Sin cargadores'}
          </Text>
        </View>
      }
    />
  );
}
