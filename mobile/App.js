import React, { useEffect, useState, useCallback, useMemo, memo, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TextInput,
  TouchableOpacity, RefreshControl, StatusBar, Alert,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  ImageBackground, Image, Linking, Keyboard, Animated, Vibration, Easing,
} from 'react-native';
import MapView, { Marker, Callout } from 'react-native-maps';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import Svg, { Path, Rect } from 'react-native-svg';

// ── Módulos extraídos (ver src/) ──
import { T, STATUS_COLOR } from './src/theme';
import { API_URL, apiFetch, apiUpload } from './src/api';
import { MEDELLIN, formatElapsed, IVA_RATE, PLATFORM_MARGIN } from './src/constants';
import { AppCtx } from './src/context/AppContext';
import { MiUsoScreen } from './src/screens/MiUsoScreen';
import { NegocioScreen } from './src/screens/NegocioScreen';
import { ListScreen } from './src/screens/ListScreen';
import { DescubreScreen } from './src/screens/DescubreScreen';
import { MapScreen } from './src/screens/MapScreen';
import { KbSheet } from './src/hooks';
import { useUserLocation, nearestCharger, openDirections, formatDistance, haversineKm } from './src/geo';
import { FaroLogo } from './src/components/FaroLogo';
import { ChargerMarker } from './src/components/ChargerMarker';
import { AuthScreen } from './src/components/AuthScreen';
import { BootSplash } from './src/components/BootSplash';
import { SlideUp } from './src/components/SlideUp';
import { PhotoViewer } from './src/components/PhotoViewer';
import { UnitsModal } from './src/components/UnitsModal';
import { JoinUnitModal } from './src/components/JoinUnitModal';
import { ProfileModal } from './src/components/ProfileModal';
import { styles } from './src/styles';

