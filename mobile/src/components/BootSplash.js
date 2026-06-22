import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Vibration, Platform, Easing } from 'react-native';
import { styles } from '../styles';
import { FaroLogo } from './FaroLogo';

// Pantalla de inicio: el logo del faro CRECE (~1.5 s) con una vibración muy leve.
export function BootSplash() {
  const scale   = useRef(new Animated.Value(0.55)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Vibración muy leve: dos toques cortísimos mientras crece.
    try { Vibration.vibrate(Platform.OS === 'android' ? [0, 12, 120, 12] : 18); } catch (e) {}
    Animated.parallel([
      Animated.timing(scale,   { toValue: 1, duration: 1500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 700,  useNativeDriver: true }),
    ]).start();
  }, []);
  return (
    <View style={styles.bootScreen}>
      <Animated.View style={{ transform: [{ scale }], opacity, alignItems: 'center' }}>
        <FaroLogo height={120} />
        <Text style={{ color: '#2b2520', fontWeight: '800', fontSize: 24, marginTop: 18, letterSpacing: -0.5 }}>
          Faro<Text style={{ color: '#b45309' }}>Energy</Text>
        </Text>
        <Text style={{ color: '#94866f', fontSize: 11, marginTop: 4, letterSpacing: 2.5, fontWeight: '700' }}>CARGA INTELIGENTE</Text>
      </Animated.View>
    </View>
  );
}
