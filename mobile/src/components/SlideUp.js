import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

// Panel que sube con resorte al aparecer. useNativeDriver → corre fuera del hilo JS
// (60fps, no cuesta rendimiento del mapa).
export function SlideUp({ children, style }) {
  const ty = useRef(new Animated.Value(36)).current;
  const op = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(ty, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 200, mass: 0.7 }),
      Animated.timing(op, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={[style, { transform: [{ translateY: ty }], opacity: op }]}>{children}</Animated.View>;
}
