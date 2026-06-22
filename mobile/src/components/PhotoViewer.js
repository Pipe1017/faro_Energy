import React from 'react';
import { Image, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { styles } from '../styles';

// Visor de foto a pantalla completa. Recibe la URL y el cierre.
export function PhotoViewer({ url, onClose }) {
  if (!url) return null;
  return (
    <TouchableOpacity activeOpacity={1} style={styles.photoViewerOverlay} onPress={onClose}>
      <Image source={{ uri: url }} style={styles.photoViewerImg} resizeMode="contain" />
      <TouchableOpacity style={styles.photoViewerClose} onPress={onClose}>
        <Feather name="x" size={26} color="#fff" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}
