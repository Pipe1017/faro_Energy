import React from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { useApp } from '../context/AppContext';
import { OwnerCard } from '../components/OwnerCard';

// Pantalla "Mis cargadores" (dueño): lista de sus cargadores + botón Agregar.
export function ListScreen() {
  const { myChargers, refreshing, fetchStatus, openNewCharger, serverOk } = useApp();
  return (
    <FlatList
      data={myChargers}
      keyExtractor={item => item.id}
      renderItem={({ item }) => <OwnerCard item={item} />}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchStatus(true)} tintColor={T.green} />}
      ListHeaderComponent={(
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <Text style={styles.sectionTitle}>Mis cargadores</Text>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.greenFaint, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: T.greenDark }}
            onPress={openNewCharger}>
            <Feather name="plus" size={13} color={T.green} />
            <Text style={{ color: T.green, fontSize: 12, fontWeight: '700' }}>Agregar</Text>
          </TouchableOpacity>
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
