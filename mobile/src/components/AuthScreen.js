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
