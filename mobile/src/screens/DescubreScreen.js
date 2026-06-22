import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';

// Pestaña del medio del CONDUCTOR — placeholder de la futura página "Descubre":
// publicidad/planes de Faro + promociones de negocios con cargador (come/compra
// mientras cargas). Por ahora un teaser "Próximamente".
export function DescubreScreen() {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.list, { paddingTop: 24 }]}>
      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: T.greenFaint, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.greenDark }}>
          <Feather name="compass" size={28} color={T.green} />
        </View>
        <Text style={{ color: T.textPri, fontSize: 20, fontWeight: '800', marginTop: 14 }}>Descubre</Text>
        <Text style={{ color: T.textMuted, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 19 }}>
          Muy pronto: lugares con cargador donde puedes{'\n'}comer, comprar o pasar el rato mientras cargas.
        </Text>
      </View>

      {[
        { icon: 'coffee', title: 'Carga y disfruta', desc: 'Cafés, restaurantes y tiendas con cargador Faro cerca de ti.' },
        { icon: 'tag', title: 'Promos de negocios', desc: 'Beneficios y descuentos por cargar en sitios aliados.' },
        { icon: 'zap', title: 'Planes Faro', desc: 'Novedades y planes pensados para que cargar te salga mejor.' },
      ].map(c => (
        <View key={c.title} style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
            <Feather name={c.icon} size={18} color={T.green} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.textPri, fontSize: 14, fontWeight: '700' }}>{c.title}</Text>
            <Text style={{ color: T.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 }}>{c.desc}</Text>
          </View>
        </View>
      ))}

      <Text style={{ color: T.textMuted, fontSize: 11, textAlign: 'center', marginTop: 12 }}>
        Próximamente · Faro Energy
      </Text>
    </ScrollView>
  );
}
