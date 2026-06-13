import { useState, useEffect } from 'react';
import { Platform, Keyboard, View } from 'react-native';

export function useKeyboardHeight() {
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

export function KbSheet({ children }) {
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
