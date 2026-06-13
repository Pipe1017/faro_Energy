import React, { useEffect, useState, useCallback, memo, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TextInput,
  TouchableOpacity, RefreshControl, StatusBar, Alert,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  ImageBackground, Linking, Keyboard,
} from 'react-native';
import MapView, { Marker, Callout } from 'react-native-maps';
import * as SecureStore from 'expo-secure-store';
import { Feather } from '@expo/vector-icons';
import Svg, { Path, Rect } from 'react-native-svg';

// ── Design tokens — Cobre y Tierra ──────────────────────────────────────────
// Sobrio, cálido, premium. Sin verdes ni morados eléctricos.
// Paleta "Faro Claro" v3 — fondo claro, contrastes WCAG AA/AAA
// (ver DESIGN_PALETTE.txt; nombres de tokens heredados: green = cobre)
const T = {
  // Fondos — marfil cálido, nunca negro
  bg:         '#faf7f1',
  surface:    '#f3eee4',
  card:       '#ffffff',
  cardBorder: '#e7dfd0',

  // Acción principal — cobre Faro
  green:      '#b45309',   // nombre heredado, es COBRE
  greenDark:  '#8a3e06',
  greenLight: '#e8c49a',
  greenFaint: '#f7ead8',

  // Texto — espresso sobre claro
  textPri:    '#2b2520',
  textSec:    '#6b5d4a',
  textMuted:  '#94866f',

  // Estado Charging — índigo
  charging:   '#4338ca',
  chargingBg: '#eceafb',

  // Alerta / advertencia
  warning:    '#92580c',
  warningText:'#92580c',
  warningBg:  '#fbf0dc',

  danger:     '#b91c1c',
  dangerText: '#b91c1c',
  offline:    '#a8a29e',
  preparing:  '#b45309',

  headerDriver: '#f3eee4',
  headerOwner:  '#f7ead8',
};

const API_URL = 'https://preseason-constable-sappiness.ngrok-free.dev';

const STATUS_COLOR = {
  Available: T.green,      // gold
  Charging:  T.charging,   // púrpura
  Faulted:   '#b91c1c',
  Offline:   T.offline,
  Preparing: T.warningText,
};

