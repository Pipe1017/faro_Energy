import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

export function FaroLogo({ height = 84, bolt = '#faf7f1' }) {
  const width = height * 56 / 100;
  return (
    <Svg width={width} height={height} viewBox="20 10 56 100">
      <Path d="M48 16 L62 30 L34 30 Z" fill="#2b2520" />
      <Path d="M35 30 L61 30 L62 40 L34 40 Z" fill="#b45309" />
      <Path d="M34 40 L62 40 L66 96 L30 96 Z" fill="#2b2520" />
      <Path d="M51 46 L42 68 L48 68 L45 88 L57 64 L51 64 Z" fill={bolt} />
      <Rect x="27" y="95" width="42" height="7" rx="2" fill="#b45309" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Screen
// ─────────────────────────────────────────────────────────────────────────────
