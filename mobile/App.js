import { useEffect, useState } from 'react';
import {
  StyleSheet, Text, View, FlatList,
  TouchableOpacity, RefreshControl, StatusBar, Alert,
} from 'react-native';

// Cambia esta IP si tu red cambia (corre: ipconfig getifaddr en0)
const API_URL = 'http://192.168.1.3:8000';

const STATUS_COLOR = {
  Available: '#22c55e',
  Charging:  '#3b82f6',
  Faulted:   '#ef4444',
  Offline:   '#6b7280',
  Preparing: '#f59e0b',
};

const OWNER_LABEL = {
  'dueño_1': 'Carlos M.',
  'dueño_2': 'Andrés P.',
};

export default function App() {
  const [chargers, setChargers]       = useState([]);
  const [refreshing, setRefreshing]   = useState(false); // solo para pull-to-refresh
  const [lastUpdate, setLastUpdate]   = useState(null);
  const [serverOk, setServerOk]       = useState(null);

  const fetchStatus = async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const res  = await fetch(`${API_URL}/status`);
      const data = await res.json();
      const list = Object.entries(data.chargers || {}).map(([id, info]) => ({ id, ...info }));
      // actualiza sin reemplazar — evita el flash visual
      setChargers(prev => {
        const igual = JSON.stringify(prev) === JSON.stringify(list);
        return igual ? prev : list;
      });
      setLastUpdate(new Date().toLocaleTimeString('es-CO'));
      setServerOk(true);
    } catch {
      setServerOk(false);
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  };

  const remoteStart = async (chargerId) => {
    try {
      const res  = await fetch(`${API_URL}/remote-start/${chargerId}`, { method: 'POST' });
      const data = await res.json();
      Alert.alert('Resultado', data.error || `Estado: ${data.status}`);
      fetchStatus();
    } catch {
      Alert.alert('Error', 'No se pudo conectar al servidor');
    }
  };

  const remoteStop = async (chargerId) => {
    try {
      const res  = await fetch(`${API_URL}/remote-stop/${chargerId}`, { method: 'POST' });
      const data = await res.json();
      Alert.alert('Resultado', data.error || `Carga detenida: ${data.status}`);
      fetchStatus();
    } catch {
      Alert.alert('Error', 'No se pudo conectar al servidor');
    }
  };

  useEffect(() => {
    fetchStatus(true);
    const interval = setInterval(() => fetchStatus(false), 5000);
    return () => clearInterval(interval);
  }, []);

  const renderCharger = ({ item }) => {
    const color      = STATUS_COLOR[item.status] || '#6b7280';
    const isCharging = item.status === 'Charging';
    const isOffline  = item.status === 'Offline';

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.chargerId}>{item.id}</Text>
          <View style={styles.ownerBadge}>
            <Text style={styles.ownerText}>{OWNER_LABEL[item.owner] || item.owner || '—'}</Text>
          </View>
        </View>

        <Text style={styles.location}>{item.location || 'Sin ubicación'}</Text>

        <View style={styles.statusRow}>
          <Text style={[styles.statusText, { color }]}>{item.status || 'Desconocido'}</Text>
          {item.active_transaction && (
            <Text style={styles.txText}>TX #{item.active_transaction}</Text>
          )}
        </View>

        {isCharging && item.current_kwh != null && (
          <View style={styles.kwhRow}>
            <Text style={styles.kwhText}>⚡ {item.current_kwh} kWh</Text>
          </View>
        )}

        {!isOffline && (
          <TouchableOpacity
            style={[styles.btn, isCharging ? styles.btnStop : styles.btnStart]}
            onPress={() => isCharging ? remoteStop(item.id) : remoteStart(item.id)}
          >
            <Text style={styles.btnText}>
              {isCharging ? '■  Detener carga' : '▶  Iniciar carga'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const available = chargers.filter(c => c.status === 'Available').length;
  const charging  = chargers.filter(c => c.status === 'Charging').length;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>CPO Colombia</Text>
        <Text style={styles.headerSub}>Medellín · {chargers.length} cargadores</Text>
        <View style={styles.statsRow}>
          <Text style={styles.statGreen}>● {available} disponibles</Text>
          <Text style={styles.statBlue}>● {charging} cargando</Text>
        </View>
        {serverOk === false && (
          <Text style={styles.serverError}>⚠ Sin conexión al servidor</Text>
        )}
        {lastUpdate && (
          <Text style={styles.lastUpdate}>Actualizado: {lastUpdate}</Text>
        )}
      </View>

      <FlatList
        data={chargers}
        keyExtractor={(item) => item.id}
        renderItem={renderCharger}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchStatus(true)} tintColor="#3b82f6" />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔌</Text>
            <Text style={styles.emptyText}>
              {loading ? 'Conectando...' : serverOk === false ? 'Servidor no disponible' : 'Sin cargadores'}
            </Text>
            <Text style={styles.emptyHint}>
              {serverOk === false
                ? `Verifica que el backend corre en ${API_URL}`
                : 'Asegúrate de que el simulador esté activo'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0f172a' },

  header:      { backgroundColor: '#1e3a5f', padding: 20, paddingTop: 60, paddingBottom: 16 },
  headerTitle: { color: '#fff', fontSize: 26, fontWeight: 'bold' },
  headerSub:   { color: '#94a3b8', fontSize: 14, marginTop: 2 },
  statsRow:    { flexDirection: 'row', gap: 16, marginTop: 8 },
  statGreen:   { color: '#22c55e', fontSize: 13, fontWeight: '600' },
  statBlue:    { color: '#3b82f6', fontSize: 13, fontWeight: '600' },
  serverError: { color: '#ef4444', fontSize: 12, marginTop: 6 },
  lastUpdate:  { color: '#475569', fontSize: 11, marginTop: 4 },

  list:        { padding: 16, gap: 12 },

  card:        { backgroundColor: '#1e293b', borderRadius: 14, padding: 16 },
  cardHeader:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  dot:         { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  chargerId:   { color: '#f1f5f9', fontWeight: '700', fontSize: 15, flex: 1 },
  ownerBadge:  { backgroundColor: '#334155', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  ownerText:   { color: '#94a3b8', fontSize: 11 },

  location:    { color: '#64748b', fontSize: 13, marginBottom: 8 },
  statusRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  statusText:  { fontWeight: '700', fontSize: 14 },
  txText:      { color: '#475569', fontSize: 12 },

  kwhRow:      { marginBottom: 10 },
  kwhText:     { color: '#93c5fd', fontSize: 13, fontWeight: '600' },

  btn:         { marginTop: 10, padding: 12, borderRadius: 10, alignItems: 'center' },
  btnStart:    { backgroundColor: '#14532d' },
  btnStop:     { backgroundColor: '#7f1d1d' },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 15 },

  empty:       { alignItems: 'center', paddingTop: 80 },
  emptyIcon:   { fontSize: 48, marginBottom: 16 },
  emptyText:   { color: '#94a3b8', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  emptyHint:   { color: '#475569', fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
});
