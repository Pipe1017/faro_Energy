import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Keyboard, Platform } from 'react-native';
import MapView from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import { T, STATUS_COLOR } from '../theme';
import { styles } from '../styles';
import { MEDELLIN } from '../constants';
import { ChargerMarker } from '../components/ChargerMarker';
import { useApp } from '../context/AppContext';

// Pantalla del mapa: MapView + marcadores (faros + externos OCM con culling en Android),
// buscador flotante (lugares + cargadores) y FAB al cargador más cercano.
// Los paneles flotantes (mapPanel / sheet) viven en App como overlays globales.
export function MapScreen() {
  const {
    mapRef, locStatus, inView, chargers, zoom,
    selectedCharger, isOwner, user, tapCharger, mapOverlayOpen, mapSearch, setMapSearch,
    geoResults, setGeoResults, mapSearchResults, setSelectedCharger, setChargerPanel,
    activeSession, goToNearest, locLoading, setMapRegion, setZoom,
  } = useApp();

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={MEDELLIN}
        showsUserLocation={locStatus === 'granted'}
        showsMyLocationButton={false}
        onPress={() => { Keyboard.dismiss(); setSelectedCharger(null); setMapSearch(''); setGeoResults([]); }}
        onRegionChangeComplete={r => {
          setMapRegion(r);
          if (r.latitudeDelta > 0.07) setZoom('far');
          else if (r.latitudeDelta > 0.025) setZoom('mid');
          else setZoom('close');
        }}
      >
        {/* Solo cargadores Faro. Lejos → punto; cerca o seleccionado → burbuja con
            precio (evita la "montonera" al alejar). */}
        {chargers.filter(c => c.lat && c.lng && inView(c.lat, c.lng)).map(c => (
          <ChargerMarker key={c.id} charger={c} zoom={zoom}
            isSelected={selectedCharger?.id === c.id}
            isMine={isOwner && c.owner_id === user?.id}
            onPress={() => tapCharger(c)} />
        ))}
      </MapView>

      {/* ── Buscador flotante estilo maps (oculto si hay panel/modal encima) ── */}
      {!mapOverlayOpen && (
      <View style={styles.mapSearchWrap} pointerEvents="box-none">
        <View style={styles.mapSearchBox}>
          <Feather name="search" size={16} color="#94866f" style={{ marginRight: 8 }} />
          <TextInput
            style={styles.mapSearchInput}
            placeholder="Buscar cargador, ubicación..."
            placeholderTextColor="#94866f"
            value={mapSearch}
            onChangeText={setMapSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {mapSearch.length > 0 && (
            <TouchableOpacity onPress={() => setMapSearch('')} style={{ padding: 4 }}>
              <Feather name="x" size={15} color="#94866f" />
            </TouchableOpacity>
          )}
        </View>

        {/* Dropdown: lugares reales + cargadores */}
        {(geoResults.length > 0 || mapSearchResults.length > 0) && (
          <View style={styles.mapSearchDropdown}>

            {/* Lugares geocodificados */}
            {geoResults.map((r, i) => (
              <TouchableOpacity
                key={`geo-${i}`}
                style={styles.mapSearchItem}
                onPress={() => {
                  Keyboard.dismiss();
                  setMapSearch('');
                  setGeoResults([]);
                  mapRef.current?.animateToRegion({
                    latitude: r.lat, longitude: r.lng,
                    latitudeDelta: 0.02, longitudeDelta: 0.02,
                  }, 500);
                }}
              >
                <Feather name="map-pin" size={14} color="#e74c3c" style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.mapSearchItemId} numberOfLines={1}>{r.name}</Text>
                  <Text style={[styles.mapSearchItemLoc, { color: '#94866f' }]}>{r.type}</Text>
                </View>
              </TouchableOpacity>
            ))}

            {/* Separador si hay ambos tipos */}
            {geoResults.length > 0 && mapSearchResults.length > 0 && (
              <View style={{ height: 1, backgroundColor: '#f0f0f0', marginVertical: 2 }} />
            )}

            {/* Cargadores de la DB */}
            {mapSearchResults.map(c => (
              <TouchableOpacity
                key={c.id}
                style={styles.mapSearchItem}
                onPress={() => {
                  Keyboard.dismiss();
                  setSelectedCharger(c);
                  setChargerPanel(c);
                  setMapSearch('');
                  setGeoResults([]);
                  mapRef.current?.animateToRegion({ latitude: c.lat, longitude: c.lng, latitudeDelta: 0.015, longitudeDelta: 0.015 }, 400);
                }}
              >
                <Feather name="zap" size={14} color={STATUS_COLOR[c.status] || T.offline} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.mapSearchItemId}>{c.id}</Text>
                  <Text style={styles.mapSearchItemLoc} numberOfLines={1}>{c.location}</Text>
                </View>
                <Text style={styles.mapSearchItemPrice}>$ {Math.round((c.price_per_kwh_now ?? c.price_per_kwh ?? 0) * 1.19).toLocaleString('es-CO')}/kWh</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
      )}

      {/* ── FAB: cargador disponible más cercano ── */}
      {/* Si la barra flotante de sesión activa está visible, sube el FAB para que no la tape */}
      {!mapOverlayOpen && (
        <TouchableOpacity
          style={[styles.nearestFab, (activeSession && !isOwner) && { bottom: 172 }]}
          onPress={goToNearest}
          activeOpacity={0.85}
          accessibilityLabel="Cargador más cercano"
        >
          {locLoading
            ? <ActivityIndicator size="small" color="#fdfbf7" />
            : <Feather name="navigation" size={22} color="#fdfbf7" />}
        </TouchableOpacity>
      )}

    </View>
  );
}
