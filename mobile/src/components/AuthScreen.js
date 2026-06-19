import React, { useState } from 'react';
import { StyleSheet, Text, View, FlatList, TextInput, TouchableOpacity, RefreshControl, StatusBar, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, ImageBackground, Linking, Keyboard } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { apiFetch } from '../api';
import { FaroLogo } from './FaroLogo';

export function AuthScreen({ onLogin }) {
  const [mode, setMode]       = useState('login');    // 'login' | 'register'
  const [email, setEmail]     = useState('');
  const [name, setName]       = useState('');
  const [password, setPass]   = useState('');
  const [role, setRole]       = useState('conductor');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [info, setInfo]       = useState('');
  const [pending, setPending] = useState(null);  // {email, role} → esperando verificación
  const [acceptTerms, setAcceptTerms] = useState(false);  // Habeas Data: aceptar T&C

  const submit = async () => {
    setError(''); setInfo('');
    if (!email || !password || (mode === 'register' && !name)) {
      setError('Completa todos los campos');
      return;
    }
    if (mode === 'register' && !acceptTerms) {
      setError('Debes aceptar los Términos y la Política de Privacidad');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        const data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, role }) });
        await SecureStore.setItemAsync('token', data.token);
        await SecureStore.setItemAsync('user', JSON.stringify(data.user));
        onLogin(data.token, data.user);
      } else {
        const data = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password, role, accept_terms: acceptTerms }) });
        // El registro NO inicia sesión: hay que confirmar el correo primero.
        setPending({ email: data.email || email.trim().toLowerCase(), role: data.role || role });
      }
    } catch (e) {
      // Si el login es de una cuenta sin verificar, mostrar la pantalla de pendiente
      if (/confirma tu correo/i.test(e.message || '')) setPending({ email: email.trim().toLowerCase(), role });
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const forgot = async () => {
    setError(''); setInfo('');
    if (!email) { setError('Escribe tu correo para enviarte el enlace'); return; }
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim().toLowerCase(), role }) });
      setInfo('Si el correo existe, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja (y spam).');
    } catch (e) { setError(e.message); }
  };

  const resend = async () => {
    setError(''); setInfo('');
    try {
      await apiFetch('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: pending.email, role: pending.role }) });
      setInfo('Te reenviamos el correo. Revisa tu bandeja (y spam).');
    } catch (e) { setError(e.message); }
  };

  return (
    <ImageBackground
      source={require('../../assets/images/Login.png')}
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

        {pending ? (
          /* ── Esperando verificación de correo ── */
          <View style={[styles.authForm, { alignItems: 'center' }]}>
            <Feather name="mail" size={40} color={T.green} style={{ marginVertical: 14 }} />
            <Text style={{ color: T.textPri, fontWeight: '800', fontSize: 18, marginBottom: 8 }}>Revisa tu correo</Text>
            <Text style={{ color: T.textSec, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              Te enviamos un enlace de verificación a{'\n'}<Text style={{ fontWeight: '700' }}>{pending.email}</Text>.
              {'\n'}Confírmalo para poder entrar.
            </Text>
            {info ? <Text style={[styles.authError, { color: T.green }]}>{info}</Text> : null}
            {error ? <Text style={styles.authError}>{error}</Text> : null}

            <TouchableOpacity style={[styles.authSubmit, { marginTop: 18 }]} onPress={() => { setPending(null); setMode('login'); setInfo(''); setError(''); }}>
              <Text style={styles.authSubmitText}>Ya confirmé, ingresar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginTop: 14 }} onPress={resend}>
              <Text style={{ color: T.green, fontWeight: '600', fontSize: 13 }}>Reenviar correo</Text>
            </TouchableOpacity>
          </View>
        ) : (
        <>
        {/* Tabs login / registro */}
        <View style={styles.authTabs}>
          <TouchableOpacity style={[styles.authTab, mode === 'login' && styles.authTabActive]} onPress={() => { setMode('login'); setError(''); setInfo(''); }}>
            <Text style={[styles.authTabText, mode === 'login' && styles.authTabTextActive]}>Ingresar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.authTab, mode === 'register' && styles.authTabActive]} onPress={() => { setMode('register'); setError(''); setInfo(''); }}>
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

          {/* Selector de rol (también en login: el correo puede tener cuenta de conductor y de dueño) */}
          <View style={styles.roleRow}>
            <Text style={styles.roleLabel}>Soy:</Text>
            <TouchableOpacity style={[styles.roleBtn, role === 'conductor' && styles.roleBtnActive]} onPress={() => setRole('conductor')}>
              <Text style={[styles.roleBtnText, role === 'conductor' && styles.roleBtnTextActive]}>Conductor</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.roleBtn, role === 'owner' && styles.roleBtnActive]} onPress={() => setRole('owner')}>
              <Text style={[styles.roleBtnText, role === 'owner' && styles.roleBtnTextActive]}>Dueño de cargador</Text>
            </TouchableOpacity>
          </View>

          {/* Habeas Data: aceptación de T&C + Privacidad (obligatorio para registrarse) */}
          {mode === 'register' && (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setAcceptTerms(v => !v)}
              style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginTop: 4, marginBottom: 2 }}
            >
              <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, marginTop: 1,
                borderColor: acceptTerms ? T.green : '#94866f',
                backgroundColor: acceptTerms ? T.green : 'transparent',
                alignItems: 'center', justifyContent: 'center' }}>
                {acceptTerms && <Feather name="check" size={13} color="#fff" />}
              </View>
              <Text style={{ flex: 1, color: T.textSec, fontSize: 12.5, lineHeight: 18 }}>
                Acepto los{' '}
                <Text style={{ color: T.green, fontWeight: '700' }}
                  onPress={() => Linking.openURL('https://faroenergy.lat/terminos.html')}>Términos</Text>
                {' '}y la{' '}
                <Text style={{ color: T.green, fontWeight: '700' }}
                  onPress={() => Linking.openURL('https://faroenergy.lat/privacidad.html')}>Política de Privacidad</Text>.
              </Text>
            </TouchableOpacity>
          )}

          {error ? <Text style={styles.authError}>{error}</Text> : null}
          {info ? <Text style={[styles.authError, { color: T.green }]}>{info}</Text> : null}

          <TouchableOpacity style={styles.authSubmit} onPress={submit} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.authSubmitText}>{mode === 'login' ? 'Ingresar' : 'Crear cuenta'}</Text>
            }
          </TouchableOpacity>

          {mode === 'login' && (
            <TouchableOpacity onPress={forgot} style={{ alignSelf: 'center', marginTop: 12 }}>
              <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>¿Olvidaste tu contraseña?</Text>
            </TouchableOpacity>
          )}

          {mode === 'register' && (
            <Text style={[styles.seedText, { textAlign: 'center', marginTop: 12 }]}>
              Te enviaremos un correo para confirmar tu cuenta antes de entrar.
            </Text>
          )}
        </View>
        </>
        )}
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
