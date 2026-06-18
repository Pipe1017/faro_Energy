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

// ── Módulos extraídos (ver src/) ──
import { T, STATUS_COLOR } from './src/theme';
import { API_URL, apiFetch } from './src/api';
import { MEDELLIN, formatElapsed } from './src/constants';
import { KbSheet } from './src/hooks';
import { useUserLocation, nearestCharger, openDirections, formatDistance, haversineKm } from './src/geo';
import { FaroLogo } from './src/components/FaroLogo';
import { ChargerMarker } from './src/components/ChargerMarker';
import { AuthScreen } from './src/components/AuthScreen';
import { styles } from './src/styles';

export default function App() {
  const [token, setToken]       = useState(null);
  const [user, setUser]         = useState(null);
  const [booting, setBooting]   = useState(true);
  const [simRunning, setSimRunning] = useState([]);   // simuladores corriendo (faltaba declararlo)

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
  const [adminSummary, setAdminSummary]   = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null); // sesión seleccionada para ver detalle
  const [ratePrompt, setRatePrompt]       = useState(null); // {sessionId, kwh, cost} → calificar al terminar la carga
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
  const [mySubscription, setMySubscription] = useState(null);
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
  const stoppingRef                 = useRef(false);   // guard de doble "Detener"
  const { coords: userCoords, status: locStatus, loading: locLoading, request: requestLocation } = useUserLocation();
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
    }
    if (tab === 'miuso')   { fetchMyUsage(); fetchPaymentMethods(); fetchWallet(); }
    if (tab === 'admin')   { apiFetch('/admin/summary', {}, token).then(setAdminSummary).catch(() => {}); }
    if (!isOwner && token) { fetchPaymentMethods(); fetchWallet(); }
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
  const priceUser  = (item.price_per_kwh_now ?? item.price_per_kwh) ? Math.round((item.price_per_kwh_now ?? item.price_per_kwh) * 1.19) : null;

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
          {/* Mi saldo (wallet prepago) */}
          <View style={{ backgroundColor: T.card, borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: T.cardBorder }}>
            <Text style={{ color: T.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}>MI SALDO</Text>
            <Text style={{ color: T.green, fontSize: 34, fontWeight: '800', marginTop: 2, letterSpacing: -1 }}>
              $ {(wallet?.balance_cop ?? 0).toLocaleString('es-CO')}
            </Text>
            <TouchableOpacity style={[styles.btn, styles.btnStart, { marginTop: 12 }]} onPress={() => { setRecargaAmount(wallet?.default_topup_cop || 50000); setRecargaModal(true); }}>
              <Text style={styles.btnText}>Recargar saldo</Text>
            </TouchableOpacity>
            {wallet?.movements?.length > 0 && (
              <View style={{ marginTop: 14 }}>
                {wallet.movements.slice(0, 4).map(m => (
                  <View key={m.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                    <Text style={{ color: T.textMuted, fontSize: 12 }}>
                      {m.type === 'TOPUP' ? 'Recarga' : m.type === 'CHARGE' ? 'Carga' : m.type === 'BONUS' ? 'Bono' : m.type === 'REFUND' ? 'Reembolso' : m.type}
                    </Text>
                    <Text style={{ color: m.amount_cop >= 0 ? T.green : T.textPri, fontSize: 12, fontWeight: '700' }}>
                      {m.amount_cop >= 0 ? '+' : ''}$ {m.amount_cop.toLocaleString('es-CO')}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

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

          {/* Mensualidad de plataforma + tarjeta */}
          <Text style={styles.sectionTitle}>Mi mensualidad de plataforma</Text>
          <View style={[styles.card, { borderWidth: 1, borderColor: mySubscription && !mySubscription.active ? '#b91c1c' : T.cardBorder, marginBottom: 8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Feather name={mySubscription && !mySubscription.active ? 'alert-triangle' : 'check-circle'} size={16}
                color={mySubscription && !mySubscription.active ? T.dangerText : T.green} />
              <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 14 }}>
                {mySubscription && !mySubscription.active ? 'Cargadores suspendidos' : 'Cargadores activos'}
              </Text>
            </View>
            <Text style={{ color: T.textMuted, fontSize: 12, lineHeight: 18 }}>
              {mySubscription
                ? `${mySubscription.chargers} cargador(es) · $ ${(mySubscription.monthly_fee_cop || 0).toLocaleString('es-CO')} / mes + IVA`
                : 'Cargando…'}
              {mySubscription?.paid_until ? `\nCubierta hasta ${new Date(mySubscription.paid_until).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}` : ''}
            </Text>
            {mySubscription && !mySubscription.has_card && (
              <Text style={{ color: T.dangerText, fontSize: 12, marginTop: 6 }}>
                Asocia una tarjeta para que podamos cobrar la mensualidad y mantener tus cargadores activos.
              </Text>
            )}
            {mySubscription && !mySubscription.active && (
              <Text style={{ color: T.dangerText, fontSize: 12, marginTop: 6 }}>
                Tus cargadores no aparecen en el mapa. Se reactivan cuando se cobre la mensualidad.
              </Text>
            )}
          </View>

          {/* Tarjeta para la mensualidad */}
          {paymentMethods.filter(m => m.type !== 'NEQUI').length === 0 ? (
            <Text style={[styles.emptyHint, { marginBottom: 8 }]}>No tienes tarjeta asociada</Text>
          ) : (
            paymentMethods.filter(m => m.type !== 'NEQUI').map(m => (
              <View key={m.id} style={[styles.card, m.is_default && { borderColor: T.green, borderWidth: 1 }]}>
                <View style={styles.cardHeader}>
                  <Feather name="credit-card" size={16} color={m.is_default ? T.green : T.textMuted} style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.chargerId, { fontSize: 14 }]}>{m.nickname || m.display}</Text>
                    {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }}>{m.display}</Text>}
                  </View>
                  <TouchableOpacity onPress={() => Alert.alert('Eliminar', `¿Eliminar ${m.nickname || m.display}?`, [
                    { text: 'Eliminar', style: 'destructive', onPress: async () => { await apiFetch(`/payment-methods/${m.id}`, { method: 'DELETE' }, token); fetchPaymentMethods(); apiFetch('/my-subscription', {}, token).then(setMySubscription).catch(() => {}); }},
                    { text: 'Cancelar' }
                  ])} style={{ padding: 4 }}>
                    <Feather name="trash-2" size={14} color={T.dangerText} />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
          <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginBottom: 16 }]} onPress={() => setAddMethodModal('card')}>
            <Feather name="credit-card" size={14} color="#fdfbf7" />
            <Text style={styles.btnText}>Agregar tarjeta</Text>
          </TouchableOpacity>

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

              {/* Gráfica de barras: ganancia por día (últimos 7 días) */}
              {myStats.last_7_days?.length > 0 && (() => {
                const days   = myStats.last_7_days;
                const maxNet = Math.max(...days.map(d => d.net_cop), 1);
                const weekTotal = days.reduce((a, d) => a + d.net_cop, 0);
                const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
                return (
                  <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: T.cardBorder }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                      <Text style={{ color: T.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>GANANCIA · 7 DÍAS</Text>
                      <Text style={{ color: T.green, fontSize: 14, fontWeight: '800' }}>$ {weekTotal.toLocaleString('es-CO')}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 80 }}>
                      {days.map((d, i) => {
                        const h        = Math.max(3, Math.round((d.net_cop / maxNet) * 64));
                        const isToday  = i === days.length - 1;
                        const dt       = new Date(d.date + 'T12:00:00');
                        return (
                          <View key={d.date} style={{ flex: 1, alignItems: 'center' }}>
                            <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                              <View style={{ width: 16, height: h, borderRadius: 4, backgroundColor: isToday ? T.green : T.greenLight }} />
                            </View>
                            <Text style={{ color: isToday ? T.green : T.textMuted, fontSize: 10, marginTop: 6, fontWeight: isToday ? '800' : '500' }}>
                              {DOW[dt.getDay()]}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                );
              })()}

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
            showsUserLocation={locStatus === 'granted'}
            showsMyLocationButton={false}
            onPress={() => { Keyboard.dismiss(); setSelectedCharger(null); setMapSearch(''); setGeoResults([]); }}
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
      )}

      {/* ── Panel flotante del mapa — nivel raíz para capturar toques correctamente ── */}
      {tab === 'mapa' && selectedCharger && (() => {
        const c        = chargers.find(x => x.id === selectedCharger.id) || selectedCharger;
        const color    = STATUS_COLOR[c.status] || T.offline;
        const mine     = isOwner && c.owner_id === user?.id;
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.19) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        const myRes    = reservations.find(r => r.charger_id === c.id && r.status === 'active');
        const isResMine  = c.status === 'Reserved' && !!myRes;
        const isResOther = c.status === 'Reserved' && !myRes;
        const distKm   = (userCoords && c.lat != null && c.lng != null)
          ? haversineKm(userCoords, { latitude: c.lat, longitude: c.lng }) : null;
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
              {distKm != null && (
                <View style={styles.specChip}><Text style={styles.specText}>a {formatDistance(distKm)}</Text></View>
              )}
              {c.owner && <View style={styles.specChip}><Text style={styles.specText}>{c.owner}</Text></View>}
            </View>
            {priceUser && (
              <View style={styles.mapPanelPrice}>
                <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                <Text style={styles.mapPanelPriceNote}>IVA incluido</Text>
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
            {!isOwner && (
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
          </View>
        );
      })()}

      {/* ── Barra de navegación inferior ── */}
      {!selectedCharger && !chargerPanel && !qrModal && !payMethodsModal && !addMethodModal && !paymentPending && !addDisbModal && !sessionModal && (
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
        const priceUser = (c.price_per_kwh_now ?? c.price_per_kwh) ? Math.round((c.price_per_kwh_now ?? c.price_per_kwh) * 1.19) : null;
        const isAvail  = c.status === 'Available';
        const isCharg  = c.status === 'Charging';
        const myRes    = reservations.find(r => r.charger_id === c.id && r.status === 'active');
        const isResMine  = c.status === 'Reserved' && !!myRes;
        const isResOther = c.status === 'Reserved' && !myRes;
        const distKm   = (userCoords && c.lat != null && c.lng != null)
          ? haversineKm(userCoords, { latitude: c.lat, longitude: c.lng }) : null;
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
                {distKm != null && (
                  <View style={styles.specChip}><Text style={styles.specText}>a {formatDistance(distKm)}</Text></View>
                )}
                {c.rating_total > 0 && (
                  <View style={styles.specChip}><Text style={styles.specText}>👍 {c.rating_pct}% ({c.rating_total})</Text></View>
                )}
              </View>

              {/* Precio */}
              {priceUser && (
                <View style={styles.mapPanelPrice}>
                  <View>
                    <Text style={styles.mapPanelPriceVal}>$ {priceUser.toLocaleString('es-CO')} / kWh</Text>
                    <Text style={styles.mapPanelPriceNote}>IVA incluido · {c.owner}</Text>
                  </View>
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

              {/* Acciones conductor */}
              {!isOwner && (
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
    </View>
  );
}