export default function App() {
  const [token, setToken]       = useState(null);
  const [user, setUser]         = useState(null);
  const [booting, setBooting]   = useState(true);
  const [simRunning, setSimRunning] = useState([]);   // simuladores corriendo (faltaba declararlo)

  const [chargers, setChargers]     = useState([]);
  const [archivedChargers, setArchivedChargers] = useState([]);  // dados de baja (dueño)
  const [units, setUnits]           = useState([]);   // unidades del dueño
  const [myUnitIds, setMyUnitIds]   = useState([]);   // unidades a las que pertenece el conductor
  const [unitsModal, setUnitsModal] = useState(false);
  const [joinUnitModal, setJoinUnitModal] = useState(false);
  const [profileModal, setProfileModal] = useState(false);
  const [avatarBust, setAvatarBust]     = useState(0);  // cache-buster del avatar
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
  const [wallet, setWallet]               = useState(null);   // saldo prepago
  const [recargaModal, setRecargaModal]   = useState(false);
  const [recargaAmount, setRecargaAmount] = useState(50000);
  const [recargando, setRecargando]       = useState(false);   // bloquea doble-recarga
  const [payMethodsModal, setPayMethodsModal] = useState(null);
  const [confirmPayModal, setConfirmPayModal] = useState(null); // { method, charger }
  const [addMethodModal, setAddMethodModal]   = useState(null); // 'card' | 'nequi'
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
  const [sessionDetail, setSessionDetail] = useState(null); // sesión seleccionada para ver detalle
  const [ratePrompt, setRatePrompt]       = useState(null); // {sessionId, kwh, cost} → calificar al terminar la carga
  const [sessionsShown, setSessionsShown] = useState(5);    // paginación local (conductor)
  const [ownerSessionsShown, setOwnerSessionsShown] = useState(6);  // paginación (dueño)
  const [myDisburses, setMyDisburses]     = useState(null);
  const [addChargerModal, setAddChargerModal] = useState(false);
  const [chargerForm, setChargerForm]     = useState({
    id: null, location: '', lat: '', lng: '', power_kw: '', connector_type: 'Type 2',
    price_per_kwh: '', peak_per_kwh: '', cost_per_kwh: '', brand_profile_id: null,
  });
  const [brandProfiles, setBrandProfiles] = useState([]);
  const [statsPeriod, setStatsPeriod]     = useState('week');   // today | week | month
  const [myStats, setMyStats]             = useState(null);
  const [ownerEvents, setOwnerEvents]     = useState(null);
  const [mySubscription, setMySubscription] = useState(null);
  const [locationPicker, setLocationPicker] = useState(null); // { lat, lng, address }
  const locPickerTimeout                    = useRef(null);
  const [disbForm, setDisbForm]   = useState({ type:'NEQUI', phone:'', account_number:'', bank_code:'', account_type:'SAVINGS', holder_name:'', holder_id:'' });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [serverOk, setServerOk]     = useState(null);
  const [tab, setTab]               = useState('mapa');
  const [search, setSearch]         = useState('');
  const [mapSearch, setMapSearch]   = useState('');
  const [modelSearch, setModelSearch] = useState('');  // buscador de modelo en el form
  const [geoResults, setGeoResults] = useState([]);  // resultados de lugares reales
  const [zoom, setZoom]             = useState('mid');
  const [mapRegion, setMapRegion]   = useState(null);  // región visible (para culling en Android)
  const mapRef                      = useRef(null);
  const stoppingRef                 = useRef(false);   // guard de doble "Detener"
  const { coords: userCoords, status: locStatus, loading: locLoading, request: requestLocation } = useUserLocation();
  const stripRef                    = useRef(null);
  const geoTimeout                  = useRef(null);
  const [selectedCharger, setSelectedCharger] = useState(null); // para mapa (pin highlight)
  const [chargerPanel, setChargerPanel] = useState(null);       // panel de acciones (lista + mapa)
  const [chargerPhotos, setChargerPhotos] = useState({});       // { [chargerId]: [{id,url}] } fotos del cargador
  const [photoBusy, setPhotoBusy] = useState(null);             // id del cargador subiendo foto
  const [photoView, setPhotoView] = useState(null);             // {url} foto en pantalla completa
  const [qrModal, setQrModal]       = useState(null);
  const [qrScanning, setQrScanning] = useState(false);
  const [myUsage, setMyUsage]       = useState(null);

  // Restore session
  useEffect(() => {
    const startedAt = Date.now();
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
        // Splash ~3 s: ~1.5 s creciendo el logo + ~1.5 s quieto para que todo
        // (logo, caché, datos) termine de cargar antes de entrar.
        const elapsed = Date.now() - startedAt;
        setTimeout(() => setBooting(false), Math.max(0, 3000 - elapsed));
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
    setProfileModal(false);
  };

  // ── Perfil ──────────────────────────────────────────────────────────────────
  const persistUser = async (u) => { setUser(u); try { await SecureStore.setItemAsync('user', JSON.stringify(u)); } catch {} };
  const updateName = async (name) => { const u = await apiFetch('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }, token); await persistUser(u); };
  const changePassword = async (current_password, new_password) => {
    await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) }, token);
  };
  const removeAvatar = async () => { const u = await apiFetch('/auth/avatar', { method: 'DELETE' }, token); await persistUser(u); setAvatarBust(b => b + 1); };
  const uploadAvatar = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permiso', 'Necesito acceso a tus fotos.'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.6 });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      const u = await apiUpload('/auth/avatar', { uri: a.uri, name: a.fileName || 'avatar.jpg', type: a.mimeType || 'image/jpeg' }, token);
      await persistUser(u); setAvatarBust(b => b + 1);
    } catch (e) { Alert.alert('No se pudo subir', e.message); }
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

  const fetchReservations = async () => {
    try {
      const data = await apiFetch('/my-reservations', {}, token);
      setReservations(data.reservations || []);
    } catch {}
  };

  useEffect(() => {
    if (!token) return;
    fetchStatus(true);
    fetchReservations();
    const interval = setInterval(() => { fetchStatus(false); fetchReservations(); }, 5000);
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
          const price = (ch.price_per_kwh_now ?? ch.price_per_kwh ?? 0) * 1.19;
          const cost  = Math.round(kwh * price);
          setActiveSession(null); setSessionModal(false);
          // Traer la sesión recién cerrada para poder calificarla en el prompt
          let sid = null;
          try {
            const u = await apiFetch('/my-sessions', {}, token);
            setMyUsage(u);
            sid = u.sessions?.[0]?.id ?? null;
          } catch {}
          setRatePrompt({ sessionId: sid, kwh, cost });
          // Refrescar saldo y avisar si quedó bajo (la carga pudo cortarse por saldo)
          try {
            const w = await apiFetch('/wallet', {}, token);
            setWallet(w);
            if ((w.balance_cop ?? 0) < 5000) {
              Alert.alert('Saldo bajo', 'Tu saldo quedó bajo. Recarga para volver a cargar.');
            }
          } catch {}
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
  };

  // Calificación discreta 👍/👎 de una sesión (solo quien cargó)
  const rateSession = async (sessionId, good) => {
    try {
      await apiFetch(`/my-sessions/${sessionId}/rate`, { method: 'POST', body: JSON.stringify({ good }) }, token);
      setSessionDetail(sd => (sd && sd.id === sessionId) ? { ...sd, my_rating: good } : sd);
      fetchMyUsage();
    } catch (e) { Alert.alert('No se pudo calificar', e.message); }
  };

  const fetchWallet = async () => {
    try { setWallet(await apiFetch('/wallet', {}, token)); } catch {}
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
      fetchEarnings(); fetchDisbAccount(); fetchPaymentMethods();
      apiFetch('/my-disbursements', {}, token).then(setMyDisburses).catch(() => {});
      apiFetch('/my-balance', {}, token).then(setBalance).catch(() => {});
      apiFetch('/brand-profiles', {}, token).then(d => setBrandProfiles(d.profiles || [])).catch(() => {});
      apiFetch('/my-events', {}, token).then(setOwnerEvents).catch(() => {});
      apiFetch('/my-subscription', {}, token).then(setMySubscription).catch(() => {});
      apiFetch('/my-stats?period=week', {}, token).then(setMyStats).catch(() => {});  // solo para la gráfica de 7 días
    }
    if (tab === 'miuso')   { fetchMyUsage(); fetchPaymentMethods(); fetchWallet(); }
    if (tab === 'lista' && isOwner) { fetchArchivedChargers(); fetchUnits(); }
    if (!isOwner && token) { fetchPaymentMethods(); fetchWallet(); fetchMemberships(); }
  }, [tab, token]);


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
    setSelectedCharger(null);
    startChargeWallet(charger);
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
      if (isOwner) apiFetch('/my-subscription', {}, token).then(setMySubscription).catch(() => {});
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

  // Iniciar carga contra el SALDO prepago (modo wallet)
  const startChargeWallet = async (charger) => {
    try {
      const data = await apiFetch('/payments/initiate', {
        method: 'POST', body: JSON.stringify({ charger_id: charger.id }),
      }, token);
      if (data.status === 'APPROVED') {
        setActiveSession({ chargerId: charger.id, startTime: Date.now(), charger });
        setSessionModal(true);
        fetchStatus();
      } else {
        Alert.alert('No se pudo iniciar', 'Intenta de nuevo.');
      }
    } catch (e) {
      if (/saldo insuficiente/i.test(e.message)) {
        Alert.alert('Saldo insuficiente', e.message, [
          { text: 'Recargar saldo', onPress: () => { setSelectedCharger(null); setChargerPanel(null); setQrModal(null); setTab('miuso'); setRecargaModal(true); } },
          { text: 'Cancelar', style: 'cancel' },
        ]);
      } else { Alert.alert('Error', e.message); }
    }
  };

  // Solicitar devolución del saldo reembolsable (se procesa manualmente)
  const requestRefund = () => {
    const r = wallet?.refundable_cop ?? 0;
    const cost = wallet?.refund_cost_cop ?? 0;
    if (r <= 0) { Alert.alert('Sin saldo reembolsable', 'Solo se devuelve el dinero que recargaste (no los bonos).'); return; }
    Alert.alert(
      'Solicitar devolución',
      `Te devolveremos $ ${r.toLocaleString('es-CO')} COP (tu saldo recargado menos $ ${cost.toLocaleString('es-CO')} de costo de procesamiento; los bonos no se devuelven).\n\nTe contactaremos para hacer la transferencia.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Solicitar', onPress: async () => {
          try {
            await apiFetch('/wallet/refund-request', { method: 'POST' }, token);
            Alert.alert('Solicitud enviada', 'Recibimos tu solicitud. Te contactaremos para devolverte el saldo.');
          } catch (e) { Alert.alert('No se pudo', e.message); }
        }},
      ]
    );
  };

  // Recargar saldo (1 cargo a la tarjeta guardada). Bloquea doble-submit.
  const doTopup = async (amount_cop, method) => {
    if (recargando) return;
    setRecargando(true);
    try {
      const r = await apiFetch('/wallet/topup', {
        method: 'POST', body: JSON.stringify({ amount_cop, payment_method_id: method.id }),
      }, token);
      setRecargaModal(false);
      Alert.alert('¡Recarga exitosa!', `Tu saldo ahora es $ ${r.balance_cop.toLocaleString('es-CO')} COP.`);
      fetchWallet();
    } catch (e) { Alert.alert('No se pudo recargar', e.message); }
    finally { setRecargando(false); }
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

  // Culling: en Android renderiza solo lo visible (+50% de margen) para que el mapa
  // vuele. En iOS render todo (Apple Maps + pines congelados ya es fluido y estable,
  // y desmontar hermanos allá podría dejar pines en blanco — ver lección de marcadores).
  const inView = useCallback((lat, lng) => {
    if (Platform.OS !== 'android' || !mapRegion || lat == null || lng == null) return true;
    return Math.abs(lat - mapRegion.latitude)  <= mapRegion.latitudeDelta  * 0.75
        && Math.abs(lng - mapRegion.longitude) <= mapRegion.longitudeDelta * 0.75;
  }, [mapRegion]);

  // Tap en un faro (mapa): háptica + vuelo de cámara + abre el sheet (confiable; el
  // onPress del mapa limpia selectedCharger, pero NO chargerPanel → el panel no se
  // cierra solo). selectedCharger queda solo para resaltar el pin.
  const tapCharger = (c) => {
    Haptics.selectionAsync().catch(() => {});
    setSelectedCharger(c); setChargerPanel(c); setMapSearch('');
    if (c.lat != null && c.lng != null) {
      mapRef.current?.animateCamera({ center: { latitude: c.lat, longitude: c.lng } }, { duration: 350 });
    }
  };

  // ── Fotos del cargador ──────────────────────────────────────────────────────
  const photoUri = (p) => `${API_URL}${p.url}`;                 // URL absoluta para <Image>
  const loadPhotos = useCallback(async (id) => {
    try {
      const d = await apiFetch(`/chargers/${id}/photos`, {}, token);
      setChargerPhotos(prev => ({ ...prev, [id]: d.photos || [] }));
    } catch {}
  }, [token]);

  const addPhoto = async (id) => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permiso', 'Necesito acceso a tus fotos para subirlas.'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsEditing: true, aspect: [4, 3], quality: 0.6,
      });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      setPhotoBusy(id);
      await apiUpload(`/chargers/${id}/photos`,
        { uri: a.uri, name: a.fileName || 'foto.jpg', type: a.mimeType || 'image/jpeg' }, token);
      await loadPhotos(id);
    } catch (e) { Alert.alert('No se pudo subir', e.message); }
    finally { setPhotoBusy(null); }
  };

  const removePhoto = (id, photoId) => {
    Alert.alert('Eliminar foto', '¿Quitar esta foto del cargador?', [
      { text: 'Cancelar' },
      { text: 'Eliminar', style: 'destructive', onPress: async () => {
        try { await apiFetch(`/chargers/${id}/photos/${photoId}`, { method: 'DELETE' }, token); await loadPhotos(id); }
        catch (e) { Alert.alert('Error', e.message); }
      } },
    ]);
  };

  // Al abrir el panel de un cargador (conductor o dueño), trae sus fotos.
  useEffect(() => {
    const id = chargerPanel?.id || selectedCharger?.id;
    if (id && token) loadPhotos(id);
  }, [chargerPanel?.id, selectedCharger?.id, token, loadPhotos]);

  // Para el dueño: precarga las fotos de sus propios cargadores (para las tarjetas).
  useEffect(() => {
    if (user?.role !== 'owner' || !token) return;
    chargers.filter(c => c.owner_id === user?.id)
            .forEach(c => { if (!chargerPhotos[c.id]) loadPhotos(c.id); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, token, chargers]);

  // Abre el modal unificado para AGREGAR (en blanco, costo por defecto)
  const openNewCharger = () => {
    setChargerForm({ id: null, name: '', icon: '', location: '', lat: '', lng: '', power_kw: '', connector_type: 'Type 2',
      price_per_kwh: '', peak_per_kwh: '', cost_per_kwh: '800', brand_profile_id: null, unit_id: null });
    setAddChargerModal(true);
  };
  // Abre el MISMO modal para EDITAR (precios mostrados como FINAL, IVA incl.)
  const openEditCharger = (c) => {
    setChargerForm({
      id: c.id, name: c.name || '', icon: c.icon || '',
      location: c.location || '', lat: String(c.lat ?? ''), lng: String(c.lng ?? ''),
      power_kw: String(c.power_kw ?? ''), connector_type: c.connector_type || 'Type 2',
      price_per_kwh: String(c.price_per_kwh ? Math.round(c.price_per_kwh * (1 + IVA_RATE)) : ''),
      peak_per_kwh: String(c.peak_price_per_kwh ? Math.round(c.peak_price_per_kwh * (1 + IVA_RATE)) : ''),
      cost_per_kwh: String(c.cost_per_kwh ?? ''), brand_profile_id: c.brand_profile_id || null,
      unit_id: c.unit_id || null,
    });
    setAddChargerModal(true);
  };

  // Guarda: crea (POST) o edita (PATCH). El precio/pico que escribe el dueño es FINAL
  // (IVA incl.) → se convierte a base (/1.19) antes de enviar.
  const saveCharger = async () => {
    const f = chargerForm;
    const finalPrice = parseFloat(String(f.price_per_kwh).replace(/\./g, '').replace(',', '.'));
    if (!f.location.trim() || !f.lat || !f.lng || !f.power_kw || !finalPrice) {
      Alert.alert('Campos incompletos', 'Completa ubicación, coordenadas, potencia y precio.'); return;
    }
    const base     = Math.round(finalPrice / (1 + IVA_RATE));
    const peakFin  = parseFloat(String(f.peak_per_kwh).replace(/\./g, '').replace(',', '.'));
    const peakBase = peakFin > 0 ? Math.round(peakFin / (1 + IVA_RATE)) : null;
    const cost     = parseFloat(String(f.cost_per_kwh).replace(/\./g, '').replace(',', '.')) || 0;
    try {
      if (f.id) {
        await apiFetch(`/chargers/${f.id}`, { method: 'PATCH', body: JSON.stringify({
          name: (f.name || '').trim(), icon: f.icon || '',
          unit_id: f.unit_id || null, clear_unit: !f.unit_id,
          location: f.location.trim(), lat: parseFloat(f.lat), lng: parseFloat(f.lng),
          power_kw: parseFloat(f.power_kw), connector_type: f.connector_type,
          price_per_kwh: base, cost_per_kwh: cost,
          peak_price_per_kwh: peakBase, clear_peak: peakBase === null,
        }) }, token);
        setAddChargerModal(false); fetchStatus();
        Alert.alert('Guardado', `El conductor pagará $${finalPrice.toLocaleString('es-CO')}/kWh (IVA incl.).`);
      } else {
        const data = await apiFetch('/chargers', { method: 'POST', body: JSON.stringify({
          name: (f.name || '').trim() || null, icon: f.icon || null, unit_id: f.unit_id || null,
          location: f.location.trim(), lat: parseFloat(f.lat), lng: parseFloat(f.lng),
          power_kw: parseFloat(f.power_kw), connector_type: f.connector_type,
          price_per_kwh: base, cost_per_kwh: cost, brand_profile_id: f.brand_profile_id,
        }) }, token);
        // tarifa pico opcional al crear
        if (peakBase) {
          try { await apiFetch(`/chargers/${data.id}/peak-price`, { method: 'PATCH', body: JSON.stringify({ peak_price_per_kwh: peakBase }) }, token); } catch {}
        }
        setAddChargerModal(false); fetchStatus();
        Alert.alert('¡Cargador registrado!',
          `Tu ID:\n${data.id}\n\nURL OCPP para tu equipo:\n${data.ocpp_url}\n\n(El simulador ya quedó corriendo para probar.)`,
          [{ text: 'Entendido' }]);
      }
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const fetchArchivedChargers = async () => {
    try { const d = await apiFetch('/my-chargers/archived', {}, token); setArchivedChargers(d.chargers || []); }
    catch {}
  };

  // ── Unidades (cargadores privados) ──────────────────────────────────────────
  const fetchUnits = async () => {
    try { const d = await apiFetch('/my-units', {}, token); setUnits(d.units || []); } catch {}
  };
  const fetchMemberships = async () => {
    try { const d = await apiFetch('/my-memberships', {}, token); setMyUnitIds(d.unit_ids || []); } catch {}
  };
  const createUnit  = async (name) => { await apiFetch('/units', { method: 'POST', body: JSON.stringify({ name }) }, token); fetchUnits(); };
  const addMember   = async (unitId, email) => { await apiFetch(`/units/${unitId}/members`, { method: 'POST', body: JSON.stringify({ email }) }, token); fetchUnits(); };
  const removeMember = async (unitId, userId) => { await apiFetch(`/units/${unitId}/members/${userId}`, { method: 'DELETE' }, token); fetchUnits(); };
  const deleteUnit  = (u) => Alert.alert('Borrar unidad', `¿Borrar "${u.name}"? Sus cargadores volverán a públicos.`, [
    { text: 'Cancelar' },
    { text: 'Borrar', style: 'destructive', onPress: async () => { try { await apiFetch(`/units/${u.id}`, { method: 'DELETE' }, token); fetchUnits(); fetchStatus(); } catch (e) { Alert.alert('Error', e.message); } } },
  ]);
  const joinUnit = async (code) => { const r = await apiFetch('/units/join', { method: 'POST', body: JSON.stringify({ code }) }, token); fetchMemberships(); fetchStatus(); return r; };

  // Pull-to-refresh por pantalla (re-consulta los datos de esa sección).
  const refreshMiUso = async () => {
    await Promise.all([fetchMyUsage(), fetchWallet(), fetchPaymentMethods(), fetchReservations()]);
  };
  const refreshNegocio = async () => {
    await Promise.all([
      fetchEarnings(), fetchDisbAccount(), fetchPaymentMethods(), fetchUnits(),
      apiFetch('/my-disbursements', {}, token).then(setMyDisburses).catch(() => {}),
      apiFetch('/my-balance', {}, token).then(setBalance).catch(() => {}),
      apiFetch('/my-events', {}, token).then(setOwnerEvents).catch(() => {}),
      apiFetch('/my-subscription', {}, token).then(setMySubscription).catch(() => {}),
      apiFetch('/my-stats?period=week', {}, token).then(setMyStats).catch(() => {}),
    ]);
  };

  // "Dar de baja" = archivar (soft-delete): sale del mapa y de la lista activa, se
  // conserva todo (ID, historial) y queda minimizado al final para reactivar.
  const deleteCharger = (c) => {
    Alert.alert(
      'Dar de baja',
      `¿Dar de baja ${c.id}?\n${c.location}\n\nSale del mapa y de tu lista, pero se guarda el historial. Puedes reactivarlo cuando quieras.`,
      [
        { text: 'Dar de baja', style: 'destructive', onPress: async () => {
          try {
            await apiFetch(`/chargers/${c.id}`, { method: 'DELETE' }, token);
            fetchStatus(); fetchArchivedChargers();
          } catch (e) { Alert.alert('Error', e.message); }
        }},
        { text: 'Cancelar' },
      ]
    );
  };

  const restoreCharger = (c) => {
    Alert.alert('Reactivar', `¿Reactivar ${c.id}? Volverá al mapa y a tu lista.`, [
      { text: 'Reactivar', onPress: async () => {
        try {
          await apiFetch(`/chargers/${c.id}/restore`, { method: 'PATCH' }, token);
          fetchStatus(); fetchArchivedChargers();
        } catch (e) { Alert.alert('Error', e.message); }
      }},
      { text: 'Cancelar' },
    ]);
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

  const doReserve = (charger) => {
    Alert.alert(
      'Separar este cargador',
      'Retenemos una garantía en tu tarjeta (no se cobra todavía).\n\n' +
      '• Tienes 20 minutos para llegar.\n' +
      '• Si cargas, solo se cobra $1.500 de separación y el resto se libera.\n' +
      '• Si no llegas, se cobra la garantía completa para compensar al dueño por el espacio bloqueado.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Separar', onPress: () => confirmReserve(charger) },
      ]
    );
  };

  const confirmReserve = async (charger) => {
    try {
      const data = await apiFetch(`/reserve/${charger.id}`, { method: 'POST', body: JSON.stringify({}) }, token);
      setReservations(prev => [...prev, data]);
      const fee = (data.fee_cop || 0).toLocaleString('es-CO');
      const conv = (data.convenience_cop || 1000).toLocaleString('es-CO');
      Alert.alert(
        'Cargador separado',
        `${charger.location}\n\nRetuvimos $${fee} de garantía.\nTienes 20 min para llegar. Al cargar solo pagas $${conv} de separación; el resto se libera.`
      );
      fetchStatus();
      setSelectedCharger(null);
      setChargerPanel(null);
    } catch (e) {
      Alert.alert('No se pudo separar', e.message);
    }
  };

  // Centra el mapa en mi ubicación y abre el panel del cargador disponible más cercano.
  const goToNearest = async () => {
    let coords = userCoords;
    if (!coords) coords = await requestLocation();
    if (!coords) {
      Alert.alert(
        'Ubicación desactivada',
        'Activa el permiso de ubicación para encontrar el cargador más cercano a ti.'
      );
      return;
    }
    const result = nearestCharger(coords, chargers);
    if (!result) {
      Alert.alert('Sin cargadores', 'No hay cargadores con ubicación registrada por ahora.');
      return;
    }
    const { charger } = result;
    setSelectedCharger(charger);
    setMapSearch('');
    setGeoResults([]);
    mapRef.current?.animateToRegion(
      { latitude: charger.lat, longitude: charger.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 },
      500
    );
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
    if (stoppingRef.current) return;   // evita disparar varias paradas (cobros duplicados)
    stoppingRef.current = true;
    try {
      const data = await apiFetch(`/remote-stop/${chargerId}`, { method: 'POST' }, token);
      if (data.error && !data.manual) { Alert.alert('Error', data.error); stoppingRef.current = false; return; }

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
    } finally {
      stoppingRef.current = false;
    }
  };

  if (booting) {
    return <BootSplash />;
  }

  if (!token) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  const available   = chargers.filter(c => c.status === 'Available').length;
  const charging    = chargers.filter(c => c.status === 'Charging').length;
  const offline     = chargers.filter(c => c.status === 'Offline').length;
  const isOwner     = user?.role === 'owner';

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


  // ¿Hay algún panel/modal encima del mapa? Entonces ocultar el buscador
  // flotante (si no, se asoma sobre el modal de carga, QR, panel, etc.)
  const mapOverlayOpen = !!(selectedCharger || chargerPanel || qrModal || payMethodsModal ||
    confirmPayModal || addMethodModal || addChargerModal || addDisbModal || paymentPending ||
    sessionModal || locationPicker || renameModal);

  // Datos de sesión activa para mini-barra y modal
  const liveCharger  = activeSession ? (chargers.find(c => c.id === activeSession.chargerId) || activeSession.charger) : null;
  const sessionKwh   = liveKwh;   // kWh propio en vivo (de /my-active-session)
  const sessionPrice = (liveCharger?.price_per_kwh_now ?? liveCharger?.price_per_kwh) ? (liveCharger.price_per_kwh_now ?? liveCharger.price_per_kwh) * 1.19 : 0;
  const sessionCost  = Math.round(sessionKwh * sessionPrice);


  const savePrice = async (chargerId) => {
    // El dueño escribe el PRECIO FINAL (lo que paga el conductor, IVA incl.).
    // Guardamos la base = final / 1.19 (el backend luego le suma el IVA y queda igual).
    const final = parseFloat(newPrice.replace(/\./g, '').replace(',', '.'));
    if (!final || final <= 0) { Alert.alert('Error', 'Ingresa un precio válido'); return; }
    const base = Math.round(final / (1 + IVA_RATE));
    try {
      await apiFetch(`/chargers/${chargerId}/price`, {
        method: 'PATCH',
        body: JSON.stringify({ price_per_kwh: base }),
      }, token);
      setEditingPrice(null);
      setNewPrice('');
      fetchStatus();
      Alert.alert('Listo', `El conductor pagará $${final.toLocaleString('es-CO')}/kWh (IVA incluido).`);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  // ── Tarjeta para CONDUCTOR ────────────────────────────────────────────────
  const myChargers = chargers.filter(c => c.owner_id === user?.id);

  // "Caja común" para las pantallas extraídas. Crece a medida que migramos más.
  const ctx = {
    // MiUso (conductor)
    wallet, myUsage, reservations, sessionsShown, paymentMethods, token,
    setRecargaAmount, setRecargaModal, requestRefund, cancelReservation,
    setSessionDetail, setSessionsShown, setRenameModal, fetchPaymentMethods, setAddMethodModal,
    // Negocio (dueño)
    ownerEvents, setOwnerEvents, mySubscription, setMySubscription, myStats, balance,
    withdrawing, withdrawBalance, myDisburses, disbAccount, verifyDisbAccount,
    setDisbForm, setAddDisbModal, earnings, ownerSessionsShown, setOwnerSessionsShown,
    // Lista / Mis cargadores (dueño) + OwnerCard
    myChargers, refreshing, fetchStatus, openNewCharger, serverOk,
    archivedChargers, restoreCharger,
    // Unidades
    units, fetchUnits, createUnit, addMember, removeMember, deleteUnit,
    unitsModal, setUnitsModal, myUnitIds, joinUnit, joinUnitModal, setJoinUnitModal,
    // Perfil
    profileModal, setProfileModal, updateName, changePassword, uploadAvatar, removeAvatar,
    handleLogout, avatarBust,
    // Refresh por pantalla
    refreshMiUso, refreshNegocio,
    editingPrice, newPrice, setNewPrice, setEditingPrice, savePrice, openEditCharger,
    chargerPhotos, photoBusy, addPhoto, removePhoto, photoUri, setPhotoView,
    togglePause, deleteCharger, fetchEarnings,
    // Mapa
    mapRef, locStatus, inView, chargers, zoom,
    selectedCharger, isOwner, user, tapCharger, mapOverlayOpen, mapSearch, setMapSearch,
    geoResults, setGeoResults, mapSearchResults, setSelectedCharger, setChargerPanel,
    activeSession, goToNearest, locLoading, setMapRegion, setZoom,
  };

  return (
    <AppCtx.Provider value={ctx}>
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
            style={[styles.userBadge, isOwner && styles.userBadgeOwner, { overflow: 'hidden' }]}
            onPress={() => setProfileModal(true)}>
            {user?.avatar_url
              ? <Image source={{ uri: `${API_URL}${user.avatar_url}?v=${avatarBust}` }} style={{ width: '100%', height: '100%' }} />
              : <Text style={styles.userInitial}>{user?.name?.[0]?.toUpperCase()}</Text>}
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
        <MiUsoScreen />
      ) : tab === 'lista' ? (
        isOwner ? <ListScreen /> : <DescubreScreen />
      ) : tab === 'negocio' ? (
        <NegocioScreen />
      ) : (
        <MapScreen />
      )}

      {/* ── Panel flotante del mapa — nivel raíz para capturar toques correctamente ── */}
      {tab === 'mapa' && selectedCharger && !chargerPanel && (() => {
        const c        = chargers.find(x => x.id === selectedCharger.id) || selectedCharger;
        const color    = STATUS_COLOR[c.status] || T.offline;
        const mine     = isOwner && c.owner_id === user?.id;
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.19) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        const locked   = c.private && c.owner_id !== user?.id && !myUnitIds.includes(c.unit_id);
        const myRes    = reservations.find(r => r.charger_id === c.id && r.status === 'active');
        const isResMine  = c.status === 'Reserved' && !!myRes;
        const isResOther = c.status === 'Reserved' && !myRes;
        const distKm   = (userCoords && c.lat != null && c.lng != null)
          ? haversineKm(userCoords, { latitude: c.lat, longitude: c.lng }) : null;
        return (
          <SlideUp style={styles.mapPanel}>
            <View style={styles.mapPanelHandle} />
            <View style={styles.mapPanelHeader}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.dot, { backgroundColor: color, width: 10, height: 10, borderRadius: 5 }]} />
                  <Text style={styles.mapPanelId} numberOfLines={1}>{c.name || c.id}</Text>
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
              {distKm != null && (
                <View style={styles.specChip}><Text style={styles.specText}>a {formatDistance(distKm)}</Text></View>
              )}
              {c.owner && <View style={styles.specChip}><Text style={styles.specText}>{c.owner}</Text></View>}
            </View>
            {/* Fotos del cargador (las subió el dueño) */}
            {(() => {
              const photos = chargerPhotos[c.id] || [];
              if (!photos.length) return null;
              return (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                  {photos.map(p => (
                    <TouchableOpacity key={p.id} activeOpacity={0.9} onPress={() => setPhotoView({ url: photoUri(p) })}>
                      <Image source={{ uri: photoUri(p) }} style={styles.panelPhoto} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              );
            })()}
            {priceUser && (
              <View style={styles.mapPanelPrice}>
                <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                <Text style={styles.mapPanelPriceNote}>IVA incluido</Text>
              </View>
            )}

            {/* Estimación fácil (lento <50kW → 1h; rápido ≥50kW → 30 min) */}
            {priceUser && c.power_kw && (() => {
              const fast = c.power_kw >= 50;
              const mins = fast ? 30 : 60;
              const kwh  = Math.round(c.power_kw * 0.9 * (mins / 60) * 10) / 10;
              const cost = Math.round(kwh * priceUser);
              const km   = Math.round(kwh * 5);
              return (
                <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: T.cardBorder }}>
                  <Text style={{ color: T.textMuted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>
                    EN {fast ? '30 MIN' : '1 HORA'} DE CARGA (APROX.)
                  </Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <View><Text style={{ color: T.textPri, fontWeight: '800', fontSize: 16 }}>{kwh} kWh</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>energía</Text></View>
                    <View><Text style={{ color: T.textPri, fontWeight: '800', fontSize: 16 }}>~{km} km</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>autonomía</Text></View>
                    <View><Text style={{ color: T.green, fontWeight: '800', fontSize: 16 }}>$ {cost.toLocaleString('es-CO')}</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>costo aprox.</Text></View>
                  </View>
                </View>
              );
            })()}

            {/* Saldo del conductor */}
            {!isOwner && wallet && priceUser > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.greenFaint, borderRadius: 10, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: T.greenDark }}>
                <Feather name="credit-card" size={14} color={T.green} />
                <Text style={{ color: T.textSec, fontSize: 12, flex: 1 }}>
                  Tu saldo: <Text style={{ fontWeight: '800', color: T.green }}>$ {(wallet.balance_cop || 0).toLocaleString('es-CO')}</Text>
                  {` · ~${Math.floor((wallet.balance_cop || 0) / priceUser)} kWh`}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.btn, styles.btnDirections]}
              onPress={() => openDirections({ lat: c.lat, lng: c.lng, label: c.location || c.id })}
            >
              <Feather name="navigation" size={15} color={T.green} />
              <Text style={[styles.btnText, { color: T.green }]}>Cómo llegar</Text>
            </TouchableOpacity>
            {isCharg && c.current_kwh != null && (
              <View style={[styles.sessionBox, { marginBottom: 8 }]}>
                <View style={styles.sessionRow}>
                  <Text style={styles.sessionLabel}>En carga ahora</Text>
                  <Text style={styles.sessionCost}>{c.current_kwh} kWh · $ {Math.round(c.current_kwh*(priceUser||0)).toLocaleString('es-CO')} COP</Text>
                </View>
              </View>
            )}
            {isResOther && (
              <View style={[styles.sessionBox, { marginBottom: 8 }]}>
                <Text style={[styles.sessionLabel, { textAlign: 'center' }]}>Separado por otro conductor</Text>
              </View>
            )}
            {!isOwner && locked && (
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: T.cardBorder, marginBottom: 8 }}>
                  <Feather name="lock" size={14} color={T.textMuted} />
                  <Text style={{ color: T.textSec, fontSize: 12, flex: 1 }}>Privado · solo residentes de la unidad pueden cargar.</Text>
                </View>
                <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => setJoinUnitModal(true)}>
                  <Feather name="key" size={14} color="#fdfbf7" />
                  <Text style={styles.btnText}>Unirme con código</Text>
                </TouchableOpacity>
              </View>
            )}
            {!isOwner && !locked && (
              <View style={styles.modalActions}>
                {(isAvail || isResMine) && (
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
                    <Text style={[styles.btnText, { color: T.green }]}>Separar</Text>
                  </TouchableOpacity>
                )}
                {isResMine && (
                  <TouchableOpacity style={[styles.btn, styles.btnReserve, { flex: 1 }]} onPress={() => cancelReservation(myRes.id)}>
                    <Feather name="x-circle" size={15} color={T.dangerText} />
                    <Text style={[styles.btnText, { color: T.dangerText }]}>Cancelar</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </SlideUp>
        );
      })()}

      {/* ── Barra de navegación inferior ── */}
      {!selectedCharger && !chargerPanel && !qrModal && !payMethodsModal && !addMethodModal && !paymentPending && !addDisbModal && !sessionModal && (
        <View style={styles.bottomBar}>
          {(isOwner ? [
            { id: 'lista',   icon: 'zap',         label: 'Mis cargadores' },
            { id: 'mapa',    icon: 'map-pin',      label: 'Mapa'       },
            { id: 'negocio', icon: 'bar-chart-2',  label: 'Negocio'    },
          ] : [
            { id: 'mapa',   icon: 'map-pin', label: 'Mapa'      },
            { id: 'lista',  icon: 'compass', label: 'Descubre' },
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

      {/* ── Prompt al terminar la carga: recibo + calificación ── */}
      {ratePrompt && (
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <View style={{ alignItems: 'center', paddingVertical: 6 }}>
              <Feather name="check-circle" size={44} color={T.green} />
              <Text style={{ color: T.textPri, fontWeight: '800', fontSize: 20, marginTop: 10 }}>¡Carga completada!</Text>
              <Text style={{ color: T.textSec, fontSize: 15, marginTop: 4 }}>
                {ratePrompt.kwh.toFixed(3)} kWh · $ {ratePrompt.cost.toLocaleString('es-CO')} COP
              </Text>
            </View>

            {ratePrompt.sessionId ? (
              <>
                <Text style={{ color: T.textMuted, fontSize: 13, textAlign: 'center', marginTop: 16, marginBottom: 12 }}>
                  ¿Cómo estuvo el servicio?
                </Text>
                <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'center' }}>
                  <TouchableOpacity
                    onPress={() => { rateSession(ratePrompt.sessionId, true); setRatePrompt(null); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 13, paddingHorizontal: 26, borderRadius: 12, borderWidth: 1.5, borderColor: T.green, backgroundColor: T.greenFaint }}>
                    <Feather name="thumbs-up" size={19} color={T.green} />
                    <Text style={{ color: T.green, fontWeight: '700', fontSize: 14 }}>Bien</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { rateSession(ratePrompt.sessionId, false); setRatePrompt(null); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 13, paddingHorizontal: 26, borderRadius: 12, borderWidth: 1.5, borderColor: T.cardBorder, backgroundColor: T.surface }}>
                    <Feather name="thumbs-down" size={19} color={T.dangerText} />
                    <Text style={{ color: T.dangerText, fontWeight: '700', fontSize: 14 }}>Mal</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}

            <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 18 }]} onPress={() => setRatePrompt(null)}>
              <Text style={[styles.btnText, { color: T.textMuted }]}>{ratePrompt.sessionId ? 'Ahora no' : 'Cerrar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={() => { setRatePrompt(null); setTab('miuso'); }}>
              <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>Ver mi historial</Text>
            </TouchableOpacity>
          </View>
        </View>
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
              <View style={styles.sessionStat}><Text style={styles.sessionStatVal}>{(liveCharger?.current_power_kw ?? liveCharger?.power_kw) || '—'} kW</Text><Text style={styles.sessionStatLbl}>Potencia</Text></View>
            </View>

            {/* Extras en vivo: batería (si el cargador la reporta), km y saldo */}
            {(() => {
              const power  = liveCharger?.current_power_kw ?? liveCharger?.power_kw ?? 0;
              const kmAdded = Math.round(sessionKwh * 5);
              const saldo  = wallet?.balance_cop ?? 0;
              const maxKwh = sessionPrice > 0 ? saldo / sessionPrice : 0;
              const restKwh = Math.max(0, maxKwh - sessionKwh);
              const restMin = power > 0 ? Math.round(restKwh / power * 60) : null;
              return (
                <View style={{ backgroundColor: T.surface, borderRadius: 12, padding: 12, marginTop: 12, borderWidth: 1, borderColor: T.cardBorder, gap: 8 }}>
                  {liveCharger?.current_soc != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: T.textSec, fontSize: 13 }}>Batería del carro</Text>
                      <Text style={{ color: T.textPri, fontSize: 14, fontWeight: '800' }}>{liveCharger.current_soc}%</Text>
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: T.textSec, fontSize: 13 }}>Autonomía cargada (aprox.)</Text>
                    <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '700' }}>≈ {kmAdded} km</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: T.textSec, fontSize: 13 }}>Tu saldo</Text>
                    <Text style={{ color: T.green, fontSize: 13, fontWeight: '800' }}>$ {saldo.toLocaleString('es-CO')}</Text>
                  </View>
                  {sessionPrice > 0 && (
                    <Text style={{ color: T.textMuted, fontSize: 11 }}>
                      Con tu saldo puedes cargar ~{restKwh.toFixed(1)} kWh más{restMin != null ? ` (~${restMin} min)` : ''}. La carga se detiene sola antes de quedarte sin saldo.
                    </Text>
                  )}
                </View>
              );
            })()}

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
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.19) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        const locked   = c.private && c.owner_id !== user?.id && !myUnitIds.includes(c.unit_id);
        const myRes    = reservations.find(r => r.charger_id === c.id && r.status === 'active');
        const isResMine  = c.status === 'Reserved' && !!myRes;
        const isResOther = c.status === 'Reserved' && !myRes;
        const distKm   = (userCoords && c.lat != null && c.lng != null)
          ? haversineKm(userCoords, { latitude: c.lat, longitude: c.lng }) : null;
        const close    = () => { setChargerPanel(null); setSelectedCharger(null); };

        return (
          <View style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.28)' }]}>
            <TouchableOpacity style={{ flex: 1 }} onPress={close} activeOpacity={1} />
            <SlideUp style={styles.modal}>
              <View style={styles.mapPanelHandle} />

              {/* Header */}
              <View style={styles.mapPanelHeader}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={[styles.dot, { backgroundColor: color, width: 10, height: 10, borderRadius: 5 }]} />
                    <Text style={styles.mapPanelId} numberOfLines={1}>{c.name || c.id}</Text>
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
                {distKm != null && (
                  <View style={styles.specChip}><Text style={styles.specText}>a {formatDistance(distKm)}</Text></View>
                )}
                {c.rating_total > 0 && (
                  <View style={styles.specChip}><Text style={styles.specText}>👍 {c.rating_pct}% ({c.rating_total})</Text></View>
                )}
              </View>

              {/* Fotos del cargador (las subió el dueño) */}
              {(() => {
                const photos = chargerPhotos[c.id] || [];
                if (!photos.length) return null;
                return (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                    {photos.map(p => (
                      <TouchableOpacity key={p.id} activeOpacity={0.9} onPress={() => setPhotoView({ url: photoUri(p) })}>
                        <Image source={{ uri: photoUri(p) }} style={styles.panelPhoto} />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                );
              })()}

              {/* Precio */}
              {priceUser && (
                <View style={styles.mapPanelPrice}>
                  <View>
                    <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                    <Text style={styles.mapPanelPriceNote}>IVA incluido · {c.owner}</Text>
                  </View>
                </View>
              )}

              {/* Estimación fácil para quien no sabe de carga.
                  Ventana según potencia: lento (<50 kW) → 1 hora; rápido (≥50 kW) → 30 min. */}
              {priceUser && c.power_kw && (() => {
                const fast    = c.power_kw >= 50;
                const mins    = fast ? 30 : 60;
                const kwh     = Math.round(c.power_kw * 0.9 * (mins / 60) * 10) / 10;
                const cost    = Math.round(kwh * priceUser);
                const km      = Math.round(kwh * 5);   // ~5 km por kWh
                return (
                  <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: T.cardBorder }}>
                    <Text style={{ color: T.textMuted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>
                      EN {fast ? '30 MIN' : '1 HORA'} DE CARGA (APROX.)
                    </Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <View><Text style={{ color: T.textPri, fontWeight: '800', fontSize: 16 }}>{kwh} kWh</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>energía</Text></View>
                      <View><Text style={{ color: T.textPri, fontWeight: '800', fontSize: 16 }}>~{km} km</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>autonomía</Text></View>
                      <View><Text style={{ color: T.green, fontWeight: '800', fontSize: 16 }}>$ {cost.toLocaleString('es-CO')}</Text><Text style={{ color: T.textMuted, fontSize: 11 }}>costo aprox.</Text></View>
                    </View>
                    <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 6 }}>Aproximado; depende de tu carro y su velocidad de carga.</Text>
                  </View>
                );
              })()}

              {/* Saldo del conductor (para saber si le alcanza) */}
              {!isOwner && wallet && priceUser > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.greenFaint, borderRadius: 10, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: T.greenDark }}>
                  <Feather name="credit-card" size={14} color={T.green} />
                  <Text style={{ color: T.textSec, fontSize: 12, flex: 1 }}>
                    Tu saldo: <Text style={{ fontWeight: '800', color: T.green }}>$ {(wallet.balance_cop || 0).toLocaleString('es-CO')}</Text>
                    {` · te alcanza ~${Math.floor((wallet.balance_cop || 0) / priceUser)} kWh (~${Math.round((wallet.balance_cop || 0) / priceUser * 5)} km)`}
                  </Text>
                </View>
              )}

              {/* Cómo llegar */}
              <TouchableOpacity
                style={[styles.btn, styles.btnDirections]}
                onPress={() => openDirections({ lat: c.lat, lng: c.lng, label: c.location || c.id })}
              >
                <Feather name="navigation" size={16} color={T.green} />
                <Text style={[styles.btnText, { color: T.green }]}>Cómo llegar</Text>
              </TouchableOpacity>

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

              {isResOther && (
                <View style={[styles.sessionBox, { marginBottom: 12 }]}>
                  <Text style={[styles.sessionLabel, { textAlign: 'center' }]}>Separado por otro conductor</Text>
                </View>
              )}

              {/* Acceso privado: bloqueado para no-miembros */}
              {!isOwner && locked && (
                <View style={{ marginBottom: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: T.cardBorder, marginBottom: 10 }}>
                    <Feather name="lock" size={15} color={T.textMuted} />
                    <Text style={{ color: T.textSec, fontSize: 12.5, flex: 1 }}>Privado · solo residentes de la unidad pueden cargar aquí.</Text>
                  </View>
                  <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={() => setJoinUnitModal(true)}>
                    <Feather name="key" size={15} color="#fdfbf7" />
                    <Text style={styles.btnText}>Unirme con código</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Acciones conductor */}
              {!isOwner && !locked && (
                <View style={styles.mapPanelActions}>
                  {(isAvail || isResMine) && (
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
                      <Text style={[styles.btnText, { color: T.green }]}>Separar</Text>
                    </TouchableOpacity>
                  )}
                  {isResMine && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnReserve, { flex: 1 }]}
                      onPress={() => { close(); cancelReservation(myRes.id); }}
                    >
                      <Feather name="x-circle" size={16} color={T.dangerText} />
                      <Text style={[styles.btnText, { color: T.dangerText }]}>Cancelar</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </SlideUp>
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
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={() => { const c = qrModal; setQrModal(null); startChargeWallet(c); }}>
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
      {/* ── Recargar saldo (wallet) ── */}
      {recargaModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => !recargando && setRecargaModal(false)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>Recargar saldo</Text>
            <Text style={[styles.mapPanelLocation, { marginBottom: 16 }]}>Saldo actual: $ {(wallet?.balance_cop ?? 0).toLocaleString('es-CO')} COP</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
              {[20000, 50000, 100000].map(a => (
                <TouchableOpacity key={a} disabled={recargando} onPress={() => setRecargaAmount(a)}
                  style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1.5, opacity: recargando ? 0.5 : 1,
                    borderColor: recargaAmount === a ? T.green : T.cardBorder,
                    backgroundColor: recargaAmount === a ? T.greenFaint : T.surface }}>
                  <Text style={{ color: recargaAmount === a ? T.green : T.textPri, fontWeight: '700' }}>$ {a / 1000}k</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={{ color: T.textMuted, fontSize: 12, marginBottom: 8 }}>Cobrar a:</Text>
            {paymentMethods.length === 0 ? (
              <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={() => { setRecargaModal(false); setAddMethodModal('card'); }}>
                <Text style={styles.btnText}>Agregar una tarjeta</Text>
              </TouchableOpacity>
            ) : (
              paymentMethods.map(m => (
                <TouchableOpacity key={m.id} style={[styles.methodRow, recargando && { opacity: 0.5 }]} disabled={recargando} onPress={() => doTopup(recargaAmount, m)}>
                  <Feather name="credit-card" size={18} color={T.textMuted} />
                  <Text style={{ color: T.textPri, flex: 1, marginLeft: 10 }}>{m.display}</Text>
                  {recargando ? <ActivityIndicator size="small" color={T.green} /> : <Feather name="chevron-right" size={16} color={T.textMuted} />}
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 16 }]} disabled={recargando} onPress={() => setRecargaModal(false)}>
              <Text style={[styles.btnText, { color: T.textMuted }]}>{recargando ? 'Recargando…' : 'Cancelar'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {payMethodsModal && (
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setPayMethodsModal(null)} activeOpacity={1} />
          <View style={styles.modal}>
            <View style={styles.mapPanelHandle} />
            <Text style={styles.modalTitle}>¿Cómo vas a pagar?</Text>
            <Text style={styles.mapPanelLocation}>{payMethodsModal.location} · $ {Math.round((payMethodsModal.price_per_kwh_now ?? payMethodsModal.price_per_kwh ?? 0)*1.19).toLocaleString('es-CO')}/kWh</Text>
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
              <Text style={styles.modalTitle}>{chargerForm.id ? `Editar ${chargerForm.id}` : 'Registrar cargador'}</Text>
              <Text style={styles.mapPanelLocation}>{chargerForm.id ? 'Edita los datos y el precio de tu cargador.' : 'Te asignaremos un ID único (FARO-XXXX) y la URL para configurar tu equipo.'}</Text>

              <View style={{ gap: 10, marginTop: 16 }}>
                {/* Nombre personalizado */}
                <View>
                  <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 6, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Nombre (opcional)</Text>
                  <TextInput style={styles.input} placeholder="Ej: Casa, Torre 2, Café del parque…"
                    placeholderTextColor={T.textMuted} value={chargerForm.name}
                    onChangeText={v => setChargerForm(f => ({ ...f, name: v }))} maxLength={28} />
                </View>

                {/* Acceso: público o privado (unidad) */}
                <View>
                  <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 6, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Acceso</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <TouchableOpacity
                      style={[styles.roleBtn, !chargerForm.unit_id && styles.roleBtnActive]}
                      onPress={() => setChargerForm(f => ({ ...f, unit_id: null }))}>
                      <Text style={[styles.roleBtnText, !chargerForm.unit_id && styles.roleBtnTextActive]}>Público</Text>
                    </TouchableOpacity>
                    {units.map(u => (
                      <TouchableOpacity key={u.id}
                        style={[styles.roleBtn, chargerForm.unit_id === u.id && styles.roleBtnActive]}
                        onPress={() => setChargerForm(f => ({ ...f, unit_id: u.id }))}>
                        <Text style={[styles.roleBtnText, chargerForm.unit_id === u.id && styles.roleBtnTextActive]}>{u.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 4 }}>
                    {units.length === 0
                      ? 'Crea una unidad en "Mis cargadores → Unidades" para hacer el cargador privado.'
                      : chargerForm.unit_id
                        ? 'Privado: solo los miembros de la unidad podrán cargar aquí.'
                        : 'Público: cualquier conductor puede cargar.'}
                  </Text>
                </View>

                {/* Modelo / referencia del catálogo (con foto, descripción y recomendaciones) */}
                {brandProfiles.length > 0 && (() => {
                  const sel = brandProfiles.find(b => b.id === chargerForm.brand_profile_id);
                  const q = modelSearch.trim().toLowerCase();
                  const filtered = (q
                    ? brandProfiles.filter(b => `${b.display_name} ${b.vendor || ''} ${b.model || ''}`.toLowerCase().includes(q))
                    : brandProfiles).slice(0, 20);
                  return (
                  <View>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 6, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>Modelo / referencia (opcional)</Text>
                    {sel ? (
                      <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: T.greenDark }}>
                        {sel.photos?.length > 0 && (
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                            {sel.photos.map(p => (
                              <TouchableOpacity key={p.id} activeOpacity={0.9} onPress={() => setPhotoView({ url: `${API_URL}${p.url}` })}>
                                <Image source={{ uri: `${API_URL}${p.url}` }} style={{ width: 130, height: 98, borderRadius: 8, marginRight: 8, backgroundColor: T.card, borderWidth: 1, borderColor: T.cardBorder }} />
                              </TouchableOpacity>
                            ))}
                          </ScrollView>
                        )}
                        <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 13 }}>{sel.display_name}</Text>
                        <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }}>
                          {[sel.vendor, sel.max_power_kw ? `${sel.max_power_kw} kW` : null, (sel.connector_types || []).join(', ')].filter(Boolean).join(' · ')}
                        </Text>
                        {sel.description ? <Text style={{ color: T.textSec, fontSize: 12, marginTop: 6, lineHeight: 17 }}>{sel.description}</Text> : null}
                        {sel.recommendations ? <Text style={{ color: T.green, fontSize: 11.5, marginTop: 6, lineHeight: 16 }}>{sel.recommendations}</Text> : null}
                        {sel.setup_guide_md ? <Text style={{ color: T.textMuted, fontSize: 10.5, marginTop: 6 }} numberOfLines={4}>{sel.setup_guide_md}</Text> : null}
                        <TouchableOpacity style={{ marginTop: 10, alignSelf: 'flex-start' }} onPress={() => { setChargerForm(f => ({ ...f, brand_profile_id: null })); setModelSearch(''); }}>
                          <Text style={{ color: T.green, fontSize: 12, fontWeight: '700' }}>Cambiar modelo</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View>
                        <TextInput style={styles.input} placeholder="Buscar modelo o marca…"
                          placeholderTextColor={T.textMuted} value={modelSearch} onChangeText={setModelSearch} autoCapitalize="none" />
                        <View style={{ borderWidth: 1, borderColor: T.cardBorder, borderRadius: 10, marginTop: 6, overflow: 'hidden' }}>
                          {filtered.length === 0 ? (
                            <Text style={{ color: T.textMuted, fontSize: 12, padding: 12 }}>Sin resultados.</Text>
                          ) : filtered.map((bp, i) => (
                            <TouchableOpacity key={bp.id}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9,
                                borderTopWidth: i === 0 ? 0 : 1, borderTopColor: T.cardBorder, backgroundColor: i % 2 ? T.surface : T.card }}
                              onPress={() => setChargerForm(f => ({
                                ...f, brand_profile_id: bp.id,
                                power_kw: f.power_kw || (bp.max_power_kw != null ? String(bp.max_power_kw) : ''),
                                connector_type: f.connector_type || (bp.connector_types && bp.connector_types[0]) || 'Type 2',
                              }))}>
                              {bp.photos?.[0]
                                ? <Image source={{ uri: `${API_URL}${bp.photos[0].url}` }} style={{ width: 38, height: 30, borderRadius: 6, backgroundColor: T.surface }} />
                                : <View style={{ width: 38, height: 30, borderRadius: 6, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.cardBorder }}><Feather name="zap" size={14} color={T.textMuted} /></View>}
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>{bp.display_name}</Text>
                                <Text style={{ color: T.textMuted, fontSize: 10.5 }} numberOfLines={1}>{[bp.vendor, bp.max_power_kw ? `${bp.max_power_kw} kW` : null].filter(Boolean).join(' · ')}</Text>
                              </View>
                              <Feather name="chevron-right" size={15} color={T.textMuted} />
                            </TouchableOpacity>
                          ))}
                        </View>
                        <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 4 }}>
                          {brandProfiles.length > 20 && !q ? `Mostrando 20 de ${brandProfiles.length}. Escribe para buscar.` : 'Opcional. También se detecta sola cuando el equipo se conecte.'}
                        </Text>
                      </View>
                    )}
                  </View>
                  );
                })()}

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

                {/* Precio FINAL (lo que paga el conductor, IVA incl.) */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Precio al conductor (IVA incl.) *</Text>
                    <TextInput style={styles.input} placeholder="1500" placeholderTextColor={T.textMuted}
                      value={chargerForm.price_per_kwh} onChangeText={v => setChargerForm(f=>({...f, price_per_kwh: v}))}
                      keyboardType="number-pad" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Tu costo de energía</Text>
                    <TextInput style={styles.input} placeholder="800" placeholderTextColor={T.textMuted}
                      value={chargerForm.cost_per_kwh} onChangeText={v => setChargerForm(f=>({...f, cost_per_kwh: v}))}
                      keyboardType="number-pad" />
                  </View>
                </View>
                <View>
                  <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Tarifa pico 6–10 pm (opcional, IVA incl.)</Text>
                  <TextInput style={styles.input} placeholder="Vacío = sin pico" placeholderTextColor={T.textMuted}
                    value={chargerForm.peak_per_kwh} onChangeText={v => setChargerForm(f=>({...f, peak_per_kwh: v}))}
                    keyboardType="number-pad" />
                </View>

                {/* Desglose en vivo de lo que ganas */}
                {(() => {
                  const finalP = parseFloat(String(chargerForm.price_per_kwh).replace(/\./g, '').replace(',', '.')) || 0;
                  if (finalP <= 0) return null;
                  const base = Math.round(finalP / (1 + IVA_RATE));
                  const iva = finalP - base;
                  const commission = Math.round(base * PLATFORM_MARGIN * (1 + IVA_RATE));
                  const energy = parseFloat(String(chargerForm.cost_per_kwh).replace(/\./g, '').replace(',', '.')) || 0;
                  const net = Math.round(base - base * PLATFORM_MARGIN * (1 + IVA_RATE) - energy);
                  return (
                    <View style={{ backgroundColor: T.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: T.cardBorder }}>
                      <Text style={{ color: T.textMuted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>DE CADA $ {finalP.toLocaleString('es-CO')} / kWh</Text>
                      {[['IVA (a la DIAN)', iva], ['Comisión Faro (15% + IVA)', commission], [energy > 0 ? 'Tu energía' : 'Tu energía (sin definir)', energy]].map(([l, v]) => (
                        <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                          <Text style={{ color: T.textSec, fontSize: 12 }}>{l}</Text>
                          <Text style={{ color: T.textPri, fontSize: 12 }}>{v > 0 ? `− $ ${v.toLocaleString('es-CO')}` : '—'}</Text>
                        </View>
                      ))}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTopWidth: 1, borderTopColor: T.cardBorder }}>
                        <Text style={{ color: T.green, fontSize: 13, fontWeight: '800' }}>Tu ganancia / kWh{energy > 0 ? '' : ' (antes de energía)'}</Text>
                        <Text style={{ color: T.green, fontSize: 13, fontWeight: '800' }}>≈ $ {net.toLocaleString('es-CO')}</Text>
                      </View>
                    </View>
                  );
                })()}
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btn, styles.btnStart, { flex: 1 }]} onPress={saveCharger}>
                  <Feather name={chargerForm.id ? 'check' : 'plus'} size={16} color="#fdfbf7" />
                  <Text style={styles.btnText}>{chargerForm.id ? 'Guardar cambios' : 'Registrar cargador'}</Text>
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

            {/* Desglose (comprobante) */}
            {[
              { label: 'Subtotal (energía)', value: `$ ${((sessionDetail.total_charged || 0) - (sessionDetail.iva_amount || 0)).toLocaleString('es-CO')} COP` },
              ...((sessionDetail.iva_amount || 0) > 0 ? [{ label: 'IVA', value: `$ ${(sessionDetail.iva_amount || 0).toLocaleString('es-CO')} COP` }] : []),
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

            {/* Calificación discreta del servicio */}
            <View style={{ marginTop: 18, alignItems: 'center' }}>
              <Text style={{ color: T.textMuted, fontSize: 12, marginBottom: 10 }}>¿Cómo estuvo el servicio?</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity
                  onPress={() => rateSession(sessionDetail.id, true)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12,
                    borderWidth: 1.5, borderColor: sessionDetail.my_rating === true ? T.green : T.cardBorder,
                    backgroundColor: sessionDetail.my_rating === true ? T.greenFaint : T.surface }}>
                  <Feather name="thumbs-up" size={18} color={sessionDetail.my_rating === true ? T.green : T.textMuted} />
                  <Text style={{ color: sessionDetail.my_rating === true ? T.green : T.textMuted, fontWeight: '700', fontSize: 13 }}>Bien</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => rateSession(sessionDetail.id, false)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12,
                    borderWidth: 1.5, borderColor: sessionDetail.my_rating === false ? T.dangerText : T.cardBorder,
                    backgroundColor: sessionDetail.my_rating === false ? '#fbe7e7' : T.surface }}>
                  <Feather name="thumbs-down" size={18} color={sessionDetail.my_rating === false ? T.dangerText : T.textMuted} />
                  <Text style={{ color: sessionDetail.my_rating === false ? T.dangerText : T.textMuted, fontWeight: '700', fontSize: 13 }}>Mal</Text>
                </TouchableOpacity>
              </View>
            </View>

            {sessionDetail.payment_status === 'CAPTURED' && (
              <TouchableOpacity
                style={[styles.btn, styles.btnStart, { marginTop: 16 }]}
                onPress={() => Linking.openURL(`${API_URL}/my-sessions/${sessionDetail.id}/receipt.pdf?token=${token}`)}>
                <Feather name="file-text" size={15} color="#fdfbf7" />
                <Text style={styles.btnText}>Ver comprobante (PDF)</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 10 }]} onPress={() => setSessionDetail(null)}>
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
                  $ {Math.round(confirmPayModal.charger.price_per_kwh * 1.19).toLocaleString('es-CO')} / kWh · {confirmPayModal.charger.power_kw} kW
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

      {/* Unidades (dueño) y unirse a unidad (conductor) */}
      {unitsModal && <UnitsModal />}
      {joinUnitModal && <JoinUnitModal />}
      {profileModal && <ProfileModal />}

      {/* Visor de foto a pantalla completa */}
      <PhotoViewer url={photoView?.url} onClose={() => setPhotoView(null)} />
    </View>
    </AppCtx.Provider>
  );
}
