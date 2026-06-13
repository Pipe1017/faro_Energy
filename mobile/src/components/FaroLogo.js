import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

export function FaroLogo({ height = 84, bolt = '#faf7f1' }) {
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
