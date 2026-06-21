import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

export function FaroLogo({ height = 84, bolt = '#faf7f1' }) {
  const width = height * 48 / 78;
  return (
    <Svg width={width} height={height} viewBox="36 28 48 78">
      <Rect x="51.5" y="48" width="17" height="9" fill="#b45309" />
      <Path d="M60 36 L70 48 L50 48 Z" fill="#2b2520" stroke="#2b2520" strokeWidth="2.5" strokeLinejoin="round" />
      <Path d="M54 57 L66 57 L71 99 L49 99 Z" fill="#2b2520" />
      <Path d="M61 64 L55 80 L59.5 80 L57 92 L66 74 L61 74 Z" fill={bolt} />
      <Rect x="45" y="99" width="30" height="5" fill="#b45309" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Screen
// ─────────────────────────────────────────────────────────────────────────────