const MEDELLIN = { latitude: 6.2100, longitude: -75.5700, latitudeDelta: 0.08, longitudeDelta: 0.08 };

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marcador memoizado — solo se redibuja si cambia status, selección o propiedad
const ChargerMarker = memo(({ charger, isSelected, isMine, onPress, zoom }) => {
  const color   = STATUS_COLOR[charger.status] || T.offline;
  const price   = Math.round((charger.price_per_kwh_now ?? charger.price_per_kwh ?? 0) * 1.10 * 1.19 * 1.03);
  const isCharg = charger.status === 'Charging';

  // Lejos → solo bolita de color (mismo comportamiento que antes)
  if (zoom === 'far' && !isSelected) {
    return (
      <Marker identifier={charger.id}
        coordinate={{ latitude: charger.lat, longitude: charger.lng }}
        onPress={onPress} tracksViewChanges={false} anchor={{ x: 0.5, y: 0.5 }}>
        <View style={[styles.mapPin, { borderColor: isMine ? T.green : color }]}>
          <View style={[styles.mapPinDot, { backgroundColor: color }]} />
          {isMine && <View style={styles.mapPinMark} />}
        </View>
      </Marker>
    );
  }

  // Cerca/seleccionado → burbuja con precio
  const bubbleBg    = isSelected ? '#2b2520' : '#ffffff';
  const priceColor  = isSelected ? '#ffffff' : '#2b2520';
  const specColor   = isSelected ? 'rgba(255,255,255,0.6)' : '#94866f';
  const borderColor = isSelected ? color : 'rgba(0,0,0,0.12)';
  const tipColor    = isSelected ? '#2b2520' : '#ffffff';

  return (
    <Marker identifier={charger.id}
      coordinate={{ latitude: charger.lat, longitude: charger.lng }}
      onPress={onPress} tracksViewChanges={isSelected} anchor={{ x: 0.5, y: 1.0 }}>
      <View style={{ alignItems: 'center' }}>
        <View style={[styles.mapBubble, { backgroundColor: bubbleBg, borderColor,
          borderWidth: isSelected ? 2 : 1,
          transform: [{ scale: isSelected ? 1.08 : 1 }],
        }]}>
          {/* Bolita de estado si está cargando */}
          {isCharg && <View style={[styles.mapBubbleStatusDot, { backgroundColor: color }]} />}
          <Text style={{ color: priceColor, fontWeight: '800', fontSize: 15, letterSpacing: -0.3 }}>
            {price > 0 ? `$${price.toLocaleString('es-CO')}` : charger.status}
          </Text>
          {/* Info extra al acercarse o seleccionar */}
          {(zoom === 'close' || isSelected) && charger.connector_type && (
            <Text style={{ color: specColor, fontSize: 11, marginTop: 1 }}>
              {charger.power_kw}kW · {charger.connector_type}
            </Text>
          )}
        </View>
        {/* Punta triangular que apunta a la ubicación */}
        <View style={[styles.mapBubbleTip, { borderTopColor: tipColor }]} />
      </View>
    </Marker>
  );
}, (prev, next) =>
  prev.charger.status === next.charger.status &&
  prev.charger.price_per_kwh === next.charger.price_per_kwh &&
  prev.charger.price_per_kwh_now === next.charger.price_per_kwh_now &&
  prev.isSelected === next.isSelected &&
  prev.isMine === next.isMine &&
  prev.zoom === next.zoom
);

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Error del servidor (${res.status})`); }
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}

function useKeyboardHeight() {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, e => setKb(e?.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => { s.remove(); h.remove(); };
  }, []);
  return kb;
}

// Hoja inferior que sube EXACTAMENTE la altura del teclado y baja a 0 al
// cerrarse (en Android la ventana ya se redimensiona sola — padding 0)
function KbSheet({ children }) {
  const kb = useKeyboardHeight();
  return (
    <View style={{ width: '100%', paddingBottom: Platform.OS === 'ios' ? kb : 0 }}>
      {children}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Logo Faro — símbolo (mismas formas que landing/public/logo-faro-claro.svg)
// ─────────────────────────────────────────────────────────────────────────────

function FaroLogo({ height = 84, bolt = '#faf7f1' }) {
  const width = height * 48 / 78;
  return (
    <Svg width={width} height={height} viewBox="36 28 48 78">
      <Rect x="52" y="44" width="16" height="14" rx="3" fill="#b45309" />
      <Path d="M50 44 L60 34 L70 44 Z" fill="#2b2520" />
      <Path d="M53 58 L67 58 L72 98 L48 98 Z" fill="#2b2520" />
      <Path d="M62 64 L55 80 L60 80 L57 92 L66 75 L61 75 Z" fill={bolt} />
      <Rect x="42" y="98" width="36" height="5" rx="2.5" fill="#b45309" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Screen
// ─────────────────────────────────────────────────────────────────────────────

function AuthScreen({ onLogin }) {
  const [mode, setMode]       = useState('login');    // 'login' | 'register'
  const [email, setEmail]     = useState('');
  const [name, setName]       = useState('');
  const [password, setPass]   = useState('');
  const [role, setRole]       = useState('conductor');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const submit = async () => {
    setError('');
    if (!email || !password || (mode === 'register' && !name)) {
      setError('Completa todos los campos');
      return;
    }
    setLoading(true);
    try {
      let data;
      if (mode === 'login') {
        data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      } else {
        data = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password, role }) });
      }
      await SecureStore.setItemAsync('token', data.token);
      await SecureStore.setItemAsync('user', JSON.stringify(data.user));
      onLogin(data.token, data.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ImageBackground
      source={require('./assets/images/Login.png')}
      style={styles.authBg}
      resizeMode="cover"
    >
      <StatusBar barStyle="dark-content" />
      <View style={styles.authSpacer} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.authKeyboard}>
        <View style={styles.authCard}>
          <ScrollView contentContainerStyle={styles.authInner} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>

        <View style={{ alignItems: 'center', marginBottom: 10 }}>
          <FaroLogo height={78} />
        </View>
        <Text style={styles.authTitle}>Faro Energy</Text>
        <Text style={styles.authSub}>Red de cargadores eléctricos</Text>

        {/* Tabs login / registro */}
        <View style={styles.authTabs}>
          <TouchableOpacity style={[styles.authTab, mode === 'login' && styles.authTabActive]} onPress={() => { setMode('login'); setError(''); }}>
            <Text style={[styles.authTabText, mode === 'login' && styles.authTabTextActive]}>Ingresar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.authTab, mode === 'register' && styles.authTabActive]} onPress={() => { setMode('register'); setError(''); }}>
            <Text style={[styles.authTabText, mode === 'register' && styles.authTabTextActive]}>Registrarse</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.authForm}>
          {mode === 'register' && (
            <TextInput style={styles.input} placeholder="Nombre completo" placeholderTextColor="#94866f"
              value={name} onChangeText={setName} autoCapitalize="words" />
          )}
          <TextInput style={styles.input} placeholder="Correo electrónico" placeholderTextColor="#94866f"
            value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <TextInput style={styles.input} placeholder="Contraseña" placeholderTextColor="#94866f"
            value={password} onChangeText={setPass} secureTextEntry />

          {mode === 'register' && (
            <View style={styles.roleRow}>
              <Text style={styles.roleLabel}>Soy:</Text>
              <TouchableOpacity style={[styles.roleBtn, role === 'conductor' && styles.roleBtnActive]} onPress={() => setRole('conductor')}>
                <Text style={[styles.roleBtnText, role === 'conductor' && styles.roleBtnTextActive]}>Conductor</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.roleBtn, role === 'owner' && styles.roleBtnActive]} onPress={() => setRole('owner')}>
                <Text style={[styles.roleBtnText, role === 'owner' && styles.roleBtnTextActive]}>Dueño de cargador</Text>
              </TouchableOpacity>
            </View>
          )}

          {error ? <Text style={styles.authError}>{error}</Text> : null}

          <TouchableOpacity style={styles.authSubmit} onPress={submit} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.authSubmitText}>{mode === 'login' ? 'Ingresar' : 'Crear cuenta'}</Text>
            }
          </TouchableOpacity>

          {mode === 'login' && (
            <View style={styles.seedHint}>
              <Text style={styles.seedText}>Cuentas de prueba (clave: 1234):</Text>
              <Text style={styles.seedText}>admin@cpo.com (tú · plataforma)</Text>
              <Text style={styles.seedText}>carlos@cpo.com · juanes@cpo.com (dueños)</Text>
              <Text style={styles.seedText}>conductor1@cpo.com · conductor2@cpo.com</Text>
            </View>
          )}
        </View>
      </ScrollView>
        </View>
      </KeyboardAvoidingView>
      <View style={styles.authBottomSpacer} />
    </ImageBackground>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken]       = useState(null);
  const [user, setUser]         = useState(null);
  const [booting, setBooting]   = useState(true);

  const [chargers, setChargers]     = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const [earnings, setEarnings]         = useState(null);
  const [editingPrice, setEditingPrice] = useState(null);
  const [newPrice, setNewPrice]         = useState('');
  const [activeSession, setActiveSession]   = useState(null);
  const [liveKwh, setLiveKwh]               = useState(0);   // kWh en vivo de MI sesión (de /my-active-session)
  const [elapsed, setElapsed]               = useState(0);
  const [sessionModal, setSessionModal]     = useState(false);
  const [reservations, setReservations]     = useState([]);
  // Pagos
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [payMethodsModal, setPayMethodsModal] = useState(null);
  const [confirmPayModal, setConfirmPayModal] = useState(null); // { method, charger }
  const [addMethodModal, setAddMethodModal]   = useState(null); // 'card' | 'nequi'
  const [debts, setDebts]                     = useState(null); // { blocked, total_cop, debts[] }
  const [debtPayModal, setDebtPayModal]       = useState(null); // deuda a pagar (abre selector de tarjeta)
  const [payingDebt, setPayingDebt]           = useState(false);
  const [paymentPending, setPaymentPending]   = useState(null); // { reference, chargerId }
  const [addDisbModal, setAddDisbModal]       = useState(false);
  const [disbAccount, setDisbAccount]         = useState(null);
  const [balance, setBalance]                 = useState(null);
  const [withdrawing, setWithdrawing]         = useState(false);
  // Formularios
  const [cardForm, setCardForm]   = useState({ number:'', exp:'', cvc:'', holder:'', nickname:'' });
  const [nequiForm, setNequiForm] = useState({ phone:'', holder_name:'', nickname:'' });
  const [savingMethod, setSavingMethod] = useState(false);   // bloquea doble-tap al guardar tarjeta/Nequi
  const [renameModal, setRenameModal]     = useState(null);
  const [adminSummary, setAdminSummary]   = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null); // sesión seleccionada para ver detalle
  const [sessionsShown, setSessionsShown] = useState(5);    // paginación local
  const [myDisburses, setMyDisburses]     = useState(null);
  const [addChargerModal, setAddChargerModal] = useState(false);
  const [chargerForm, setChargerForm]     = useState({
    location: '', lat: '', lng: '', power_kw: '', connector_type: 'Type 2', price_per_kwh: '', cost_per_kwh: '', brand_profile_id: null,
  });
  const [brandProfiles, setBrandProfiles] = useState([]);
  const [statsPeriod, setStatsPeriod]     = useState('week');   // today | week | month
  const [myStats, setMyStats]             = useState(null);
  const [ownerEvents, setOwnerEvents]     = useState(null);
  const [locationPicker, setLocationPicker] = useState(null); // { lat, lng, address }
  const locPickerTimeout                    = useRef(null);
  const [disbForm, setDisbForm]   = useState({ type:'NEQUI', phone:'', account_number:'', bank_code:'', account_type:'SAVINGS', holder_name:'', holder_id:'' });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [serverOk, setServerOk]     = useState(null);
  const [tab, setTab]               = useState('mapa');
  const [search, setSearch]         = useState('');
  const [mapSearch, setMapSearch]   = useState('');
  const [geoResults, setGeoResults] = useState([]);  // resultados de lugares reales
  const [zoom, setZoom]             = useState('mid');
  const mapRef                      = useRef(null);
  const stripRef                    = useRef(null);
  const geoTimeout                  = useRef(null);
  const [selectedCharger, setSelectedCharger] = useState(null); // para mapa (pin highlight)
  const [chargerPanel, setChargerPanel] = useState(null);       // panel de acciones (lista + mapa)
  const [qrModal, setQrModal]       = useState(null);
  const [qrScanning, setQrScanning] = useState(false);
  const [myUsage, setMyUsage]       = useState(null);

  // Restore session
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('token');
        const savedUser  = await SecureStore.getItemAsync('user');
        if (savedToken && savedUser) {
          // Validate token is still good
          const me = await apiFetch('/auth/me', {}, savedToken);
          setToken(savedToken);
          setUser(me);
        }
      } catch {
        await SecureStore.deleteItemAsync('token');
        await SecureStore.deleteItemAsync('user');
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const handleLogin = useCallback((t, u) => {
    setToken(t);
    setUser(u);
  }, []);

  const handleLogout = async () => {
    await SecureStore.deleteItemAsync('token');
    await SecureStore.deleteItemAsync('user');
    setToken(null);
    setUser(null);
    setChargers([]);
    // Limpiar TODO el estado del usuario anterior — si no, al entrar otro
    // usuario hereda la sesión/datos del anterior (p.ej. ver/detener su carga)
    setActiveSession(null);
    setSessionModal(false);
    setPaymentPending(null);
    setPaymentMethods([]);
    setBalance(null);
    setMyUsage(null);
    setEarnings(null);
    setMyStats(null);
    setOwnerEvents(null);
    setDisbAccount(null);
    setMyDisburses(null);
    setReservations([]);
    setTab('mapa');
  };

  const fetchStatus = async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const data = await apiFetch('/status', {}, token);
      // Orden FIJO por id: el backend no garantiza orden y, al reemplazar la
      // lista cada 5s, los items saltaban de posición (brinco en lista y mapa)
      const list = Object.entries(data.chargers || {})
        .map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => a.id.localeCompare(b.id));
      setChargers(prev => JSON.stringify(prev) === JSON.stringify(list) ? prev : list);
      setLastUpdate(new Date().toLocaleTimeString('es-CO'));
      setServerOk(true);
    } catch {
      setServerOk(false);
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    fetchStatus(true);
    const interval = setInterval(() => fetchStatus(false), 5000);
    return () => clearInterval(interval);
  }, [token]);

  // Al (re)autenticar: la barra de sesión es del usuario ACTUAL y de nadie
  // más. Descartamos cualquier sesión en memoria y reconstruimos solo la
  // carga propia que el backend confirme — fuente de verdad: /my-active-session
  useEffect(() => {
    if (!token) return;
    setActiveSession(null);
    (async () => {
      try {
        const r = await apiFetch('/my-active-session', {}, token);
        if (r.active && r.charger) {
          setActiveSession({
            chargerId: r.charger.id,
            startTime: r.started_at ? new Date(r.started_at).getTime() : Date.now(),
            charger: r.charger,
          });
        }
      } catch {}
    })();
  }, [token]);

  // Timer de sesión activa — actualiza cada segundo
  useEffect(() => {
    if (!activeSession) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed(Date.now() - activeSession.startTime), 1000);
    return () => clearInterval(t);
  }, [activeSession]);

  // Geocodificación inversa: coordenadas → dirección legible
  const reverseGeocode = async (lat, lng) => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`,
        { headers: { 'User-Agent': 'CPO-Colombia-App/1.0' } }
      );
      const data = await res.json();
      const addr = data.address || {};
      const label = [
        addr.road || addr.pedestrian,
        addr.suburb || addr.neighbourhood || addr.quarter,
        addr.city || addr.town || addr.municipality,
      ].filter(Boolean).join(', ');
      setLocationPicker(p => p ? { ...p, address: label || data.display_name?.split(',').slice(0,2).join(',') } : p);
    } catch {}
  };

  // Geocodificación con Nominatim (OpenStreetMap) — gratis, sin API key
  const geocode = async (query) => {
    if (query.trim().length < 2) { setGeoResults([]); return; }
    try {
      const q   = encodeURIComponent(`${query.trim()}, Medellín, Colombia`);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=4&countrycodes=co&addressdetails=0`,
        { headers: { 'User-Agent': 'CPO-Colombia-App/1.0', 'Accept-Language': 'es' } }
      );
      const data = await res.json();
      setGeoResults(data.map(r => ({
        name: r.display_name.split(',').slice(0, 2).join(',').trim(),
        lat:  parseFloat(r.lat),
        lng:  parseFloat(r.lon),
        type: r.type,
      })));
    } catch { setGeoResults([]); }
  };

  // Debounce: espera 450ms después de que el usuario deje de escribir
  useEffect(() => {
    if (geoTimeout.current) clearTimeout(geoTimeout.current);
    if (mapSearch.trim().length >= 2) {
      geoTimeout.current = setTimeout(() => geocode(mapSearch), 450);
    } else {
      setGeoResults([]);
    }
    return () => clearTimeout(geoTimeout.current);
  }, [mapSearch]);

  // Auto-scroll tira de cargadores al cargador seleccionado
  useEffect(() => {
    if (!selectedCharger || !stripRef.current) return;
    const idx = filteredChargers.filter(c => c.lat && c.lng).findIndex(c => c.id === selectedCharger.id);
    if (idx >= 0) {
      try { stripRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 }); }
      catch {}
    }
  }, [selectedCharger]);

  // Mientras hay sesión activa: polling de /my-active-session — fuente PROPIA
  // del kWh en vivo y del fin de carga. /status ya no expone datos de sesión
  // (privacidad), así que la sesión del conductor se sigue solo por aquí.
  const lastKwhRef      = useRef(0);
  const seenChargingRef = useRef(false);
  useEffect(() => {
    if (!activeSession || !token) {
      lastKwhRef.current = 0; seenChargingRef.current = false; setLiveKwh(0);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const r = await apiFetch('/my-active-session', {}, token);
        if (!alive) return;
        if (r.active && r.charger) {
          const kwh = r.charger.current_kwh ?? 0;
          if (kwh > 0) { lastKwhRef.current = kwh; seenChargingRef.current = true; }
          setLiveKwh(kwh);
          return;
        }
        // El backend ya no tiene carga mía. Margen de arranque (RemoteStart tarda)
        if (Date.now() - activeSession.startTime < 20000) return;
        if (seenChargingRef.current) {
          // Vimos la carga en curso y terminó → resumen
          const kwh   = lastKwhRef.current;
          const ch    = activeSession.charger || {};
          const price = (ch.price_per_kwh_now ?? ch.price_per_kwh ?? 0) * 1.10 * 1.19 * 1.03;
          const cost  = Math.round(kwh * price);
          setActiveSession(null); setSessionModal(false); fetchMyUsage();
          Alert.alert(
            'Carga finalizada',
            `El cargador terminó la sesión.\n\nEnergía:  ${kwh.toFixed(3)} kWh\nCobrado:  $ ${cost.toLocaleString('es-CO')} COP\n\nEl detalle exacto queda en "Mi uso".`,
            [{ text: 'Ver mi historial', onPress: () => setTab('miuso') }, { text: 'Cerrar' }]
          );
        } else {
          // Barra colgada (estado viejo / sin carga real) → quitar en silencio
          setActiveSession(null); setSessionModal(false);
        }
      } catch {}
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [activeSession, token]);

  const fetchEarnings = async () => {
    try { setEarnings(await apiFetch('/my-earnings', {}, token)); } catch {}
  };

  const fetchMyUsage = async () => {
    try { setMyUsage(await apiFetch('/my-sessions', {}, token)); } catch {}
    try { setDebts(await apiFetch('/my-debts', {}, token)); } catch {}
  };

  // Pagar una deuda con el método elegido y desbloquear al conductor
  const payDebt = async (method) => {
    if (payingDebt || !debtPayModal) return;
    setPayingDebt(true);
    try {
      const r = await apiFetch('/my-debts/pay', {
        method: 'POST',
        body: JSON.stringify({ payment_id: debtPayModal.payment_id, payment_method_id: method.id }),
      }, token);
      setDebtPayModal(null);
      if (r.status === 'CAPTURED') {
        Alert.alert('Deuda pagada', `Se cobraron $ ${r.amount_cop.toLocaleString('es-CO')} COP. Ya puedes volver a cargar.`);
      } else {
        Alert.alert('Cobro en proceso', 'Estamos confirmando el pago con tu banco. En unos segundos quedará resuelto.');
      }
      fetchMyUsage();
    } catch (e) { Alert.alert('No se pudo pagar', e.message); }
    finally { setPayingDebt(false); }
  };

  const fetchPaymentMethods = async () => {
    try {
      const d = await apiFetch('/payment-methods', {}, token);
      setPaymentMethods(d.methods || []);
    } catch {}
  };

  const fetchDisbAccount = async () => {
    try { setDisbAccount(await apiFetch('/disbursement-account', {}, token)); } catch {}
  };

  useEffect(() => {
    if (!token) return;
    if (tab === 'negocio') {
      fetchEarnings(); fetchDisbAccount();
      apiFetch('/my-disbursements', {}, token).then(setMyDisburses).catch(() => {});
      apiFetch('/my-balance', {}, token).then(setBalance).catch(() => {});
      apiFetch('/brand-profiles', {}, token).then(d => setBrandProfiles(d.profiles || [])).catch(() => {});
      apiFetch('/my-events', {}, token).then(setOwnerEvents).catch(() => {});
    }
    if (tab === 'miuso')   { fetchMyUsage(); fetchPaymentMethods(); }
    if (tab === 'admin')   { apiFetch('/admin/summary', {}, token).then(setAdminSummary).catch(() => {}); }
    if (!isOwner && token) fetchPaymentMethods();
  }, [tab, token]);

  // Rendimiento del dueño — recargar al cambiar el período
  useEffect(() => {
    if (!token || tab !== 'negocio') return;
    apiFetch(`/my-stats?period=${statsPeriod}`, {}, token).then(setMyStats).catch(() => {});
  }, [tab, token, statsPeriod]);

  // Mover mapa cuando cambia la búsqueda — DEBE estar antes de cualquier return condicional
  useEffect(() => {
    if (!mapRef.current || tab !== 'mapa') return;
    const coords = filteredChargers.filter(c => c.lat && c.lng).map(c => ({
      latitude: c.lat, longitude: c.lng,
    }));
    if (coords.length === 0) return;
    if (coords.length === 1) {
      mapRef.current.animateToRegion({
        latitude: coords[0].latitude, longitude: coords[0].longitude,
        latitudeDelta: 0.01, longitudeDelta: 0.01,
      }, 500);
    } else {
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 80, right: 40, bottom: 200, left: 40 },
        animated: true,
      });
    }
  }, [search, tab]);

  const simulateQrScan = (charger) => {
    if (activeSession) {
      Alert.alert(
        'Sesión activa',
        `Ya tienes una carga en curso en ${activeSession.chargerId}. Deténela antes de iniciar otra.`,
        [{ text: 'Ver sesión', onPress: () => setSessionModal(true) }, { text: 'Cerrar' }]
      );
      return;
    }
    setQrModal(charger);
    setQrScanning(true);
    setTimeout(() => setQrScanning(false), 2000);
  };

  // Abre el modal de selección de método de pago
  const remoteStart = (charger) => {
    if (activeSession) {
      Alert.alert('Sesión activa', `Ya tienes una carga en ${activeSession.chargerId}.`, [
        { text: 'Ver sesión', onPress: () => setSessionModal(true) }, { text: 'Cerrar' }
      ]);
      return;
    }
    setPayMethodsModal(charger);
    setSelectedCharger(null);
  };

  // Añadir tarjeta nueva
  const addCard = async () => {
    if (savingMethod) return;            // ignora taps repetidos mientras procesa
    setSavingMethod(true);
    try {
      const clean = (cardForm.exp || '').replace(/\s/g, '');
      const parts = clean.includes('/') ? clean.split('/') : [clean.slice(0,2), clean.slice(2,4)];
      const exp_month = (parts[0] || '').trim();
      const exp_year  = (parts[1] || '').trim();
      if (!exp_month || !exp_year || !cardForm.number || !cardForm.cvc || !cardForm.holder) {
        Alert.alert('Completa todos los campos'); return;
      }
      // PCI: tokenizar DIRECTO contra Wompi con la llave pública —
      // el número y el CVC nunca pasan por nuestro servidor
      const cfg = await apiFetch('/config/public', {}, token);
      const tkRes = await fetch(`${cfg.wompi_api}/tokens/cards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.wompi_public_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: cardForm.number.replace(/\s/g, ''),
          cvc: cardForm.cvc,
          exp_month, exp_year,
          card_holder: cardForm.holder,
        }),
      });
      const tk = await tkRes.json();
      if (tk.status !== 'CREATED' || !tk.data?.id) {
        Alert.alert('Tarjeta rechazada', tk.error?.reason || 'Verifica los datos e intenta de nuevo.'); return;
      }
      const data = await apiFetch('/payment-methods/card', {
        method: 'POST',
        body: JSON.stringify({ token: tk.data.id, brand: tk.data.brand, last4: tk.data.last_four, nickname: cardForm.nickname || null }),
      }, token);
      setPaymentMethods(prev => [...prev, data]);
      setAddMethodModal(null);
      setCardForm({ number:'', exp:'', cvc:'', holder:'', nickname:'' });
      Alert.alert('Tarjeta agregada', data.nickname || data.display);
    } catch (e) { Alert.alert('Error', e.message); }
    finally { setSavingMethod(false); }
  };

  // Añadir Nequi
  const addNequi = async () => {
    if (savingMethod) return;
    setSavingMethod(true);
    try {
      const data = await apiFetch('/payment-methods/nequi', {
        method: 'POST',
        body: JSON.stringify({ ...nequiForm, nickname: nequiForm.nickname || null }),
      }, token);
      setPaymentMethods(prev => [...prev, data]);
      setAddMethodModal(null);
      setNequiForm({ phone:'', holder_name:'', nickname:'' });
    } catch (e) { Alert.alert('Error', e.message); }
    finally { setSavingMethod(false); }
  };

  // Renombrar método de pago
  const renameMethod = async () => {
    if (!renameModal) return;
    try {
      const data = await apiFetch(`/payment-methods/${renameModal.method.id}/nickname`, {
        method: 'PATCH',
        body: JSON.stringify({ nickname: renameModal.value }),
      }, token);
      setPaymentMethods(prev => prev.map(m => m.id === data.id ? data : m));
      setRenameModal(null);
    } catch (e) { Alert.alert('Error', e.message); }
  };

  // Pagar con método seleccionado
  const payWithMethod = async (method, charger) => {
    setPayMethodsModal(null);
    try {
      // Monto de garantía: $5.000 COP (se ajusta al final de la sesión)
      const data = await apiFetch('/payments/initiate', {
        method: 'POST',
        body: JSON.stringify({ charger_id: charger.id, payment_method_id: method.id }),
      }, token);
      if (data.error) { Alert.alert('Error', data.error); return; }
      if (data.status === 'APPROVED') {
        setActiveSession({ chargerId: charger.id, startTime: Date.now(), charger });
        setSessionModal(true);
      } else if (data.status === 'PENDING') {
        setPaymentPending({ reference: data.reference, chargerId: charger.id, charger, methodType: method.type });
      } else {
        Alert.alert('Pago rechazado', 'Verifica los datos de tu tarjeta e intenta de nuevo.');
      }
      fetchStatus();
    } catch (e) { Alert.alert('Error', e.message); }
  };

  // Polling para pagos Nequi pendientes
  useEffect(() => {
    if (!paymentPending || !token) return;
    const interval = setInterval(async () => {
      try {
        const d = await apiFetch(`/payments/status/${paymentPending.reference}`, {}, token);
        if (d.status === 'APPROVED') {
          clearInterval(interval);
          setPaymentPending(null);
          setActiveSession({ chargerId: paymentPending.chargerId, startTime: Date.now(), charger: paymentPending.charger });
          setSessionModal(true);
          fetchStatus();
        } else if (d.status === 'DECLINED' || d.status === 'ERROR' || d.status === 'VOIDED') {
          clearInterval(interval);
          setPaymentPending(null);
          Alert.alert('Pago rechazado', 'El banco rechazó el cobro. Verifica los datos de tu método de pago.');
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [paymentPending, token]);

  // Guardar cuenta de dispersión del dueño
  const saveDisbAccount = async () => {
    try {
      const data = await apiFetch('/disbursement-account', { method: 'POST', body: JSON.stringify(disbForm) }, token);
      setDisbAccount(data);
      setAddDisbModal(false);
      Alert.alert(
        'Cuenta guardada',
        'Ahora verifica la cuenta para confirmar que los pagos llegarán correctamente. Te enviaremos $500 COP de prueba.',
        [
          { text: 'Verificar ahora', onPress: verifyDisbAccount },
          { text: 'Después' },
        ]
      );
    } catch (e) { Alert.alert('Error al guardar', e.message); }
  };

  // Retirar saldo acumulado a la cuenta del dueño
  const withdrawBalance = async () => {
    if (withdrawing) return;
    setWithdrawing(true);
    try {
      const data = await apiFetch('/my-balance/withdraw', { method: 'POST' }, token);
      const msg = data.status === 'PENDING_ACTIVATION'
        ? `$ ${data.amount_cop.toLocaleString('es-CO')} COP quedaron en cola.\n\nWompi aún no tiene activadas las dispersiones en esta cuenta — el giro saldrá automáticamente cuando se activen.`
        : `$ ${data.amount_cop.toLocaleString('es-CO')} COP van en camino a tu cuenta.`;
      Alert.alert('Retiro en proceso', msg);
      apiFetch('/my-balance', {}, token).then(setBalance).catch(() => {});
      apiFetch('/my-disbursements', {}, token).then(setMyDisburses).catch(() => {});
    } catch (e) { Alert.alert('No se pudo retirar', e.message); }
    finally { setWithdrawing(false); }
  };

  const verifyDisbAccount = async () => {
    try {
      const data = await apiFetch('/disbursement-account/verify', { method: 'POST' }, token);
      setDisbAccount(data);
      Alert.alert('¡Cuenta verificada!', data.message || 'Los pagos llegarán automáticamente al terminar cada sesión.');
    } catch (e) { Alert.alert('Verificación fallida', e.message); }
  };

  // ── Gestión de cargadores (dueño) ──────────────────────────────────────────

  const addCharger = async () => {
    const { location, lat, lng, power_kw, connector_type, price_per_kwh, cost_per_kwh, brand_profile_id } = chargerForm;
    if (!location.trim() || !lat || !lng || !power_kw || !price_per_kwh) {
      Alert.alert('Campos incompletos', 'Completa ubicación, coordenadas, potencia y precio.'); return;
    }
    try {
      const data = await apiFetch('/chargers', {
        method: 'POST',
        body: JSON.stringify({
          location: location.trim(),
          lat: parseFloat(lat), lng: parseFloat(lng),
          power_kw: parseFloat(power_kw),
          connector_type,
          price_per_kwh: parseFloat(price_per_kwh),
          cost_per_kwh: parseFloat(cost_per_kwh) || 0,
          brand_profile_id,
        }),
      }, token);
      setAddChargerModal(false);
      setChargerForm({ location: '', lat: '', lng: '', power_kw: '', connector_type: 'Type 2', price_per_kwh: '', cost_per_kwh: '', brand_profile_id: null });
      fetchStatus();
      Alert.alert(
        '¡Cargador registrado!',
        `Tu ID asignado:\n${data.id}\n\nConfigura tu equipo con esta URL OCPP:\n${data.ocpp_url}\n\n(El simulador ya quedó corriendo para que pruebes el flujo completo desde ya.)`,
        [{ text: 'Entendido' }]
      );
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const deleteCharger = (c) => {
    Alert.alert(
      'Eliminar cargador',
      `¿Seguro que quieres eliminar ${c.id}?\n${c.location}\n\nEsta acción no se puede deshacer.`,
      [
        { text: 'Eliminar', style: 'destructive', onPress: async () => {
          try {
            await apiFetch(`/chargers/${c.id}`, { method: 'DELETE' }, token);
            fetchStatus();
            Alert.alert('Eliminado', `${c.id} fue eliminado correctamente.`);
          } catch (e) { Alert.alert('Error', e.message); }
        }},
        { text: 'Cancelar' },
      ]
    );
  };

  const toggleSim = async (c) => {
    const running = simRunning.includes(c.id);
    try {
      await apiFetch(`/simulators/${c.id}`, { method: running ? 'DELETE' : 'POST' }, token);
      const d = await apiFetch('/simulators', {}, token);
      setSimRunning(d.running || []);
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const togglePause = async (c) => {
    const pausing = c.status === 'Available' || c.status === 'Preparing';
    try {
      await apiFetch(`/chargers/${c.id}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ pause: pausing }),
      }, token);
      fetchStatus();
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const doReserve = async (charger) => {
    try {
      const data = await apiFetch(`/reserve/${charger.id}`, { method: 'POST', body: JSON.stringify({ minutes: 60 }) }, token);
      setReservations(prev => [...prev, data]);
      Alert.alert('Reserva confirmada', `${charger.location}\nVálida por 60 minutos`);
      fetchStatus();
      setSelectedCharger(null);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  const cancelReservation = async (reservationId) => {
    try {
      await apiFetch(`/reserve/${reservationId}`, { method: 'DELETE' }, token);
      setReservations(prev => prev.filter(r => r.id !== reservationId));
      fetchStatus();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  const remoteStop = async (chargerId) => {
    try {
      const data = await apiFetch(`/remote-stop/${chargerId}`, { method: 'POST' }, token);
      if (data.error && !data.manual) { Alert.alert('Error', data.error); return; }

      const finalKwh  = sessionKwh;
      const finalCost = sessionCost;
      const finalTime = formatElapsed(elapsed);

      setActiveSession(null);
      setSessionModal(false);
      fetchStatus();
      fetchMyUsage();

      setTimeout(() => {
        Alert.alert(
          'Carga completada',
          `Energía:   ${finalKwh.toFixed(3)} kWh\nTiempo:    ${finalTime}\nCobrado:   $ ${finalCost.toLocaleString('es-CO')} COP\n\nGracias por usar Faro Energy`,
          [{ text: 'Ver mi historial', onPress: () => setTab('miuso') }, { text: 'Cerrar' }]
        );
      }, 600);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  if (booting) {
    return (
      <View style={styles.bootScreen}>
        <Feather name="zap" size={48} color={T.green} />
        <ActivityIndicator color={T.green} size="large" style={{ marginTop: 24 }} />
      </View>
    );
  }

  if (!token) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  const available   = chargers.filter(c => c.status === 'Available').length;
  const charging    = chargers.filter(c => c.status === 'Charging').length;
  const offline     = chargers.filter(c => c.status === 'Offline').length;
  const isOwner     = user?.role === 'owner';
  const isAdmin     = user?.role === 'admin';

  const filteredChargers = search.trim()
    ? chargers.filter(c =>
        c.id.toLowerCase().includes(search.toLowerCase()) ||
        (c.location || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.connector_type || '').toLowerCase().includes(search.toLowerCase())
      )
    : chargers;

  const mapSearchResults = mapSearch.trim().length > 1
    ? chargers.filter(c =>
        c.id.toLowerCase().includes(mapSearch.toLowerCase()) ||
        (c.location || '').toLowerCase().includes(mapSearch.toLowerCase()) ||
        (c.connector_type || '').toLowerCase().includes(mapSearch.toLowerCase())
      ).slice(0, 5)
    : [];


  // Datos de sesión activa para mini-barra y modal
  const liveCharger  = activeSession ? (chargers.find(c => c.id === activeSession.chargerId) || activeSession.charger) : null;
  const sessionKwh   = liveKwh;   // kWh propio en vivo (de /my-active-session)
  const sessionPrice = (liveCharger?.price_per_kwh_now ?? liveCharger?.price_per_kwh) ? (liveCharger.price_per_kwh_now ?? liveCharger.price_per_kwh) * 1.10 * 1.19 * 1.03 : 0;
  const sessionCost  = Math.round(sessionKwh * sessionPrice);


  const savePrice = async (chargerId) => {
    const price = parseFloat(newPrice.replace(/\./g, '').replace(',', '.'));
    if (!price || price <= 0) { Alert.alert('Error', 'Ingresa un precio válido'); return; }
    try {
      await apiFetch(`/chargers/${chargerId}/price`, {
        method: 'PATCH',
        body: JSON.stringify({ price_per_kwh: price }),
      }, token);
      setEditingPrice(null);
      setNewPrice('');
      fetchStatus();
      Alert.alert('Listo', `Precio actualizado a $${price.toLocaleString('es-CO')}/kWh`);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  // ── Tarjeta para CONDUCTOR ────────────────────────────────────────────────
  const renderDriverCard = ({ item }) => {
    const color      = STATUS_COLOR[item.status] || T.offline;
    const isCharging = item.status === 'Charging';
    const isOffline  = item.status === 'Offline';
    // precio_base × 1.10 (CPO) × 1.19 (IVA) × 1.03 (pasarela)
  const priceUser  = (item.price_per_kwh_now ?? item.price_per_kwh) ? Math.round((item.price_per_kwh_now ?? item.price_per_kwh) * 1.10 * 1.19 * 1.03) : null;

    return (
      <TouchableOpacity
        style={[styles.card, !isOffline && { borderColor: T.cardBorder }]}
        onPress={() => !isOffline && setChargerPanel(item)}
        activeOpacity={isOffline ? 1 : 0.7}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.chargerId}>{item.id}</Text>
          {item.owner && <View style={styles.ownerBadge}><Text style={styles.ownerText}>{item.owner}</Text></View>}
          {!isOffline && <Feather name="chevron-right" size={16} color={T.textMuted} />}
        </View>
        <Text style={styles.location}>{item.location || 'Sin ubicación'}</Text>
        <View style={styles.specsRow}>
          {item.power_kw       && <View style={styles.specChip}><Text style={styles.specText}>{item.power_kw} kW</Text></View>}
          {item.connector_type && <View style={styles.specChip}><Text style={styles.specText}>{item.connector_type}</Text></View>}
          {priceUser           && <View style={[styles.specChip, styles.specChipPrice]}><Text style={[styles.specText, styles.specTextPrice]}>$ {priceUser.toLocaleString('es-CO')}/kWh</Text></View>}
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusText, { color }]}>{item.status}</Text>
          {item.active_transaction && <Text style={styles.txText}>TX #{item.active_transaction}</Text>}
        </View>
        {isCharging && item.current_kwh != null && (
          <View style={styles.sessionBox}>
            <View style={styles.sessionRow}>
              <Text style={styles.sessionLabel}>En uso ahora</Text>
              <Text style={styles.sessionValue}>{item.current_kwh} kWh</Text>
            </View>
          </View>
        )}
        {!isOffline && (
          <Text style={styles.listHint}>
            {isCharging ? 'Toca para ver detalles' : 'Toca para reservar o iniciar carga'}
          </Text>
        )}
      </TouchableOpacity>
    );
  };

  // ── Tarjeta para DUEÑO ────────────────────────────────────────────────────
  const renderOwnerCard = ({ item }) => {
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

        {/* Editor de precio */}
        {isEditing ? (
          <View style={styles.priceEditor}>
            <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
              keyboardType="numeric" placeholder="Ej: 1100" placeholderTextColor="#94866f" autoFocus />
            <Text style={styles.priceUnit}>COP/kWh</Text>
            <TouchableOpacity style={styles.priceSave} onPress={() => savePrice(item.id)}>
              <Feather name="check" size={18} color="#fdfbf7" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
              <Text style={styles.priceCancelText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.priceRow} onPress={() => { setEditingPrice(item.id); setNewPrice(String(item.price_per_kwh || '')); }}>
            <View>
              <Text style={styles.priceValue}>$ {(item.price_per_kwh || 0).toLocaleString('es-CO')} / kWh</Text>
              <Text style={styles.priceUserNote}>Conductor paga: $ {Math.round((item.price_per_kwh || 0) * 1.1).toLocaleString('es-CO')} / kWh (+10% CPO)</Text>
            </View>
            <Text style={styles.priceEdit}>Editar</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const myChargers = chargers.filter(c => c.owner_id === user?.id);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      <View style={[styles.header, isOwner ? styles.headerOwner : styles.headerDriver]}>
        {/* Título + avatar */}
        <View style={styles.headerTop}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <FaroLogo height={34} bolt={isOwner ? T.headerOwner : T.headerDriver} />
            <View>
              <Text style={styles.headerTitle}>
                Faro <Text style={{ color: T.green }}>Energy</Text>
              </Text>
              <Text style={{ color: T.textSec, fontSize: 9, fontWeight: '700', letterSpacing: 2.2, marginTop: 1 }}>
                CARGA INTELIGENTE
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={[styles.userBadge, isOwner && styles.userBadgeOwner]}
            onPress={() => Alert.alert(user.name, `${user.email}`, [
              { text: 'Cerrar sesión', style: 'destructive', onPress: handleLogout },
              { text: 'Cancelar' }
            ])}>
            <Text style={styles.userInitial}>{user?.name?.[0]?.toUpperCase()}</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statPill}>
            <View style={[styles.statDot, { backgroundColor: T.green }]} />
            <Text style={styles.statText}>{available} disponibles</Text>
          </View>
          <View style={styles.statPill}>
            <View style={[styles.statDot, { backgroundColor: T.charging }]} />
            <Text style={styles.statText}>{charging} cargando</Text>
          </View>
          <View style={styles.statPill}>
            <View style={[styles.statDot, { backgroundColor: T.offline }]} />
            <Text style={styles.statText}>{offline} offline</Text>
          </View>
        </View>

      </View>

      {tab === 'miuso' && !isOwner ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
          {debts?.blocked && (
            <View style={{ backgroundColor: '#fbe7e7', borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: '#b91c1c' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Feather name="alert-circle" size={18} color={T.dangerText} />
                <Text style={{ color: T.dangerText, fontWeight: '800', fontSize: 15 }}>Cobro pendiente</Text>
              </View>
              <Text style={{ color: '#b91c1c', fontSize: 13, lineHeight: 20, marginBottom: 4 }}>
                Una carga anterior no se pudo cobrar (tu tarjeta fue rechazada). Págala para volver a cargar.
              </Text>
              {debts.debts.map(d => (
                <View key={d.payment_id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, padding: 10, marginTop: 8, borderWidth: 1, borderColor: '#f0c4c4' }}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '700' }}>{d.charger_id}</Text>
                    {d.location ? <Text style={{ color: T.textMuted, fontSize: 11 }} numberOfLines={1}>{d.location}</Text> : null}
                  </View>
                  <TouchableOpacity
                    style={{ backgroundColor: '#b91c1c', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
                    onPress={() => {
                      if (paymentMethods.length === 0) { Alert.alert('Sin tarjeta', 'Agrega una tarjeta primero para pagar la deuda.'); return; }
                      setDebtPayModal(d);
                    }}
                  >
                    <Text style={{ color: '#fdfbf7', fontSize: 13, fontWeight: '700' }}>Pagar $ {d.amount_cop.toLocaleString('es-CO')}</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {myUsage ? (
            <>
              <View style={styles.earningsCard}>
                <Text style={styles.earningsTitle}>Mi consumo total</Text>
                <Text style={styles.earningsAmount}>$ {(myUsage.total_paid_cop || 0).toLocaleString('es-CO')} COP</Text>
                <View style={styles.earningsRow}>
                  <View style={styles.earningsStat}>
                    <Text style={styles.earningsStatVal}>{myUsage.total_sessions}</Text>
                    <Text style={styles.earningsStatLbl}>Sesiones</Text>
                  </View>
                  <View style={styles.earningsStat}>
                    <Text style={styles.earningsStatVal}>{myUsage.total_kwh} kWh</Text>
                    <Text style={styles.earningsStatLbl}>Cargados</Text>
                  </View>
                </View>
              </View>

              {reservations.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>Reservas activas</Text>
                  {reservations.map(r => (
                    <View key={r.id} style={[styles.card, { borderColor: T.green, borderWidth: 1 }]}>
                      <View style={styles.cardHeader}>
                        <Feather name="clock" size={14} color={T.green} style={{ marginRight: 8 }} />
                        <Text style={styles.chargerId}>{r.charger_id}</Text>
                        <TouchableOpacity onPress={() => cancelReservation(r.id)}>
                          <Text style={{ color: T.dangerText, fontSize: 12 }}>Cancelar</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.location}>{r.location}</Text>
                      <Text style={styles.sessionValue}>Hasta: {new Date(r.end_time).toLocaleTimeString('es-CO')}</Text>
                    </View>
                  ))}
                </>
              )}

              {myUsage.sessions?.length > 0 && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
                    <Text style={styles.sectionTitle}>Historial de cargas</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>{myUsage.sessions.length} sesiones</Text>
                  </View>

                  {/* Filas compactas */}
                  <View style={{ borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: T.cardBorder }}>
                    {myUsage.sessions.slice(0, sessionsShown).map((s, i) => {
                      const ps = s.payment_status;
                      const payIcon = ps === 'CAPTURED' ? 'check-circle' : ps === 'UNPAID' ? 'x-circle' : ps === 'PENDING' || ps === 'APPROVED' ? 'clock' : 'minus-circle';
                      const payColor = ps === 'CAPTURED' ? T.green : ps === 'UNPAID' ? T.dangerText : ps === 'PENDING' || ps === 'APPROVED' ? T.warningText : T.textMuted;
                      return (
                      <TouchableOpacity
                        key={s.id}
                        onPress={() => setSessionDetail(s)}
                        style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10,
                          backgroundColor: ps === 'UNPAID' ? '#fbe7e7' : i % 2 === 0 ? T.card : T.surface,
                          borderBottomWidth: i < Math.min(sessionsShown, myUsage.sessions.length) - 1 ? 1 : 0,
                          borderBottomColor: T.cardBorder }}
                      >
                        <Feather name={payIcon} size={16} color={payColor} />
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 13 }}>{s.charger_id}</Text>
                            <Text style={{ color: T.textMuted, fontSize: 11 }}>· {s.kwh_delivered} kWh</Text>
                          </View>
                          <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }} numberOfLines={1}>{s.location}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: ps === 'UNPAID' ? T.dangerText : T.green, fontWeight: '700', fontSize: 13 }}>
                            {ps === 'UNPAID' ? 'Sin cobrar' : `$ ${(s.total_charged || 0).toLocaleString('es-CO')}`}
                          </Text>
                          <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 1 }}>
                            {new Date(s.ended_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}
                          </Text>
                        </View>
                        <Feather name="chevron-right" size={14} color={T.textMuted} />
                      </TouchableOpacity>
                      );})}
                  </View>

                  {/* Ver más / Ver menos */}
                  {myUsage.sessions.length > 5 && (
                    <TouchableOpacity
                      style={{ paddingVertical: 10, alignItems: 'center' }}
                      onPress={() => setSessionsShown(s => s < myUsage.sessions.length ? s + 10 : 5)}
                    >
                      <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>
                        {sessionsShown < myUsage.sessions.length
                          ? `Ver ${Math.min(10, myUsage.sessions.length - sessionsShown)} más`
                          : 'Ver menos'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              {/* Gestión de métodos de pago */}
              <Text style={styles.sectionTitle}>Mis métodos de pago</Text>
              {paymentMethods.length === 0 ? (
                <Text style={[styles.emptyHint, { marginBottom: 8 }]}>No tienes métodos guardados</Text>
              ) : (
                paymentMethods.map(m => (
                  <View key={m.id} style={[styles.card, m.is_default && { borderColor: T.green, borderWidth: 1 }]}>
                    <View style={styles.cardHeader}>
                      <Feather name={m.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={16} color={m.is_default ? T.green : T.textMuted} style={{ marginRight: 8 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.chargerId, { fontSize: 14 }]}>{m.nickname || m.display}</Text>
                        {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }}>{m.display}</Text>}
                      </View>
                      {m.is_default && <View style={styles.mineBadge}><Text style={styles.mineText}>Predeterminado</Text></View>}
                      <TouchableOpacity onPress={() => setRenameModal({ method: m, value: m.nickname || '' })} style={{ padding: 4, marginLeft: 4 }}>
                        <Feather name="edit-2" size={14} color={T.textMuted} />
                      </TouchableOpacity>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      {!m.is_default && (
                        <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 1, marginTop: 0, paddingVertical: 8 }]}
                          onPress={async () => { await apiFetch(`/payment-methods/${m.id}/default`, { method: 'PATCH' }, token); fetchPaymentMethods(); }}>
                          <Text style={[styles.btnText, { color: T.textMuted, fontSize: 12 }]}>Predeterminar</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity style={[styles.btn, { flex: 1, marginTop: 0, paddingVertical: 8, backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]}
                        onPress={() => Alert.alert('Eliminar', `¿Eliminar ${m.nickname || m.display}?`, [
                          { text: 'Eliminar', style: 'destructive', onPress: async () => { await apiFetch(`/payment-methods/${m.id}`, { method: 'DELETE' }, token); fetchPaymentMethods(); }},
                          { text: 'Cancelar' }
                        ])}>
                        <Feather name="trash-2" size={14} color={T.dangerText} />
                        <Text style={[styles.btnText, { color: T.dangerText, fontSize: 12 }]}>Eliminar</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
              <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => setAddMethodModal('card')}>
                <Feather name="credit-card" size={14} color="#fdfbf7" />
                <Text style={styles.btnText}>Agregar tarjeta</Text>
              </TouchableOpacity>

              {myUsage.sessions?.length === 0 && (
                <View style={styles.empty}>
                  <Feather name="zap-off" size={40} color={T.textMuted} />
                  <Text style={[styles.emptyText, { marginTop: 16 }]}>Sin cargas aún</Text>
                  <Text style={styles.emptyHint}>Escanea el QR de un cargador para empezar</Text>
                </View>
              )}
            </>
          ) : (
            <ActivityIndicator color={T.green} style={{ marginTop: 40 }} />
          )}
        </ScrollView>
      ) : tab === 'lista' ? (
        <FlatList
          data={isOwner ? myChargers : filteredChargers}
          keyExtractor={item => item.id}
          renderItem={isOwner ? renderOwnerCard : renderDriverCard}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchStatus(true)} tintColor={T.green} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name={serverOk === false ? 'wifi-off' : 'zap-off'} size={40} color={T.textMuted} />
              <Text style={[styles.emptyText, { marginTop: 16 }]}>
                {refreshing ? 'Conectando...' : serverOk === false ? 'Sin conexión' : 'Sin cargadores'}
              </Text>
            </View>
          }
        />
      ) : tab === 'admin' ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>

          {/* Banner Sandbox */}
          <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: T.warning, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Feather name="alert-triangle" size={16} color={T.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 13 }}>Modo Sandbox — datos de prueba</Text>
              <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>
                Los números de abajo vienen de tu DB local. Para ver transacciones reales: sandbox.wompi.co
              </Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Panel CPO</Text>

          {adminSummary ? (
            <>
              {/* Estadísticas generales */}
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
                {[
                  { label: 'Sesiones', value: adminSummary.total_sessions },
                  { label: 'kWh', value: adminSummary.total_kwh?.toFixed(1) },
                  { label: 'Conductores', value: adminSummary.total_conductors },
                  { label: 'Dueños', value: adminSummary.total_owners },
                ].map(s => (
                  <View key={s.label} style={{ flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
                    <Text style={{ color: T.textPri, fontSize: 18, fontWeight: '700' }}>{s.value}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>

              {/* Flujo de dinero — solo datos locales */}
              <Text style={styles.sectionTitle}>Flujo de dinero (DB local)</Text>

              <View style={[styles.card, { borderColor: T.green, borderWidth: 1.5, marginBottom: 8 }]}>
                <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Total cobrado a conductores</Text>
                <Text style={{ color: T.green, fontSize: 28, fontWeight: '800' }}>
                  $ {(adminSummary.collected_conductors_cop || 0).toLocaleString('es-CO')}
                  <Text style={{ fontSize: 14, fontWeight: '400' }}> COP</Text>
                </Text>
                <View style={{ height: 1, backgroundColor: T.cardBorder, marginVertical: 10 }} />
                <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 2 }}>Saldo estimado (cobrado − dispersado a dueños)</Text>
                <Text style={{ color: T.textPri, fontSize: 18, fontWeight: '700' }}>
                  $ {(adminSummary.balance_wompi_cop || 0).toLocaleString('es-CO')} COP
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
                <View style={[styles.card, { flex: 1 }]}>
                  <Text style={{ color: T.textMuted, fontSize: 11 }}>Cobrado a conductores</Text>
                  <Text style={{ color: T.textPri, fontSize: 16, fontWeight: '700', marginTop: 4 }}>
                    $ {(adminSummary.collected_conductors_cop || 0).toLocaleString('es-CO')}
                  </Text>
                </View>
                <View style={[styles.card, { flex: 1 }]}>
                  <Text style={{ color: T.textMuted, fontSize: 11 }}>Dispersado a dueños</Text>
                  <Text style={{ color: '#b91c1c', fontSize: 16, fontWeight: '700', marginTop: 4 }}>
                    − $ {(adminSummary.disbursed_owners_cop || 0).toLocaleString('es-CO')}
                  </Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Mi ganancia (detalle)</Text>
              {[
                { label: 'Comisión 10% (tuya)', value: adminSummary.commission_cpo_cop, color: T.green },
                { label: 'IVA cobrado (remitir a DIAN)', value: adminSummary.iva_cop, color: T.warningText },
                { label: 'Fee pasarela Wompi', value: adminSummary.gateway_cop, color: T.textMuted },
              ].map(r => (
                <View key={r.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.cardBorder }}>
                  <Text style={{ color: T.textMuted, fontSize: 13 }}>{r.label}</Text>
                  <Text style={{ color: r.color, fontSize: 13, fontWeight: '600' }}>
                    $ {(r.value || 0).toLocaleString('es-CO')}
                  </Text>
                </View>
              ))}

              {/* Estado de dispersiones */}
              <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Dispersiones a dueños</Text>

              {!adminSummary.wompi_dispersiones_activas && adminSummary.disb_pending_activation > 0 && (
                <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.warning }}>
                  <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>
                    ⚠ Dispersiones no activadas en Wompi
                  </Text>
                  <Text style={{ color: T.warningText, fontSize: 12, lineHeight: 18 }}>
                    Hay <Text style={{ fontWeight: '700' }}>{adminSummary.disb_pending_activation} pagos</Text> por{' '}
                    <Text style={{ fontWeight: '700' }}>$ {(adminSummary.disb_pending_activation_cop || 0).toLocaleString('es-CO')} COP</Text>{' '}
                    guardados pero no enviados.{'\n\n'}
                    Para activarlo:{'\n'}
                    1. Entra a <Text style={{ color: T.green }}>sandbox.wompi.co</Text>{'\n'}
                    2. Configuración → Dispersiones{'\n'}
                    3. Activa el módulo y escríbele a Wompi soporte
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                {[
                  { label: 'Enviadas', value: adminSummary.disb_sent, color: T.green },
                  { label: 'Esperando Wompi', value: adminSummary.disb_pending_activation, color: T.warning },
                  { label: 'Fallidas', value: adminSummary.disb_failed, color: '#b91c1c' },
                ].map(d => (
                  <View key={d.label} style={{ flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
                    <Text style={{ color: d.color, fontSize: 20, fontWeight: '700' }}>{d.value}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2, textAlign: 'center' }}>{d.label}</Text>
                  </View>
                ))}
              </View>

              {/* Últimas sesiones */}
              {adminSummary.recent_sessions?.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>Últimas sesiones</Text>
                  {adminSummary.recent_sessions.map(s => (
                    <View key={s.id} style={[styles.card, { marginBottom: 8 }]}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '600' }}>{s.charger_id}</Text>
                        <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>
                          $ {(s.total_charged || 0).toLocaleString('es-CO')}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ color: T.textMuted, fontSize: 12 }}>{s.session_user}</Text>
                        <Text style={{ color: T.textMuted, fontSize: 12 }}>{s.kwh_delivered?.toFixed(2)} kWh · comisión $ {(s.commission_cpo || 0).toLocaleString('es-CO')}</Text>
                      </View>
                    </View>
                  ))}
                </>
              )}
            </>
          ) : (
            <Text style={[styles.emptyHint, { marginTop: 32 }]}>Cargando datos de la plataforma...</Text>
          )}
        </ScrollView>
      ) : tab === 'negocio' ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>

          {/* Alertas del dueño */}
          {ownerEvents?.events?.length > 0 && (
            <View style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.sectionTitle}>
                  Alertas{ownerEvents.unread_count > 0 ? ` (${ownerEvents.unread_count} nuevas)` : ''}
                </Text>
                {ownerEvents.unread_count > 0 && (
                  <TouchableOpacity onPress={async () => {
                    try {
                      await apiFetch('/my-events/read', { method: 'POST' }, token);
                      setOwnerEvents(ev => ({ ...ev, unread_count: 0, events: ev.events.map(e => ({ ...e, read: true })) }));
                    } catch {}
                  }}>
                    <Text style={{ color: T.green, fontSize: 12, fontWeight: '600' }}>Marcar leídas</Text>
                  </TouchableOpacity>
                )}
              </View>
              {ownerEvents.events.slice(0, 5).map(e => {
                const evIcon  = e.type === 'CHARGER_OFFLINE' ? 'wifi-off' : e.type === 'PAYMENT_UNPAID' ? 'alert-triangle'
                              : e.type === 'SETTLEMENT_SENT' ? 'send' : e.type === 'SESSION_STARTED' ? 'zap' : 'check-circle';
                const evColor = e.type === 'CHARGER_OFFLINE' || e.type === 'PAYMENT_UNPAID' ? T.warningText : T.green;
                return (
                  <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: e.read ? T.surface : T.card, borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: e.read ? T.cardBorder : T.greenDark }}>
                    <Feather name={evIcon} size={15} color={evColor} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: e.read ? T.textMuted : T.textPri, fontSize: 12, lineHeight: 17 }}>{e.message}</Text>
                      <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 2 }}>
                        {new Date(e.created_at).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* P&L completo */}
          {earnings ? (
            <>
              <View style={styles.earningsCard}>
                <Text style={styles.earningsTitle}>Ganancia neta acumulada</Text>
                <Text style={styles.earningsAmount}>
                  $ {(earnings.total_net_profit_cop || 0).toLocaleString('es-CO')} COP
                </Text>
                <View style={styles.earningsRow}>
                  <View style={styles.earningsStat}>
                    <Text style={styles.earningsStatVal}>{earnings.total_sessions}</Text>
                    <Text style={styles.earningsStatLbl}>Sesiones</Text>
                  </View>
                  <View style={styles.earningsStat}>
                    <Text style={styles.earningsStatVal}>{earnings.total_kwh}</Text>
                    <Text style={styles.earningsStatLbl}>kWh</Text>
                  </View>
                  <View style={styles.earningsStat}>
                    <Text style={styles.earningsStatVal}>$ {(earnings.total_revenue_cop || 0).toLocaleString('es-CO')}</Text>
                    <Text style={styles.earningsStatLbl}>Ingreso bruto</Text>
                  </View>
                </View>
              </View>

              {/* Desglose */}
              <View style={styles.plCard}>
                <Text style={styles.sectionTitle}>Desglose P&L</Text>
                <View style={styles.plRow}>
                  <Text style={styles.plLabel}>Ingreso bruto conductores</Text>
                  <Text style={styles.plPos}>+ $ {(earnings.total_revenue_cop || 0).toLocaleString('es-CO')}</Text>
                </View>
                <View style={styles.plRow}>
                  <Text style={styles.plLabel}>Costo electricidad estimado</Text>
                  <Text style={styles.plNeg}>− $ {(earnings.total_electricity_cop || 0).toLocaleString('es-CO')}</Text>
                </View>
                <View style={styles.plRow}>
                  <Text style={styles.plLabel}>Comisión plataforma (10%)</Text>
                  <Text style={styles.plNeg}>− $ {(earnings.total_commission_cop || 0).toLocaleString('es-CO')}</Text>
                </View>
                <View style={[styles.plRow, styles.plTotal]}>
                  <Text style={styles.plTotalLabel}>Ganancia neta</Text>
                  <Text style={styles.plTotalVal}>$ {(earnings.total_net_profit_cop || 0).toLocaleString('es-CO')}</Text>
                </View>
                <Text style={styles.plNote}>
                  * Costo electricidad basado en tu tarifa registrada. Actualízala cuando llegue la factura.
                </Text>
              </View>
            </>
          ) : (
            <ActivityIndicator color={T.green} style={{ marginTop: 32 }} />
          )}

          {/* Rendimiento por período */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Rendimiento</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {[['today', 'Hoy'], ['week', '7 días'], ['month', '30 días']].map(([k, lbl]) => (
                <TouchableOpacity key={k}
                  style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: statsPeriod === k ? T.greenFaint : T.surface, borderWidth: 1, borderColor: statsPeriod === k ? T.greenDark : T.cardBorder }}
                  onPress={() => setStatsPeriod(k)}>
                  <Text style={{ color: statsPeriod === k ? T.green : T.textMuted, fontSize: 11, fontWeight: '700' }}>{lbl}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {myStats ? (
            <>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                {[[myStats.totals.sessions, 'Sesiones'], [myStats.totals.kwh, 'kWh'], [`$ ${(myStats.totals.net_cop || 0).toLocaleString('es-CO')}`, 'Neto']].map(([val, lbl]) => (
                  <View key={lbl} style={{ flex: 1, backgroundColor: T.card, borderRadius: 10, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
                    <Text style={{ color: T.textPri, fontSize: 15, fontWeight: '800' }}>{val}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 2 }}>{lbl}</Text>
                  </View>
                ))}
              </View>
              {myStats.chargers.map(st => (
                <View key={st.charger_id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: T.cardBorder }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '700' }}>{st.charger_id}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11 }} numberOfLines={1}>{st.location}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: T.green, fontSize: 13, fontWeight: '700' }}>$ {(st.net_cop || 0).toLocaleString('es-CO')}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>
                      {st.sessions} ses · {st.kwh} kWh · {st.utilization_pct}% uso
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : (
            <ActivityIndicator color={T.green} style={{ marginVertical: 12 }} />
          )}

          {/* Mis cargadores con precio Y costo editable */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
            <Text style={styles.sectionTitle}>Mis cargadores</Text>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.greenFaint, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: T.greenDark }}
              onPress={() => setAddChargerModal(true)}>
              <Feather name="plus" size={13} color={T.green} />
              <Text style={{ color: T.green, fontSize: 12, fontWeight: '700' }}>Agregar</Text>
            </TouchableOpacity>
          </View>
          {chargers.filter(c => c.owner_id === user?.id).map(c => (
            <View key={c.id} style={[styles.card, styles.cardMine]}>
              <View style={styles.cardHeader}>
                <View style={[styles.dot, { backgroundColor: STATUS_COLOR[c.status] || T.offline }]} />
                <Text style={styles.chargerId}>{c.id}</Text>
                <Text style={[styles.statusText, { color: STATUS_COLOR[c.status] || T.offline, fontSize: 12 }]}>{c.status}</Text>
              </View>
              <Text style={styles.location}>{c.location}</Text>

              {/* Specs técnicas */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {c.power_kw && (
                  <View style={styles.techChip}>
                    <Feather name="zap" size={11} color={T.green} />
                    <Text style={styles.techChipText}>{c.power_kw} kW</Text>
                  </View>
                )}
                {c.connector_type && (
                  <View style={styles.techChip}>
                    <Feather name="cpu" size={11} color={T.textSec} />
                    <Text style={styles.techChipText}>{c.connector_type}</Text>
                  </View>
                )}
                {c.model && (
                  <View style={styles.techChip}>
                    <Feather name="box" size={11} color={T.textMuted} />
                    <Text style={[styles.techChipText, { color: T.textMuted }]}>{c.model}</Text>
                  </View>
                )}
                {c.power_kw && (
                  <View style={[styles.techChip, { backgroundColor: T.greenFaint, borderColor: T.greenDark }]}>
                    <Text style={[styles.techChipText, { color: T.greenLight }]}>
                      ~{Math.round(c.power_kw * 0.9)} km/h
                    </Text>
                  </View>
                )}
              </View>

              {/* Precio cobrado al conductor */}
              {editingPrice === c.id ? (
                <View style={styles.priceEditor}>
                  <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
                    keyboardType="numeric" placeholder="Ej: 1100" placeholderTextColor={T.textMuted} autoFocus />
                  <Text style={styles.priceUnit}>COP/kWh</Text>
                  <TouchableOpacity style={styles.priceSave} onPress={() => savePrice(c.id)}>
                    <Feather name="check" size={18} color="#fdfbf7" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
                    <Feather name="x" size={18} color={T.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.priceRow} onPress={() => { setEditingPrice(c.id); setNewPrice(String(c.price_per_kwh || '')); }}>
                  <View>
                    <Text style={styles.priceLabel}>Precio al conductor</Text>
                    <Text style={styles.priceValue}>$ {(c.price_per_kwh || 0).toLocaleString('es-CO')} / kWh</Text>
                    <Text style={styles.priceUserNote}>Conductor paga: $ {Math.round((c.price_per_kwh || 0) * 1.1).toLocaleString('es-CO')} (+10% CPO)</Text>
                  </View>
                  <Feather name="edit-2" size={14} color={T.green} />
                </TouchableOpacity>
              )}

              {/* Tarifa pico (18:00–22:00) */}
              {editingPrice === `peak_${c.id}` ? (
                <View style={styles.priceEditor}>
                  <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
                    keyboardType="numeric" placeholder="Vacío = quitar" placeholderTextColor={T.textMuted} autoFocus />
                  <Text style={styles.priceUnit}>COP/kWh</Text>
                  <TouchableOpacity style={styles.priceSave} onPress={async () => {
                    const peak = parseFloat(newPrice);
                    try {
                      await apiFetch(`/chargers/${c.id}/peak-price`, {
                        method: 'PATCH',
                        body: JSON.stringify({ peak_price_per_kwh: peak > 0 ? peak : null }),
                      }, token);
                      setEditingPrice(null); fetchStatus();
                      Alert.alert('Listo', peak > 0 ? `Tarifa pico de $ ${peak.toLocaleString('es-CO')}/kWh activa de 6 a 10 pm` : 'Tarifa pico desactivada — precio único todo el día');
                    } catch (e) { Alert.alert('Error', e.message); }
                  }}>
                    <Feather name="check" size={18} color="#fdfbf7" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
                    <Feather name="x" size={18} color={T.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={[styles.priceRow, { marginTop: 4, backgroundColor: 'transparent', borderTopWidth: 1, borderTopColor: T.cardBorder }]}
                  onPress={() => { setEditingPrice(`peak_${c.id}`); setNewPrice(String(c.peak_price_per_kwh || '')); }}>
                  <View>
                    <Text style={styles.priceLabel}>Tarifa pico (6–10 pm)</Text>
                    <Text style={[styles.priceValue, !c.peak_price_per_kwh && { color: T.textMuted, fontSize: 13 }]}>
                      {c.peak_price_per_kwh ? `$ ${c.peak_price_per_kwh.toLocaleString('es-CO')} / kWh` : 'Sin tarifa pico — toca para fijarla'}
                    </Text>
                  </View>
                  <Feather name="edit-2" size={14} color={c.peak_price_per_kwh ? T.green : T.textMuted} />
                </TouchableOpacity>
              )}

              {/* Costo electricidad */}
              {editingPrice === `cost_${c.id}` ? (
                <View style={styles.priceEditor}>
                  <TextInput style={styles.priceInput} value={newPrice} onChangeText={setNewPrice}
                    keyboardType="numeric" placeholder="Ej: 650" placeholderTextColor={T.textMuted} autoFocus />
                  <Text style={styles.priceUnit}>COP/kWh</Text>
                  <TouchableOpacity style={styles.priceSave} onPress={async () => {
                    const cost = parseFloat(newPrice);
                    if (!cost || cost <= 0) return;
                    await apiFetch(`/chargers/${c.id}/cost`, { method: 'PATCH', body: JSON.stringify({ cost_per_kwh: cost }) }, token);
                    setEditingPrice(null); fetchStatus(); fetchEarnings();
                    Alert.alert('Listo', 'Costo de electricidad actualizado');
                  }}>
                    <Feather name="check" size={18} color="#fdfbf7" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.priceCancel} onPress={() => setEditingPrice(null)}>
                    <Feather name="x" size={18} color={T.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={[styles.priceRow, { marginTop: 4, backgroundColor: 'transparent', borderTopWidth: 1, borderTopColor: T.cardBorder }]}
                  onPress={() => { setEditingPrice(`cost_${c.id}`); setNewPrice(String(c.cost_per_kwh || '')); }}>
                  <View>
                    <Text style={styles.priceLabel}>Mi costo electricidad</Text>
                    <Text style={[styles.priceValue, { fontSize: 13 }]}>
                      $ {(c.cost_per_kwh || 0).toLocaleString('es-CO')} / kWh
                      <Text style={styles.priceUserNote}>  (actualizar con la factura)</Text>
                    </Text>
                    <Text style={styles.plPos}>
                      Margen por kWh: $ {Math.round(((c.price_per_kwh || 0) * 0.9) - (c.cost_per_kwh || 0)).toLocaleString('es-CO')}
                    </Text>
                  </View>
                  <Feather name="edit-2" size={14} color={T.textMuted} />
                </TouchableOpacity>
              )}

              {/* Acciones */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, borderTopWidth: 1, borderTopColor: T.cardBorder, paddingTop: 10, flexWrap: 'wrap' }}>
                {/* Pausa / Reanudar */}
                {c.status !== 'Offline' && c.status !== 'Charging' && (
                  <TouchableOpacity
                    style={[styles.btn, { flex: 1, minWidth: 90, marginTop: 0, paddingVertical: 9,
                      backgroundColor: c.status === 'Unavailable' ? T.greenFaint : T.surface,
                      borderWidth: 1, borderColor: c.status === 'Unavailable' ? T.greenDark : T.cardBorder }]}
                    onPress={() => togglePause(c)}
                  >
                    <Feather name={c.status === 'Unavailable' ? 'play' : 'pause'} size={13}
                      color={c.status === 'Unavailable' ? T.green : T.textMuted} />
                    <Text style={[styles.btnText, { fontSize: 12, color: c.status === 'Unavailable' ? T.green : T.textMuted }]}>
                      {c.status === 'Unavailable' ? 'Reanudar' : 'Pausar'}
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Eliminar */}
                <TouchableOpacity
                  style={[styles.btn, { flex: 1, minWidth: 90, marginTop: 0, paddingVertical: 9,
                    backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]}
                  onPress={() => deleteCharger(c)}
                >
                  <Feather name="trash-2" size={13} color={T.dangerText} />
                  <Text style={[styles.btnText, { fontSize: 12, color: T.dangerText }]}>Eliminar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {/* Saldo disponible y retiro */}
          {balance && (
            <View style={[styles.card, { borderColor: T.greenDark, borderWidth: 1.5, marginBottom: 16 }]}>
              <Text style={{ color: T.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}>TU SALDO</Text>
              <Text style={{ color: T.green, fontSize: 32, fontWeight: '800', marginTop: 4 }}>
                $ {balance.balance_cop.toLocaleString('es-CO')}
                <Text style={{ fontSize: 15, fontWeight: '600', color: T.textSec }}>  COP</Text>
              </Text>
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
                {balance.in_transit_cop > 0 && (
                  <Text style={{ color: T.textSec, fontSize: 12 }}>En camino: $ {balance.in_transit_cop.toLocaleString('es-CO')}</Text>
                )}
                {balance.pending_activation_cop > 0 && (
                  <Text style={{ color: T.warningText, fontSize: 12 }}>En cola Wompi: $ {balance.pending_activation_cop.toLocaleString('es-CO')}</Text>
                )}
                {balance.total_sent_cop > 0 && (
                  <Text style={{ color: T.textMuted, fontSize: 12 }}>Recibido: $ {balance.total_sent_cop.toLocaleString('es-CO')}</Text>
                )}
              </View>
              <TouchableOpacity
                disabled={withdrawing || balance.balance_cop < balance.min_withdraw_cop}
                style={[styles.btn, {
                  marginTop: 12, paddingVertical: 12,
                  backgroundColor: balance.balance_cop >= balance.min_withdraw_cop ? T.green : T.surface,
                  borderWidth: 1, borderColor: balance.balance_cop >= balance.min_withdraw_cop ? T.greenDark : T.cardBorder,
                  opacity: withdrawing ? 0.6 : 1,
                }]}
                onPress={withdrawBalance}
              >
                <Feather name="arrow-down-circle" size={15} color={balance.balance_cop >= balance.min_withdraw_cop ? T.bg : T.textMuted} />
                <Text style={[styles.btnText, { fontSize: 13, color: balance.balance_cop >= balance.min_withdraw_cop ? T.bg : T.textMuted }]}>
                  {withdrawing ? 'Procesando…'
                    : balance.balance_cop >= balance.min_withdraw_cop ? 'Retirar a mi cuenta'
                    : `Retiro desde $ ${balance.min_withdraw_cop.toLocaleString('es-CO')}`}
                </Text>
              </TouchableOpacity>
              <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 8, lineHeight: 15 }}>
                Giro automático los días 5 y 20 de cada mes (día hábil).
                {balance.next_settlement ? ` Próximo: ${new Date(balance.next_settlement + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}.` : ''}
              </Text>
            </View>
          )}

          {/* Mis pagos pendientes */}
          {myDisburses?.total_pendiente_cop > 0 && (
            <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: T.warning }}>
              <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 14, marginBottom: 4 }}>
                Pago pendiente: $ {myDisburses.total_pendiente_cop.toLocaleString('es-CO')} COP
              </Text>
              <Text style={{ color: T.warningText, fontSize: 12, lineHeight: 18 }}>
                Tu dinero ya está registrado pero Wompi no tiene activado el módulo de Dispersiones en esta cuenta aún.{'\n'}
                Cuando el admin active la función, recibirás el pago automáticamente.
              </Text>
            </View>
          )}
          {myDisburses?.total_enviado_cop > 0 && (
            <View style={{ backgroundColor: T.greenFaint, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: T.greenDark }}>
              <Text style={{ color: T.green, fontWeight: '700', fontSize: 14 }}>
                Total recibido: $ {myDisburses.total_enviado_cop.toLocaleString('es-CO')} COP
              </Text>
            </View>
          )}

          {/* Cuenta de dispersión */}
          <Text style={styles.sectionTitle}>Cuenta para recibir pagos</Text>

          {/* Explicación del flujo de dinero */}
          <View style={{ backgroundColor: T.surface, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.cardBorder }}>
            <Text style={{ color: T.textMuted, fontSize: 12, lineHeight: 18 }}>
              <Text style={{ color: T.green, fontWeight: '600' }}>¿Cómo funciona?{'\n'}</Text>
              1. El conductor paga → el dinero llega a la cuenta CPO en Wompi{'\n'}
              2. Confirmado el cobro, tu ganancia se abona a tu saldo (kWh × tu precio base){'\n'}
              3. Retiras cuando quieras — o el giro sale solo al acumular suficiente
            </Text>
          </View>

          {disbAccount ? (
            <View style={[styles.card, { borderColor: disbAccount.verified ? T.green : T.warning, borderWidth: 1.5 }]}>
              <View style={styles.cardHeader}>
                <Feather name={disbAccount.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={16} color={disbAccount.verified ? T.green : T.warning} style={{ marginRight: 8 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.chargerId}>{disbAccount.display}</Text>
                  <Text style={{ color: T.textMuted, fontSize: 12 }}>{disbAccount.holder_name}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: disbAccount.verified ? T.greenFaint : '#fbf0dc', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
                  <Feather name={disbAccount.verified ? 'check-circle' : 'alert-circle'} size={12} color={disbAccount.verified ? T.green : T.warning} />
                  <Text style={{ color: disbAccount.verified ? T.green : T.warning, fontSize: 11, fontWeight: '600' }}>
                    {disbAccount.verified ? 'Verificada' : 'Sin verificar'}
                  </Text>
                </View>
              </View>
              {!disbAccount.verified && (
                <View style={{ backgroundColor: T.warningBg, borderRadius: 8, padding: 10, marginTop: 8 }}>
                  <Text style={{ color: T.warningText, fontSize: 12, marginBottom: 8 }}>
                    ⚠ La cuenta no está verificada. Sin verificación no recibirás los pagos al terminar las sesiones.
                  </Text>
                  <TouchableOpacity style={[styles.btn, { backgroundColor: T.greenDark, borderWidth: 1, borderColor: T.warning, marginTop: 0, paddingVertical: 10 }]} onPress={verifyDisbAccount}>
                    <Feather name="zap" size={14} color="#fdfbf7" />
                    <Text style={[styles.btnText, { fontSize: 13 }]}>Verificar cuenta ahora ($500 prueba)</Text>
                  </TouchableOpacity>
                </View>
              )}
              <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 8 }]} onPress={() => { setDisbForm({ type: disbAccount.type, phone: '', account_number:'', bank_code:'', account_type:'SAVINGS', holder_name: disbAccount.holder_name, holder_id:'' }); setAddDisbModal(true); }}>
                <Feather name="edit-2" size={13} color={T.textMuted} />
                <Text style={[styles.btnText, { color: T.textMuted }]}>Cambiar cuenta</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={{ backgroundColor: '#fbe7e7', borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#b91c1c' }}>
                <Text style={{ color: '#b91c1c', fontSize: 12 }}>⚠ Sin cuenta registrada no recibirás tus ganancias.</Text>
              </View>
              <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={() => setAddDisbModal(true)}>
                <Feather name="plus" size={16} color="#fdfbf7" />
                <Text style={styles.btnText}>Agregar cuenta para cobros</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Historial de sesiones con desglose */}
          {earnings?.sessions?.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.sectionTitle}>Últimas sesiones</Text>
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                  onPress={() => Linking.openURL(`${API_URL}/my-earnings/export?token=${token}`)}>
                  <Feather name="download" size={12} color={T.green} />
                  <Text style={{ color: T.green, fontSize: 12, fontWeight: '600' }}>Exportar CSV</Text>
                </TouchableOpacity>
              </View>
              {earnings.sessions.map(s => (
                <View key={s.id} style={styles.sessionHistCard}>
                  <View style={styles.sessionHistHeader}>
                    <Text style={styles.sessionHistId}>{s.charger_id}</Text>
                    <Text style={styles.sessionHistRevenue}>+ $ {s.net_profit_owner.toLocaleString('es-CO')}</Text>
                  </View>
                  <Text style={styles.sessionHistLocation}>{s.location}</Text>
                  <View style={styles.sessionHistRow}>
                    <Text style={styles.sessionHistDetail}>{s.kwh_delivered} kWh</Text>
                    <Text style={styles.sessionHistDetail}>Luz: $ {s.electricity_cost.toLocaleString('es-CO')}</Text>
                    <Text style={styles.sessionHistDetail}>{new Date(s.ended_at).toLocaleDateString('es-CO')}</Text>
                  </View>
                </View>
              ))}
            </>
          )}

          {earnings?.sessions?.length === 0 && (
            <View style={styles.empty}>
              <Feather name="bar-chart-2" size={40} color={T.textMuted} />
              <Text style={[styles.emptyText, { marginTop: 16 }]}>Sin sesiones aún</Text>
              <Text style={styles.emptyHint}>Activa un cargador para ver tus ganancias</Text>
            </View>
          )}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <MapView
            ref={mapRef}
            style={styles.map}
            initialRegion={MEDELLIN}
            onPress={() => { setSelectedCharger(null); setMapSearch(''); setGeoResults([]); }}
            onRegionChangeComplete={r => {
              if (r.latitudeDelta > 0.07) setZoom('far');
              else if (r.latitudeDelta > 0.025) setZoom('mid');
              else setZoom('close');
            }}
          >
            {chargers.filter(c => c.lat && c.lng).map(c => (
              <ChargerMarker
                key={c.id}
                charger={c}
                isSelected={selectedCharger?.id === c.id}
                isMine={isOwner && c.owner_id === user?.id}
                zoom={zoom}
                onPress={() => { setSelectedCharger(c); setChargerPanel(c); setMapSearch(''); }}
              />
            ))}
          </MapView>

          {/* ── Buscador flotante estilo maps ── */}
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
                    <Text style={styles.mapSearchItemPrice}>$ {Math.round((c.price_per_kwh_now ?? c.price_per_kwh ?? 0) * 1.10 * 1.19 * 1.03).toLocaleString('es-CO')}/kWh</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

        </View>
      )}

      {/* ── Panel flotante del mapa — nivel raíz para capturar toques correctamente ── */}
      {tab === 'mapa' && selectedCharger && (() => {
        const c        = chargers.find(x => x.id === selectedCharger.id) || selectedCharger;
        const color    = STATUS_COLOR[c.status] || T.offline;
        const mine     = isOwner && c.owner_id === user?.id;
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.10 * 1.19 * 1.03) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        return (
          <View style={styles.mapPanel}>
            <View style={styles.mapPanelHandle} />
            <View style={styles.mapPanelHeader}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.dot, { backgroundColor: color, width: 10, height: 10, borderRadius: 5 }]} />
                  <Text style={styles.mapPanelId}>{c.id}</Text>
                  {mine && <View style={styles.mineBadge}><Text style={styles.mineText}>Mi cargador</Text></View>}
                </View>
                <Text style={styles.mapPanelLocation}>{c.location}</Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedCharger(null)} style={{ padding: 8 }}>
                <Feather name="x" size={20} color={T.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.specsRow}>
              {c.power_kw       && <View style={styles.specChip}><Text style={styles.specText}>{c.power_kw} kW</Text></View>}
              {c.connector_type && <View style={styles.specChip}><Text style={styles.specText}>{c.connector_type}</Text></View>}
              <View style={[styles.specChip, { backgroundColor: color + '22', borderColor: color + '55' }]}>
                <Text style={[styles.specText, { color }]}>{c.status}</Text>
              </View>
              {c.owner && <View style={styles.specChip}><Text style={styles.specText}>{c.owner}</Text></View>}
            </View>
            {priceUser && (
              <View style={styles.mapPanelPrice}>
                <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                <Text style={styles.mapPanelPriceNote}>IVA y pasarela incluidos</Text>
              </View>
            )}
            {isCharg && c.current_kwh != null && (
              <View style={[styles.sessionBox, { marginBottom: 8 }]}>
                <View style={styles.sessionRow}>
                  <Text style={styles.sessionLabel}>En carga ahora</Text>
                  <Text style={styles.sessionCost}>{c.current_kwh} kWh · $ {Math.round(c.current_kwh*(priceUser||0)).toLocaleString('es-CO')} COP</Text>
                </View>
              </View>
            )}
            {!isOwner && (
              <View style={styles.modalActions}>
                {isAvail && (
                  <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 2 }]} onPress={() => { setSelectedCharger(null); simulateQrScan(c); }}>
                    <Feather name="maximize" size={15} color="#fdfbf7" />
                    <Text style={styles.btnText}>Escanear QR</Text>
                  </TouchableOpacity>
                )}
                {isCharg && activeSession?.chargerId === c.id && (
                  <TouchableOpacity style={[styles.btn, styles.btnStop, { flex: 2 }]} onPress={() => { setSelectedCharger(null); remoteStop(c.id); }}>
                    <Feather name="square" size={15} color={T.dangerText} />
                    <Text style={[styles.btnText, { color: T.dangerText }]}>Detener</Text>
                  </TouchableOpacity>
                )}
                {isAvail && (
                  <TouchableOpacity style={[styles.btn, styles.btnReserve, { flex: 1 }]} onPress={() => doReserve(c)}>
                    <Feather name="clock" size={15} color={T.green} />
                    <Text style={[styles.btnText, { color: T.green }]}>Reservar</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        );
      })()}

      {/* ── Barra de navegación inferior ── */}
      {!selectedCharger && !chargerPanel && !qrModal && !payMethodsModal && !addMethodModal && !paymentPending && !addDisbModal && !sessionModal && !debtPayModal && (
        <View style={styles.bottomBar}>
          {(isAdmin ? [
            { id: 'admin',  icon: 'activity',     label: 'Plataforma' },
            { id: 'mapa',   icon: 'map-pin',       label: 'Mapa'       },
            { id: 'lista',  icon: 'list',          label: 'Cargadores' },
          ] : isOwner ? [
            { id: 'lista',   icon: 'zap',         label: 'Cargadores' },
            { id: 'mapa',    icon: 'map-pin',      label: 'Mapa'       },
            { id: 'negocio', icon: 'bar-chart-2',  label: 'Negocio'    },
          ] : [
            { id: 'mapa',   icon: 'map-pin', label: 'Mapa'     },
            { id: 'lista',  icon: 'list',    label: 'Lista'    },
            { id: 'miuso',  icon: 'user',    label: 'Mi uso'   },
          ]).map(t => (
            <TouchableOpacity key={t.id} style={styles.bottomTab} onPress={() => setTab(t.id)}>
              <Feather name={t.icon} size={22} color={tab === t.id ? T.green : T.textMuted} />
              <Text style={[styles.bottomTabLabel, tab === t.id && styles.bottomTabLabelActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Mini-barra de sesión activa (siempre visible al fondo) ── */}
      {activeSession && !isOwner && (
        <TouchableOpacity onPress={() => setSessionModal(true)} activeOpacity={0.9} style={styles.sessionPill}>
          {/* Indicador de carga pulsante */}
          <View style={styles.sessionPillDot} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.sessionPillTitle}>Cargando</Text>
              <Text style={styles.sessionPillId}>{activeSession.chargerId}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 3 }}>
              <Text style={styles.sessionPillStat}>
                {sessionKwh === 0 ? '—' : `${sessionKwh.toFixed(3)} kWh`}
              </Text>
              <Text style={styles.sessionPillStat}>
                {sessionCost > 0 ? `$ ${sessionCost.toLocaleString('es-CO')}` : '—'}
              </Text>
              <Text style={[styles.sessionPillStat, { color: T.textSec }]}>{formatElapsed(elapsed)}</Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => remoteStop(activeSession.chargerId)}
            style={styles.sessionPillStop}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Feather name="square" size={14} color={T.dangerText} />
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* ── Modal detalle sesión ── */}
      {sessionModal && activeSession && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setSessionModal(false)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>{liveCharger?.id}</Text>
            <Text style={styles.mapPanelLocation}>{liveCharger?.location}</Text>
            <View style={[styles.sessionKwhBox, { marginTop: 16 }]}>
              <Text style={styles.sessionKwhLabel}>
                {sessionKwh === 0 ? 'Iniciando sesión...' : 'Energía entregada'}
              </Text>
              {sessionKwh === 0
                ? <ActivityIndicator color={T.green} size="large" style={{ marginVertical: 16 }} />
                : <Text style={styles.sessionKwhValue}>{sessionKwh.toFixed(3)}<Text style={styles.sessionKwhUnit}> kWh</Text></Text>
              }
            </View>
            <View style={[styles.sessionStats, { marginTop: 12 }]}>
              <View style={styles.sessionStat}><Text style={styles.sessionStatVal}>$ {sessionCost.toLocaleString('es-CO')}</Text><Text style={styles.sessionStatLbl}>Costo COP</Text></View>
              <View style={styles.sessionStatSep} />
              <View style={styles.sessionStat}><Text style={styles.sessionStatVal}>{formatElapsed(elapsed)}</Text><Text style={styles.sessionStatLbl}>Tiempo</Text></View>
              <View style={styles.sessionStatSep} />
              <View style={styles.sessionStat}><Text style={styles.sessionStatVal}>{liveCharger?.power_kw || '—'} kW</Text><Text style={styles.sessionStatLbl}>Potencia</Text></View>
            </View>
            {/* Botones al fondo — zona del pulgar */}
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btn, styles.btnStop, { flex: 1 }]} onPress={() => { remoteStop(activeSession.chargerId); setSessionModal(false); }}>
                <Feather name="square" size={16} color={T.dangerText} />
                <Text style={[styles.btnText, { color: T.dangerText }]}>Detener carga</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 1 }]} onPress={() => setSessionModal(false)}>
                <Text style={[styles.btnText, { color: T.textMuted }]}>Minimizar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* ── Panel de acciones del cargador (lista + mapa) ── */}
      {chargerPanel && (() => {
        const c        = chargers.find(x => x.id === chargerPanel.id) || chargerPanel;
        const color    = STATUS_COLOR[c.status] || T.offline;
        const mine     = isOwner && c.owner_id === user?.id;
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.10 * 1.19 * 1.03) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        const close    = () => { setChargerPanel(null); setSelectedCharger(null); };

        return (
          <View style={styles.modalOverlay}>
            <TouchableOpacity style={{ flex: 1 }} onPress={close} activeOpacity={1} />
            <View style={styles.modal}>
              <View style={styles.mapPanelHandle} />

              {/* Header */}
              <View style={styles.mapPanelHeader}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={[styles.dot, { backgroundColor: color, width: 10, height: 10, borderRadius: 5 }]} />
                    <Text style={styles.mapPanelId}>{c.id}</Text>
                    {mine && <View style={styles.mineBadge}><Text style={styles.mineText}>Mi cargador</Text></View>}
                  </View>
                  <Text style={styles.mapPanelLocation}>{c.location}</Text>
                </View>
                <TouchableOpacity onPress={close} style={{ padding: 4 }}>
                  <Feather name="x" size={20} color={T.textMuted} />
                </TouchableOpacity>
              </View>

              {/* Specs */}
              <View style={styles.specsRow}>
                {c.power_kw       && <View style={styles.specChip}><Text style={styles.specText}>{c.power_kw} kW</Text></View>}
                {c.connector_type && <View style={styles.specChip}><Text style={styles.specText}>{c.connector_type}</Text></View>}
                <View style={[styles.specChip, { backgroundColor: color + '22', borderColor: color + '55' }]}>
                  <Text style={[styles.specText, { color }]}>{c.status}</Text>
                </View>
              </View>

              {/* Precio */}
              {priceUser && (
                <View style={styles.mapPanelPrice}>
                  <View>
                    <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                    <Text style={styles.mapPanelPriceNote}>IVA y pasarela incluidos · {c.owner}</Text>
                  </View>
                </View>
              )}

              {/* Sesión activa */}
              {isCharg && c.current_kwh != null && (
                <View style={[styles.sessionBox, { marginBottom: 12 }]}>
                  <View style={styles.sessionRow}>
                    <Text style={styles.sessionLabel}>En carga ahora</Text>
                    <Text style={styles.sessionValue}>{c.current_kwh} kWh</Text>
                  </View>
                  {priceUser && (
                    <View style={styles.sessionRow}>
                      <Text style={styles.sessionLabel}>Costo acumulado</Text>
                      <Text style={styles.sessionCost}>$ {Math.round(c.current_kwh * priceUser).toLocaleString('es-CO')} COP</Text>
                    </View>
                  )}
                </View>
              )}

              {/* Acciones conductor */}
              {!isOwner && (
                <View style={styles.mapPanelActions}>
                  {isAvail && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnStart, { flex: 2 }]}
                      onPress={() => { close(); simulateQrScan(c); }}
                    >
                      <Feather name="maximize" size={16} color="#fdfbf7" />
                      <Text style={styles.btnText}>Escanear QR</Text>
                    </TouchableOpacity>
                  )}
                  {isCharg && activeSession?.chargerId === c.id && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnStop, { flex: 2 }]}
                      onPress={() => { close(); remoteStop(c.id); }}
                    >
                      <Feather name="square" size={16} color={T.dangerText} />
                      <Text style={[styles.btnText, { color: T.dangerText }]}>Detener carga</Text>
                    </TouchableOpacity>
                  )}
                  {isAvail && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnReserve, { flex: 1 }]}
                      onPress={() => { doReserve(c); }}
                    >
                      <Feather name="clock" size={16} color={T.green} />
                      <Text style={[styles.btnText, { color: T.green }]}>Reservar</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          </View>
        );
      })()}

      {/* ── Modal QR simulado ── */}
      {qrModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setQrModal(null)} activeOpacity={1} />
          <View style={[styles.modal, { alignItems: 'center' }]}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>{qrScanning ? 'Escaneando...' : 'Cargador detectado'}</Text>
            <Text style={[styles.mapPanelLocation, { textAlign: 'center', marginBottom: 20 }]}>{qrModal.location}</Text>
            <View style={styles.qrFrame}>
              {qrScanning ? (
                <>
                  <ActivityIndicator size="large" color={T.green} />
                  <Text style={[styles.sessionPulseText, { marginTop: 12 }]}>Leyendo código QR...</Text>
                </>
              ) : (
                <>
                  <Feather name="check-circle" size={48} color={T.green} />
                  <Text style={[styles.earningsTitle, { marginTop: 12, color: T.green }]}>{qrModal.id}</Text>
                  <Text style={styles.sessionPulseText}>{qrModal.power_kw} kW · {qrModal.connector_type}</Text>
                </>
              )}
            </View>
            {/* Botones al fondo */}
            {!qrScanning && (
              <View style={[styles.modalActions, { width: '100%' }]}>
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={() => { setQrModal(null); setPayMethodsModal(qrModal); }}>
                  <Feather name="zap" size={16} color="#fdfbf7" />
                  <Text style={styles.btnText}>Continuar al pago</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]} onPress={() => setQrModal(null)}>
                  <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── Selección de método de pago (real con Wompi) ── */}
      {payMethodsModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setPayMethodsModal(null)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>¿Cómo vas a pagar?</Text>
            <Text style={styles.mapPanelLocation}>{payMethodsModal.location} · $ {Math.round((payMethodsModal.price_per_kwh_now ?? payMethodsModal.price_per_kwh ?? 0)*1.10*1.19*1.03).toLocaleString('es-CO')}/kWh</Text>
            <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 10, marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: T.cardBorder }}>
              <Feather name="info" size={13} color={T.textMuted} />
              <Text style={{ color: T.textMuted, fontSize: 12, flex: 1 }}>
                Se cobra al <Text style={{ color: T.textPri }}>terminar la sesión</Text>. Mínimo $1.500 COP por política de la pasarela de pago.
              </Text>
            </View>

            {paymentMethods.length > 0 && (
              <View style={{ gap: 8, marginTop: 16 }}>
                {paymentMethods.map(m => (
                  <TouchableOpacity key={m.id} style={styles.methodRow} onPress={() => { setPayMethodsModal(null); setConfirmPayModal({ method: m, charger: payMethodsModal }); }}>
                    <Feather name={m.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={18} color={T.green} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.methodDisplay}>{m.nickname || m.display}</Text>
                      {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11 }}>{m.display}</Text>}
                      {m.is_default && <Text style={styles.methodDefault}>Predeterminado</Text>}
                    </View>
                    <Feather name="chevron-right" size={16} color={T.textMuted} />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={() => { setPayMethodsModal(null); setAddMethodModal('card'); }}>
                <Feather name="credit-card" size={15} color="#fdfbf7" />
                <Text style={styles.btnText}>Agregar tarjeta</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* ── Pagar deuda: elegir tarjeta ── */}
      {debtPayModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => !payingDebt && setDebtPayModal(null)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>Pagar cobro pendiente</Text>
            <Text style={styles.mapPanelLocation}>{debtPayModal.charger_id} · $ {debtPayModal.amount_cop.toLocaleString('es-CO')} COP</Text>
            <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 10, marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: T.cardBorder }}>
              <Feather name="info" size={13} color={T.textMuted} />
              <Text style={{ color: T.textMuted, fontSize: 12, flex: 1 }}>
                Usa una tarjeta <Text style={{ color: T.textPri }}>con fondos</Text>. Al pagar, quedas habilitado para cargar de nuevo.
              </Text>
            </View>
            <View style={{ gap: 8, marginTop: 16 }}>
              {paymentMethods.map(m => (
                <TouchableOpacity key={m.id} style={[styles.methodRow, payingDebt && { opacity: 0.5 }]} disabled={payingDebt} onPress={() => payDebt(m)}>
                  <Feather name={m.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={18} color={T.green} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.methodDisplay}>{m.nickname || m.display}</Text>
                    {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11 }}>{m.display}</Text>}
                  </View>
                  {payingDebt ? <ActivityIndicator size="small" color={T.green} /> : <Feather name="chevron-right" size={16} color={T.textMuted} />}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      {/* ── Agregar tarjeta ── */}
      {addMethodModal === 'card' && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setAddMethodModal(null)} activeOpacity={1} />
          <KbSheet>
            <ScrollView style={{ maxHeight: '100%', flexGrow: 0 }} contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled" bounces={false}>
              <View style={styles.mapPanelHandle} />
              <Text style={styles.modalTitle}>Agregar tarjeta</Text>
              <View style={{ gap: 10, marginTop: 16 }}>
                <TextInput
                  style={[styles.input, { letterSpacing: 2, fontSize: 18 }]}
                  placeholder="0000 0000 0000 0000"
                  placeholderTextColor={T.textMuted}
                  value={cardForm.number}
                  onChangeText={v => {
                    const digits = v.replace(/\D/g, '').slice(0, 16);
                    const fmt = digits.replace(/(.{4})/g, '$1 ').trim();
                    setCardForm(f => ({...f, number: fmt}));
                  }}
                  keyboardType="numeric"
                  maxLength={19}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="MM/AA" placeholderTextColor={T.textMuted} value={cardForm.exp}
                  onChangeText={v => {
                    const n = v.replace(/\D/g,'');
                    const fmt = n.length > 2 ? n.slice(0,2)+'/'+n.slice(2,4) : n;
                    setCardForm(f=>({...f,exp:fmt}));
                  }} keyboardType="numeric" maxLength={5} />
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="CVC" placeholderTextColor={T.textMuted} value={cardForm.cvc} onChangeText={v => setCardForm(f=>({...f,cvc:v}))} keyboardType="numeric" maxLength={4} secureTextEntry />
                </View>
                <TextInput style={styles.input} placeholder="Nombre del titular" placeholderTextColor={T.textMuted} value={cardForm.holder} onChangeText={v => setCardForm(f=>({...f,holder:v}))} autoCapitalize="words" />
                <TextInput style={styles.input} placeholder="Apodo (ej: Tarjeta sin fondo)" placeholderTextColor={T.textMuted} value={cardForm.nickname} onChangeText={v => setCardForm(f=>({...f,nickname:v}))} autoCapitalize="sentences" maxLength={30} />
              </View>
              <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 8 }}>
                Prueba sandbox: 4242 4242 4242 4242 · 12/29 · 123
              </Text>
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnStart, { flex: 1 }, savingMethod && { opacity: 0.6 }]}
                  onPress={addCard}
                  disabled={savingMethod}
                >
                  {savingMethod ? (
                    <ActivityIndicator size="small" color="#fdfbf7" />
                  ) : (
                    <Feather name="check" size={16} color="#fdfbf7" />
                  )}
                  <Text style={styles.btnText}>{savingMethod ? 'Guardando…' : 'Guardar tarjeta'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]} onPress={() => setAddMethodModal(null)} disabled={savingMethod}>
                  <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KbSheet>
        </View>
      )}

      {/* ── Selector de ubicación en mapa ── */}
      {locationPicker && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 500 }}>
          <MapView
            style={{ flex: 1 }}
            initialRegion={{
              latitude: locationPicker.lat,
              longitude: locationPicker.lng,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }}
            onRegionChangeComplete={r => {
              const lat = parseFloat(r.latitude.toFixed(6));
              const lng = parseFloat(r.longitude.toFixed(6));
              setLocationPicker(p => ({ ...p, lat, lng }));
              // Geocodificación inversa con debounce
              if (locPickerTimeout.current) clearTimeout(locPickerTimeout.current);
              locPickerTimeout.current = setTimeout(() => reverseGeocode(lat, lng), 600);
            }}
          />

          {/* Pin fijo en el centro */}
          <View style={styles.locPickerPin} pointerEvents="none">
            <Feather name="map-pin" size={38} color={T.green} style={{ marginBottom: -4 }} />
            <View style={styles.locPickerShadow} />
          </View>

          {/* Card superior — instrucción */}
          <View style={styles.locPickerTopCard}>
            <Feather name="move" size={14} color={T.textMuted} />
            <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '600', flex: 1 }}>
              Arrastra el mapa para ubicar el cargador
            </Text>
          </View>

          {/* Card inferior — coordenadas + confirmar */}
          <View style={styles.locPickerBottomCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Feather name="map-pin" size={14} color={T.green} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '700' }}>
                  {locationPicker.lat.toFixed(5)}, {locationPicker.lng.toFixed(5)}
                </Text>
                {locationPicker.address ? (
                  <Text style={{ color: T.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
                    {locationPicker.address}
                  </Text>
                ) : (
                  <Text style={{ color: T.textMuted, fontSize: 12, marginTop: 2 }}>Obteniendo dirección...</Text>
                )}
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.btn, styles.btnStart, { flex: 1, marginTop: 0, paddingVertical: 13 }]}
                onPress={() => {
                  setChargerForm(f => ({
                    ...f,
                    lat: String(locationPicker.lat),
                    lng: String(locationPicker.lng),
                    location: locationPicker.address || f.location,
                  }));
                  setLocationPicker(null);
                }}
              >
                <Feather name="check" size={16} color="#fdfbf7" />
                <Text style={styles.btnText}>Confirmar ubicación</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { flex: 0.4, marginTop: 0, paddingVertical: 13 }]}
                onPress={() => setLocationPicker(null)}
              >
                <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* ── Agregar cargador (dueño) ── */}
      {addChargerModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setAddChargerModal(false)} activeOpacity={1} />
          <KbSheet>
            <ScrollView contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled">
              <View style={styles.mapPanelHandle} />
              <Text style={styles.modalTitle}>Registrar cargador</Text>
              <Text style={styles.mapPanelLocation}>Te asignaremos un ID único (FARO-XXXX) y la URL para configurar tu equipo.</Text>

              <View style={{ gap: 10, marginTop: 16 }}>
                {/* Marca del cargador */}
                {brandProfiles.length > 0 && (
                  <View>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 6, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Marca (opcional)</Text>
                    <View style={[styles.roleRow, { flexWrap: 'wrap' }]}>
                      {brandProfiles.map(bp => (
                        <TouchableOpacity key={bp.id}
                          style={[styles.roleBtn, chargerForm.brand_profile_id === bp.id && styles.roleBtnActive]}
                          onPress={() => setChargerForm(f=>({...f, brand_profile_id: f.brand_profile_id === bp.id ? null : bp.id}))}>
                          <Text style={[styles.roleBtnText, chargerForm.brand_profile_id === bp.id && styles.roleBtnTextActive]}>{bp.display_name}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    {chargerForm.brand_profile_id ? (
                      <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 4 }} numberOfLines={3}>
                        {(brandProfiles.find(b => b.id === chargerForm.brand_profile_id) || {}).setup_guide_md}
                      </Text>
                    ) : (
                      <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 4 }}>
                        Si eliges la marca te mostramos la guía de conexión exacta. También la detectamos sola cuando el equipo se conecte.
                      </Text>
                    )}
                  </View>
                )}

                {/* Ubicación */}
                <TextInput style={styles.input} placeholder="Ubicación (ej: CC Santafé, Medellín)"
                  placeholderTextColor={T.textMuted} value={chargerForm.location}
                  onChangeText={v => setChargerForm(f=>({...f, location: v}))} autoCapitalize="words" />

                {/* Coordenadas — selector de mapa */}
                <TouchableOpacity
                  style={[styles.input, { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'space-between' }]}
                  onPress={() => setLocationPicker({
                    lat: parseFloat(chargerForm.lat) || 6.2100,
                    lng: parseFloat(chargerForm.lng) || -75.5700,
                    address: chargerForm.location || '',
                  })}
                >
                  {chargerForm.lat && chargerForm.lng ? (
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '600' }}>
                        {parseFloat(chargerForm.lat).toFixed(5)}, {parseFloat(chargerForm.lng).toFixed(5)}
                      </Text>
                      {chargerForm.location ? (
                        <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }} numberOfLines={1}>{chargerForm.location}</Text>
                      ) : null}
                    </View>
                  ) : (
                    <Text style={{ color: T.textMuted, fontSize: 13, flex: 1 }}>Toca para seleccionar en el mapa</Text>
                  )}
                  <Feather name="map-pin" size={18} color={chargerForm.lat ? T.green : T.textMuted} />
                </TouchableOpacity>

                {/* Tipo de conector */}
                <Text style={{ color: T.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Tipo de conector *</Text>
                <View style={styles.roleRow}>
                  {['Type 2', 'CCS2', 'CHAdeMO', 'Schuko'].map(t => (
                    <TouchableOpacity key={t}
                      style={[styles.roleBtn, chargerForm.connector_type === t && styles.roleBtnActive]}
                      onPress={() => setChargerForm(f=>({...f, connector_type: t}))}>
                      <Text style={[styles.roleBtnText, chargerForm.connector_type === t && styles.roleBtnTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Potencia */}
                <Text style={{ color: T.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Potencia *</Text>
                <View style={styles.roleRow}>
                  {['7.4', '11', '22', '50', '150'].map(p => (
                    <TouchableOpacity key={p}
                      style={[styles.roleBtn, chargerForm.power_kw === p && styles.roleBtnActive]}
                      onPress={() => setChargerForm(f=>({...f, power_kw: p}))}>
                      <Text style={[styles.roleBtnText, chargerForm.power_kw === p && styles.roleBtnTextActive]}>{p} kW</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Precios */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Precio base (COP/kWh) *</Text>
                    <TextInput style={styles.input} placeholder="1100" placeholderTextColor={T.textMuted}
                      value={chargerForm.price_per_kwh} onChangeText={v => setChargerForm(f=>({...f, price_per_kwh: v}))}
                      keyboardType="number-pad" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Costo electricidad</Text>
                    <TextInput style={styles.input} placeholder="650" placeholderTextColor={T.textMuted}
                      value={chargerForm.cost_per_kwh} onChangeText={v => setChargerForm(f=>({...f, cost_per_kwh: v}))}
                      keyboardType="number-pad" />
                  </View>
                </View>
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={addCharger}>
                  <Feather name="plus" size={16} color="#fdfbf7" />
                  <Text style={styles.btnText}>Registrar cargador</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]} onPress={() => setAddChargerModal(false)}>
                  <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KbSheet>
        </View>
      )}

      {/* ── Registro cuenta de dispersión (dueño) ── */}
      {addDisbModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setAddDisbModal(false)} activeOpacity={1} />
          <KbSheet>
            <ScrollView contentContainerStyle={styles.modal}>
              <View style={styles.mapPanelHandle} />
              <Text style={styles.modalTitle}>Cuenta para recibir pagos</Text>
              <Text style={styles.mapPanelLocation}>Aquí llegará tu parte al terminar cada sesión de carga.</Text>

              {/* Tipo de cuenta */}
              <View style={[styles.roleRow, { marginTop: 16 }]}>
                {['NEQUI', 'BANK'].map(t => (
                  <TouchableOpacity key={t} style={[styles.roleBtn, disbForm.type === t && styles.roleBtnActive]} onPress={() => setDisbForm(f => ({...f, type: t}))}>
                    <Text style={[styles.roleBtnText, disbForm.type === t && styles.roleBtnTextActive]}>
                      {t === 'NEQUI' ? '📱 Nequi' : '🏦 Cuenta Bancaria'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ gap: 10, marginTop: 16 }}>
                <TextInput style={styles.input} placeholder="Nombre completo del titular" placeholderTextColor={T.textMuted} value={disbForm.holder_name} onChangeText={v => setDisbForm(f=>({...f,holder_name:v}))} autoCapitalize="words" />
                <TextInput style={styles.input} placeholder="Cédula (solo números)" placeholderTextColor={T.textMuted} value={disbForm.holder_id} onChangeText={v => setDisbForm(f=>({...f,holder_id:v.replace(/\D/g,'')}))} keyboardType="numeric" maxLength={12} />

                {disbForm.type === 'NEQUI' ? (
                  <>
                    <TextInput
                      style={[styles.input, disbForm.phone.length > 0 && disbForm.phone.length < 10 && { borderColor: T.warning }]}
                      placeholder="Número celular Nequi (10 dígitos)"
                      placeholderTextColor={T.textMuted}
                      value={disbForm.phone}
                      onChangeText={v => setDisbForm(f=>({...f,phone:v.replace(/\D/g,'')}))}
                      keyboardType="phone-pad"
                      maxLength={10}
                    />
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>Sandbox: usa 3991111111</Text>
                  </>
                ) : (
                  <>
                    <TextInput style={styles.input} placeholder="Número de cuenta" placeholderTextColor={T.textMuted} value={disbForm.account_number} onChangeText={v => setDisbForm(f=>({...f,account_number:v}))} keyboardType="number-pad" maxLength={20} />
                    <TextInput style={styles.input} placeholder="Código banco (ej: 1007)" placeholderTextColor={T.textMuted} value={disbForm.bank_code} onChangeText={v => setDisbForm(f=>({...f,bank_code:v}))} keyboardType="number-pad" maxLength={4} />
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>
                      Bancolombia: 1007 · Davivienda: 1051 · Bogotá: 1006{'\n'}BBVA: 1040 · Colpatria: 1019 · AV Villas: 1052
                    </Text>
                    <View style={styles.roleRow}>
                      {[['SAVINGS','Ahorros'], ['CHECKING','Corriente']].map(([v,l]) => (
                        <TouchableOpacity key={v} style={[styles.roleBtn, disbForm.account_type === v && styles.roleBtnActive]} onPress={() => setDisbForm(f=>({...f,account_type:v}))}>
                          <Text style={[styles.roleBtnText, disbForm.account_type === v && styles.roleBtnTextActive]}>{l}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={saveDisbAccount}>
                  <Feather name="check" size={16} color="#fdfbf7" />
                  <Text style={styles.btnText}>Guardar y verificar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]} onPress={() => setAddDisbModal(false)}>
                  <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KbSheet>
        </View>
      )}

      {/* ── Detalle de sesión ── */}
      {sessionDetail && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setSessionDetail(null)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <View>
                <Text style={styles.modalTitle}>{sessionDetail.charger_id}</Text>
                <Text style={styles.mapPanelLocation}>{sessionDetail.location}</Text>
              </View>
              <Text style={{ color: T.textMuted, fontSize: 12 }}>
                {new Date(sessionDetail.ended_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
              </Text>
            </View>

            {/* KWh grande */}
            <View style={{ alignItems: 'center', paddingVertical: 20, backgroundColor: T.surface, borderRadius: 16, marginBottom: 14, borderWidth: 1, borderColor: T.cardBorder }}>
              <Text style={{ color: T.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>Energía entregada</Text>
              <Text style={{ color: T.green, fontSize: 48, fontWeight: '800', letterSpacing: -2 }}>{sessionDetail.kwh_delivered}</Text>
              <Text style={{ color: T.textSec, fontSize: 20, fontWeight: '600', marginTop: -4 }}>kWh</Text>
            </View>

            {/* Estado del pago */}
            {(() => {
              const ps = sessionDetail.payment_status;
              if (!ps || ps === 'unknown') return null;
              const cfg = {
                CAPTURED: { icon: 'check-circle', color: T.green,      bg: T.greenFaint,  label: 'Pago exitoso' },
                UNPAID:   { icon: 'x-circle',     color: T.dangerText, bg: '#fbe7e7',     label: 'Cobro fallido — tarjeta rechazada' },
                PENDING:  { icon: 'clock',         color: T.warningText,bg: T.warningBg,   label: 'Procesando pago...' },
                APPROVED: { icon: 'clock',         color: T.warningText,bg: T.warningBg,   label: 'Procesando pago...' },
              }[ps] || { icon: 'minus-circle', color: T.textMuted, bg: T.surface, label: 'Sin información de pago' };
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: cfg.bg,
                  borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: cfg.color + '40' }}>
                  <Feather name={cfg.icon} size={16} color={cfg.color} />
                  <Text style={{ color: cfg.color, fontWeight: '600', fontSize: 13 }}>{cfg.label}</Text>
                </View>
              );
            })()}

            {/* Desglose */}
            {[
              { label: 'Total cobrado', value: `$ ${(sessionDetail.total_charged || 0).toLocaleString('es-CO')} COP`, highlight: true },
              { label: 'Precio base', value: `$ ${(sessionDetail.price_per_kwh || 0).toLocaleString('es-CO')} / kWh` },
              { label: 'Duración', value: sessionDetail.started_at
                  ? `${Math.round((new Date(sessionDetail.ended_at) - new Date(sessionDetail.started_at)) / 60000)} min`
                  : '—' },
              { label: 'Inicio', value: sessionDetail.started_at ? new Date(sessionDetail.started_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : '—' },
              { label: 'Fin', value: new Date(sessionDetail.ended_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) },
            ].map(r => (
              <View key={r.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: T.cardBorder }}>
                <Text style={{ color: T.textMuted, fontSize: 13 }}>{r.label}</Text>
                <Text style={{ color: r.highlight ? T.green : T.textPri, fontWeight: r.highlight ? '800' : '500', fontSize: 13 }}>{r.value}</Text>
              </View>
            ))}

            <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 16 }]} onPress={() => setSessionDetail(null)}>
              <Text style={[styles.btnText, { color: T.textMuted }]}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Renombrar método de pago ── */}
      {renameModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setRenameModal(null)} activeOpacity={1} />
          <KbSheet>
            <View style={styles.modal}>
              <View style={styles.mapPanelHandle} />
              <Text style={styles.modalTitle}>Ponerle nombre</Text>
              <Text style={[styles.mapPanelLocation, { marginBottom: 16 }]}>{renameModal.method.display}</Text>
              <TextInput
                style={styles.input}
                placeholder="Ej: Tarjeta sin fondo, Nequi personal…"
                placeholderTextColor={T.textMuted}
                value={renameModal.value}
                onChangeText={v => setRenameModal(r => ({ ...r, value: v }))}
                autoFocus
                autoCapitalize="sentences"
                maxLength={30}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={renameMethod}>
                  <Feather name="check" size={16} color="#fdfbf7" />
                  <Text style={styles.btnText}>Guardar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]} onPress={() => setRenameModal(null)}>
                  <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KbSheet>
        </View>
      )}

      {/* ── Confirmación antes de iniciar carga ── */}
      {confirmPayModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setConfirmPayModal(null)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>Confirmar carga</Text>

            {/* Cargador */}
            <View style={{ backgroundColor: T.surface, borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: T.cardBorder }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Feather name="zap" size={14} color={T.green} />
                <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 14 }}>{confirmPayModal.charger.id}</Text>
              </View>
              <Text style={{ color: T.textMuted, fontSize: 13 }}>{confirmPayModal.charger.location}</Text>
              {confirmPayModal.charger.price_per_kwh && (
                <Text style={{ color: T.textSec, fontSize: 12, marginTop: 4 }}>
                  $ {Math.round(confirmPayModal.charger.price_per_kwh * 1.10 * 1.19 * 1.03).toLocaleString('es-CO')} / kWh · {confirmPayModal.charger.power_kw} kW
                </Text>
              )}
            </View>

            {/* Tarjeta */}
            <View style={{ backgroundColor: T.surface, borderRadius: 12, padding: 14, marginTop: 10, borderWidth: 1, borderColor: T.cardBorder, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Feather name="credit-card" size={16} color={T.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textPri, fontWeight: '600', fontSize: 13 }}>
                  {confirmPayModal.method.nickname || confirmPayModal.method.display}
                </Text>
                {confirmPayModal.method.nickname && (
                  <Text style={{ color: T.textMuted, fontSize: 11 }}>{confirmPayModal.method.display}</Text>
                )}
              </View>
            </View>

            {/* Aviso de cobro */}
            <View style={{ backgroundColor: T.greenFaint, borderRadius: 10, padding: 12, marginTop: 10, borderWidth: 1, borderColor: T.greenDark }}>
              <Text style={{ color: T.greenLight, fontSize: 12, lineHeight: 18 }}>
                <Text style={{ fontWeight: '700' }}>El cobro se realiza al terminar la sesión.</Text>{'\n'}
                Mínimo $1.500 COP por política de la pasarela de pago.
              </Text>
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btn, styles.btnStart, { flex: 1 }]}
                onPress={() => { const { method, charger } = confirmPayModal; setConfirmPayModal(null); payWithMethod(method, charger); }}
              >
                <Feather name="zap" size={16} color="#fdfbf7" />
                <Text style={styles.btnText}>Iniciar carga</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { flex: 0.5 }]}
                onPress={() => setConfirmPayModal(null)}
              >
                <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* ── Confirmando pago con tarjeta ── */}
      {paymentPending && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, { alignItems: 'center' }]}>
            <View style={styles.mapPanelHandle} />
            <ActivityIndicator size="large" color={T.green} />
            <Text style={[styles.modalTitle, { marginTop: 16, textAlign: 'center' }]}>Confirmando pago...</Text>
            <Text style={[styles.mapPanelLocation, { textAlign: 'center', marginTop: 8 }]}>
              Procesando tu tarjeta con el banco.{'\n'}La carga iniciará en segundos.
            </Text>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary, { width: '100%', marginTop: 24 }]} onPress={() => setPaymentPending(null)}>
              <Text style={[styles.btnText, { color: T.textMuted }]}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Boot ──────────────────────────────────────────────────────────────────
  bootScreen:  { flex: 1, backgroundColor: T.bg, justifyContent: 'center', alignItems: 'center' },

  // ── Auth ──────────────────────────────────────────────────────────────────
  authContainer:     { flex: 1 },
  authBg:            { flex: 1 },
  authSpacer:        { height: 200 },
  authKeyboard:      { flex: 1 },
  authCard:          { flex: 1, backgroundColor: 'rgba(250,247,241,0.97)', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  authInner:         { padding: 28, paddingBottom: 24, flexGrow: 1 },
  authBottomSpacer:  { height: 80, backgroundColor: 'rgba(250,247,241,0.97)' },
  authLogoWrap:      { width: 64, height: 64, borderRadius: 32, backgroundColor: T.greenFaint, borderWidth: 1, borderColor: T.greenDark, justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginBottom: 16 },
  authTitle:         { color: T.textPri, fontSize: 26, fontWeight: '800', textAlign: 'center', letterSpacing: -0.5 },
  authSub:           { color: T.textMuted, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 28 },
  authTabs:          { flexDirection: 'row', backgroundColor: T.surface, borderRadius: 12, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: T.cardBorder },
  authTab:           { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  authTabActive:     { backgroundColor: T.greenDark },
  authTabText:       { color: T.textMuted, fontWeight: '600', fontSize: 14 },
  authTabTextActive: { color: '#fdfbf7' },
  authForm:          { gap: 12 },
  input:             { backgroundColor: T.surface, borderRadius: 14, padding: 16, color: T.textPri, fontSize: 16, borderWidth: 1, borderColor: T.cardBorder },
  roleRow:           { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  roleLabel:         { color: T.textSec, fontSize: 13 },
  roleBtn:           { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 22, borderWidth: 1, borderColor: T.cardBorder },
  roleBtnActive:     { backgroundColor: T.greenFaint, borderColor: T.green },
  roleBtnText:       { color: T.textMuted, fontSize: 13, fontWeight: '600' },
  roleBtnTextActive: { color: T.green },
  authError:         { color: '#b91c1c', fontSize: 13, textAlign: 'center' },
  authSubmit:        { backgroundColor: T.greenDark, padding: 16, borderRadius: 14, alignItems: 'center', marginTop: 8, height: 54, justifyContent: 'center', borderWidth: 1, borderColor: T.green },
  authSubmitText:    { color: '#fdfbf7', fontWeight: '700', fontSize: 16, letterSpacing: 0.3 },
  seedHint:          { marginTop: 20, gap: 5, paddingTop: 16, borderTopWidth: 1, borderTopColor: T.cardBorder },
  seedText:          { color: T.textMuted, fontSize: 11, textAlign: 'center' },

  // ── Layout principal ──────────────────────────────────────────────────────
  container:      { flex: 1, backgroundColor: T.bg },
  header:         { paddingHorizontal: 20, paddingTop: 54, paddingBottom: 14,
                    borderBottomWidth: 1, borderBottomColor: T.cardBorder,
                    shadowColor: '#2b2520', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
                    elevation: 4, zIndex: 10 },
  headerDriver:   { backgroundColor: T.headerDriver },
  headerOwner:    { backgroundColor: T.headerOwner },
  headerTop:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle:    { color: T.textPri, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  headerSub:      { color: T.textMuted, fontSize: 12, marginTop: 2 },
  userBadge:      { width: 34, height: 34, borderRadius: 17, backgroundColor: T.charging, justifyContent: 'center', alignItems: 'center' },
  userBadgeOwner: { backgroundColor: T.greenDark },
  userInitial:    { color: '#fdfbf7', fontWeight: '700', fontSize: 15 },
  rolePill:       { alignSelf: 'flex-start', marginTop: 10, backgroundColor: 'rgba(43,37,32,0.05)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(43,37,32,0.05)' },
  rolePillText:   { color: T.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  statsRow:       { flexDirection: 'row', gap: 8, marginTop: 10 },
  statPill:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(43,37,32,0.05)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  statDot:        { width: 6, height: 6, borderRadius: 3 },
  statText:       { color: T.textPri, fontSize: 11, fontWeight: '600' },
  searchBar:      { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(43,37,32,0.05)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginTop: 10, borderWidth: 1, borderColor: 'rgba(43,37,32,0.10)' },
  searchInput:    { flex: 1, color: T.textPri, fontSize: 13, padding: 0 },
  serverError:    { color: '#b91c1c', fontSize: 11, marginTop: 6 },
  lastUpdate:     { color: T.textMuted, fontSize: 10, marginTop: 3 },

  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabs:          { flexDirection: 'row', marginTop: 14 },
  tabBtn:        { flex: 1, paddingVertical: 11, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive:     { borderBottomColor: T.green },
  tabText:       { color: T.textMuted, fontWeight: '600', fontSize: 13 },
  tabTextActive: { color: T.green },

  // ── Tarjetas ──────────────────────────────────────────────────────────────
  list:       { padding: 14, gap: 10, paddingBottom: 76 },
  card:       { backgroundColor: T.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: T.cardBorder },
  cardMine:   { borderColor: T.green, borderWidth: 1.5 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  dot:        { width: 8, height: 8, borderRadius: 4 },
  chargerId:  { color: T.textPri, fontWeight: '700', fontSize: 15, flex: 1, letterSpacing: 0.3 },
  ownerBadge: { backgroundColor: T.surface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: T.cardBorder },
  ownerText:  { color: T.textMuted, fontSize: 11 },
  mineBadge:  { backgroundColor: T.greenFaint, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: T.greenDark },
  mineText:   { color: T.green, fontSize: 11, fontWeight: '700' },
  location:   { color: T.textMuted, fontSize: 13, marginBottom: 10, marginLeft: 16 },
  statusRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  statusText: { fontWeight: '700', fontSize: 13 },
  txText:     { color: T.textMuted, fontSize: 11 },

  // ── Specs ─────────────────────────────────────────────────────────────────
  specsRow:       { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  specChip:       { backgroundColor: T.surface, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: T.cardBorder },
  specText:       { color: T.textSec, fontSize: 11, fontWeight: '700' },
  specChipPrice:  { backgroundColor: T.greenFaint, borderColor: T.greenDark },
  specTextPrice:  { color: T.greenLight },

  // Chips técnicos en tarjeta de dueño
  techChip:      { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.surface,
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: T.cardBorder },
  techChipText:  { color: T.textSec, fontSize: 11, fontWeight: '600' },

  // ── Sesión activa ─────────────────────────────────────────────────────────
  sessionBox:   { backgroundColor: T.bg, borderRadius: 12, padding: 14, marginBottom: 10, gap: 8, borderWidth: 1, borderColor: T.cardBorder },
  sessionRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sessionLabel: { color: T.textMuted, fontSize: 12 },
  sessionValue: { color: T.textPri, fontSize: 13, fontWeight: '600' },
  sessionCost:  { color: T.green, fontSize: 15, fontWeight: '800' },

  // ── Botones ───────────────────────────────────────────────────────────────
  btn:         { marginTop: 12, paddingVertical: 14, borderRadius: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  btnStart:    { backgroundColor: T.greenDark, borderWidth: 1.5, borderColor: T.green },
  btnStop:     { backgroundColor: '#fbe7e7', borderWidth: 1.5, borderColor: '#b91c1c' },
  btnReserve:  { backgroundColor: T.surface, borderWidth: 1, borderColor: T.cardBorder },
  btnText:     { color: '#fdfbf7', fontWeight: '700', fontSize: 15, letterSpacing: 0.2 },

  // ── Píldora de sesión activa (flotante) ──────────────────────────────────
  sessionPill:      {
    position: 'absolute', bottom: 90, left: 16, right: 16,
    backgroundColor: T.chargingBg,
    borderRadius: 20, padding: 14, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1.5, borderColor: T.charging,
    shadowColor: T.charging, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 12,
    elevation: 8,
  },
  sessionPillDot:  {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: T.charging,
    shadowColor: T.charging, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 6,
  },
  sessionPillTitle: { color: T.textPri, fontWeight: '700', fontSize: 14 },
  sessionPillId:    { color: T.charging, fontWeight: '600', fontSize: 13, opacity: 0.9 },
  sessionPillStat:  { color: T.textMuted, fontSize: 12 },
  sessionPillStop:  { backgroundColor: '#fbe7e7', borderRadius: 10, padding: 8, borderWidth: 1, borderColor: '#b91c1c' },

  // ── Modals ────────────────────────────────────────────────────────────────
  modalOverlay:    { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', zIndex: 100, elevation: 100 },
  modal:           { backgroundColor: T.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 100, borderTopWidth: 1, borderTopColor: T.cardBorder },
  modalTitle:      { color: T.textPri, fontWeight: '800', fontSize: 20, marginBottom: 4 },
  modalActions:    { flexDirection: 'row', gap: 10, marginTop: 20 },
  btnSecondary:    { backgroundColor: 'rgba(43,37,32,0.05)', borderWidth: 1, borderColor: 'rgba(43,37,32,0.15)' },

  qrFrame:         { width: 200, height: 200, borderWidth: 2, borderColor: T.green, borderRadius: 16, justifyContent: 'center', alignItems: 'center', backgroundColor: T.surface, marginBottom: 16 },
  listHint:        { color: T.textMuted, fontSize: 11, marginTop: 8, textAlign: 'center' },
  methodRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: T.cardBorder },
  methodDisplay:   { color: T.textPri, fontWeight: '600', fontSize: 14 },
  methodDefault:   { color: T.green, fontSize: 11, marginTop: 2 },

  // ── Pantalla sesión activa ────────────────────────────────────────────────
  sessionScreen:    { flex: 1, padding: 24, justifyContent: 'center', gap: 24 },
  sessionKwhBox:    { alignItems: 'center', paddingVertical: 32, backgroundColor: T.card, borderRadius: 24, borderWidth: 1, borderColor: T.cardBorder },
  sessionKwhLabel:  { color: T.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  sessionKwhValue:  { color: T.green, fontSize: 64, fontWeight: '800', letterSpacing: -2 },
  sessionKwhUnit:   { color: T.textSec, fontSize: 28, fontWeight: '600' },
  sessionDivider:   { height: 1, backgroundColor: T.cardBorder },
  sessionStats:     { flexDirection: 'row', backgroundColor: T.card, borderRadius: 20, borderWidth: 1, borderColor: T.cardBorder, padding: 20 },
  sessionStat:      { flex: 1, alignItems: 'center' },
  sessionStatVal:   { color: T.textPri, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  sessionStatLbl:   { color: T.textMuted, fontSize: 11, marginTop: 4 },
  sessionStatSep:   { width: 1, backgroundColor: T.cardBorder },
  sessionPriceNote: { color: T.textMuted, fontSize: 12, textAlign: 'center' },
  sessionPulse:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  sessionPulseText: { color: T.textMuted, fontSize: 12 },
  sessionStopBtn:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#fbe7e7', borderRadius: 16, padding: 18, borderWidth: 1, borderColor: '#b91c1c' },
  sessionStopText:  { color: T.dangerText, fontWeight: '700', fontSize: 17 },

  // ── Empty state ───────────────────────────────────────────────────────────
  empty:     { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyText: { color: T.textSec, fontSize: 16, fontWeight: '600' },
  emptyHint: { color: T.textMuted, fontSize: 13, marginTop: 6, textAlign: 'center' },

  // ── Negocio ───────────────────────────────────────────────────────────────
  sectionTitle:       { color: T.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 12, marginBottom: 6 },
  earningsCard:       { backgroundColor: T.greenFaint, borderRadius: 16, padding: 22, marginBottom: 8, borderWidth: 1, borderColor: T.greenDark },
  earningsTitle:      { color: T.textSec, fontSize: 12, fontWeight: '600', marginBottom: 6, letterSpacing: 0.5 },
  earningsAmount:     { color: T.green, fontSize: 36, fontWeight: '800', marginBottom: 16, letterSpacing: -1 },
  earningsRow:        { flexDirection: 'row', justifyContent: 'space-between' },
  earningsStat:       { alignItems: 'center' },
  earningsStatVal:    { color: T.textPri, fontSize: 18, fontWeight: '700' },
  earningsStatLbl:    { color: T.textMuted, fontSize: 11, marginTop: 3 },
  priceRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, backgroundColor: T.bg, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: T.cardBorder },
  priceLabel:         { color: T.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 },
  priceValue:         { color: T.textPri, fontSize: 15, fontWeight: '700' },
  priceUserNote:      { color: T.textMuted, fontSize: 11, marginTop: 3 },
  priceEdit:          { color: T.green, fontWeight: '600', fontSize: 13 },

  plCard:    { backgroundColor: T.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: T.cardBorder, marginBottom: 8 },
  plRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.cardBorder },
  plLabel:   { color: T.textMuted, fontSize: 13 },
  plPos:     { color: T.green, fontWeight: '700', fontSize: 13 },
  plNeg:     { color: '#b91c1c', fontWeight: '700', fontSize: 13 },
  plTotal:   { borderBottomWidth: 0, marginTop: 4 },
  plTotalLabel: { color: T.textPri, fontWeight: '700', fontSize: 15 },
  plTotalVal:   { color: T.green, fontWeight: '800', fontSize: 17 },
  plNote:    { color: T.textMuted, fontSize: 11, marginTop: 12, lineHeight: 16 },
  priceEditor:        { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 },
  priceInput:         { flex: 1, backgroundColor: T.bg, borderRadius: 10, padding: 12, color: T.textPri, fontSize: 15, borderWidth: 1.5, borderColor: T.green },
  priceUnit:          { color: T.textMuted, fontSize: 12 },
  priceSave:          { backgroundColor: T.greenDark, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  priceSaveText:      { color: T.textPri, fontWeight: '700', fontSize: 13 },
  priceCancel:        { padding: 10 },
  sessionHistCard:    { backgroundColor: T.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: T.cardBorder },
  sessionHistHeader:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  sessionHistId:      { color: T.textPri, fontWeight: '700', fontSize: 14 },
  sessionHistRevenue: { color: T.green, fontWeight: '800', fontSize: 14 },
  sessionHistLocation:{ color: T.textMuted, fontSize: 12, marginBottom: 8 },
  sessionHistRow:     { flexDirection: 'row', gap: 12 },
  sessionHistDetail:  { color: T.textMuted, fontSize: 12 },

  // ── Mapa ──────────────────────────────────────────────────────────────────
  map:              { flex: 1 },
  mapPin:           { width: 36, height: 36, borderRadius: 18, borderWidth: 3, backgroundColor: '#1a1710', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },
  mapPinSelected:   { width: 44, height: 44, borderRadius: 22, borderWidth: 3.5 },
  mapPinDot:        { width: 14, height: 14, borderRadius: 7, position: 'absolute' },
  mapPinMark:       { width: 9, height: 9, borderRadius: 5, backgroundColor: T.green, position: 'absolute', top: -2, right: -2 },

  // ── Selector de ubicación ─────────────────────────────────────────────────
  locPickerPin:       { position: 'absolute', top: '50%', left: '50%',
    transform: [{ translateX: -19 }, { translateY: -42 }], alignItems: 'center', zIndex: 10 },
  locPickerShadow:    { width: 12, height: 6, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.25)', marginTop: 2 },
  locPickerTopCard:   {
    position: 'absolute', top: 56, left: 16, right: 16,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 14, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 4,
  },
  locPickerBottomCard:{ position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: T.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 20, paddingBottom: 36, borderTopWidth: 1, borderTopColor: T.cardBorder,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8,
  },

  // ── Mapa — burbujas de marcadores (estilo Airbnb) ────────────────────────
  mapBubble:        {
    borderRadius: 22, paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.28, shadowRadius: 6,
    elevation: 6,
  },
  mapBubbleStatusDot: { width: 7, height: 7, borderRadius: 4 },
  mapBubbleTip:     {
    width: 0, height: 0, backgroundColor: 'transparent', borderStyle: 'solid',
    borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    marginTop: -1,
  },

  // ── Mapa — buscador flotante ──────────────────────────────────────────────
  mapSearchWrap:    { position: 'absolute', top: 14, left: 14, right: 14, zIndex: 200 },
  mapSearchBox:     {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#ffffff', borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 11,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 8,
    elevation: 8,
  },
  mapSearchInput:   { flex: 1, fontSize: 15, color: '#2b2520', padding: 0 },
  mapSearchDropdown:{ backgroundColor: '#ffffff', borderRadius: 14, marginTop: 6, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 6 },
  mapSearchItem:    { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  mapSearchItemId:  { color: '#2b2520', fontWeight: '700', fontSize: 14 },
  mapSearchItemLoc: { color: '#94866f', fontSize: 12, marginTop: 1 },
  mapSearchItemPrice:{ color: T.green, fontSize: 12, fontWeight: '700' },

  // ── Mapa — tira de cargadores ─────────────────────────────────────────────
  mapStrip:         { position: 'absolute', bottom: 70, left: 0, right: 0, zIndex: 100 },
  mapStripCard:     {
    backgroundColor: T.card, borderRadius: 16, padding: 14, width: 180,
    borderWidth: 1, borderColor: T.cardBorder,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 5,
  },
  mapStripId:       { color: T.textPri, fontWeight: '700', fontSize: 13 },
  mapStripLocation: { color: T.textMuted, fontSize: 12, marginBottom: 4 },
  mapStripPrice:    { color: T.green, fontWeight: '800', fontSize: 14 },
  mapStripChip:     { backgroundColor: T.surface, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: T.cardBorder },
  mapStripChipText: { color: T.textSec, fontSize: 10, fontWeight: '700' },

  mapPanel:         { position: 'absolute', bottom: 62, left: 0, right: 0, backgroundColor: T.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 24, borderTopWidth: 1, borderTopColor: T.cardBorder, elevation: 30, shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.5, shadowRadius: 16, zIndex: 100 },

  bottomBar:        { position: 'absolute', bottom: 0, left: 0, right: 0, height: 62, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.cardBorder, flexDirection: 'row', elevation: 20, zIndex: 50 },
  bottomTab:        { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  bottomTabLabel:   { color: T.textMuted, fontSize: 10, fontWeight: '600' },
  bottomTabLabelActive: { color: T.greenLight },
  mapPanelHandle:   { width: 36, height: 4, backgroundColor: T.cardBorder, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  mapPanelHeader:   { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  mapPanelId:       { color: T.textPri, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  mapPanelLocation: { color: T.textMuted, fontSize: 13, marginTop: 3 },
  mapPanelPrice:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: T.surface, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: T.cardBorder },
  mapPanelPriceVal: { color: T.green, fontSize: 18, fontWeight: '800' },
  mapPanelPriceNote:{ color: T.textMuted, fontSize: 11, marginTop: 3 },
  mapPanelActions:  { flexDirection: 'row', gap: 10 },
  btnReserve:       { borderWidth: 1.5, borderColor: T.greenDark, backgroundColor: T.greenFaint },
  callout:          { backgroundColor: T.card, borderRadius: 12, padding: 14, minWidth: 180, borderWidth: 1, borderColor: T.cardBorder },
  calloutMine:      { borderColor: T.green },
  calloutId:        { color: T.textPri, fontWeight: '700', fontSize: 14 },
  calloutMineBadge: { backgroundColor: T.greenFaint, color: T.green, fontSize: 10, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  calloutLocation:  { color: T.textMuted, fontSize: 12, marginBottom: 6 },
  calloutStatus:    { fontWeight: '700', fontSize: 13, marginBottom: 4 },
  calloutSpec:      { color: T.textSec, fontSize: 11, backgroundColor: T.surface, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  calloutKwh:       { color: T.green, fontSize: 12, marginTop: 6, fontWeight: '700' },
  calloutOwner:     { color: T.textMuted, fontSize: 11, marginTop: 6 },
});
