import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { PLATFORM_MARGIN } from '../constants';
import { useApp } from '../context/AppContext';

// Pantalla "Plataforma" (admin). Solo lee adminSummary del context.
export function AdminScreen() {
  const { adminSummary } = useApp();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>

      {/* Banner Sandbox */}
      <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: T.warning, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Feather name="alert-triangle" size={16} color={T.warning} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 13 }}>Modo Sandbox — datos de prueba</Text>
          <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>
            Los números de abajo vienen de tu DB local. Para ver transacciones reales: sandbox.wompi.co
          </Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Panel CPO</Text>

      {adminSummary ? (
        <>
          {/* Estadísticas generales */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            {[
              { label: 'Sesiones', value: adminSummary.total_sessions },
              { label: 'kWh', value: adminSummary.total_kwh?.toFixed(1) },
              { label: 'Conductores', value: adminSummary.total_conductors },
              { label: 'Dueños', value: adminSummary.total_owners },
            ].map(s => (
              <View key={s.label} style={{ flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
                <Text style={{ color: T.textPri, fontSize: 18, fontWeight: '700' }}>{s.value}</Text>
                <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>{s.label}</Text>
              </View>
            ))}
          </View>

          {/* Flujo de dinero — solo datos locales */}
          <Text style={styles.sectionTitle}>Flujo de dinero (DB local)</Text>

          <View style={[styles.card, { borderColor: T.green, borderWidth: 1.5, marginBottom: 8 }]}>
            <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 4 }}>Total cobrado a conductores</Text>
            <Text style={{ color: T.green, fontSize: 28, fontWeight: '800' }}>
              $ {(adminSummary.collected_conductors_cop || 0).toLocaleString('es-CO')}
              <Text style={{ fontSize: 14, fontWeight: '400' }}> COP</Text>
            </Text>
            <View style={{ height: 1, backgroundColor: T.cardBorder, marginVertical: 10 }} />
            <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 2 }}>Saldo estimado (cobrado − dispersado a dueños)</Text>
            <Text style={{ color: T.textPri, fontSize: 18, fontWeight: '700' }}>
              $ {(adminSummary.balance_wompi_cop || 0).toLocaleString('es-CO')} COP
            </Text>
          </View>

          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
            <View style={[styles.card, { flex: 1 }]}>
              <Text style={{ color: T.textMuted, fontSize: 11 }}>Cobrado a conductores</Text>
              <Text style={{ color: T.textPri, fontSize: 16, fontWeight: '700', marginTop: 4 }}>
                $ {(adminSummary.collected_conductors_cop || 0).toLocaleString('es-CO')}
              </Text>
            </View>
            <View style={[styles.card, { flex: 1 }]}>
              <Text style={{ color: T.textMuted, fontSize: 11 }}>Dispersado a dueños</Text>
              <Text style={{ color: '#b91c1c', fontSize: 16, fontWeight: '700', marginTop: 4 }}>
                − $ {(adminSummary.disbursed_owners_cop || 0).toLocaleString('es-CO')}
              </Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Mi ganancia (detalle)</Text>
          {[
            { label: `Comisión Faro ${Math.round(PLATFORM_MARGIN * 100)}%`, value: adminSummary.commission_cpo_cop, color: T.green },
            { label: 'IVA cobrado (remitir a DIAN)', value: adminSummary.iva_cop, color: T.warningText },
            { label: 'Fee pasarela Wompi', value: adminSummary.gateway_cop, color: T.textMuted },
          ].map(r => (
            <View key={r.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.cardBorder }}>
              <Text style={{ color: T.textMuted, fontSize: 13 }}>{r.label}</Text>
              <Text style={{ color: r.color, fontSize: 13, fontWeight: '600' }}>
                $ {(r.value || 0).toLocaleString('es-CO')}
              </Text>
            </View>
          ))}

          {/* Estado de dispersiones */}
          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Dispersiones a dueños</Text>

          {!adminSummary.wompi_dispersiones_activas && adminSummary.disb_pending_activation > 0 && (
            <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.warning }}>
              <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>
                ⚠ Dispersiones no activadas en Wompi
              </Text>
              <Text style={{ color: T.warningText, fontSize: 12, lineHeight: 18 }}>
                Hay <Text style={{ fontWeight: '700' }}>{adminSummary.disb_pending_activation} pagos</Text> por{' '}
                <Text style={{ fontWeight: '700' }}>$ {(adminSummary.disb_pending_activation_cop || 0).toLocaleString('es-CO')} COP</Text>{' '}
                guardados pero no enviados.{'\n\n'}
                Para activarlo:{'\n'}
                1. Entra a <Text style={{ color: T.green }}>sandbox.wompi.co</Text>{'\n'}
                2. Configuración → Dispersiones{'\n'}
                3. Activa el módulo y escríbele a Wompi soporte
              </Text>
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Enviadas', value: adminSummary.disb_sent, color: T.green },
              { label: 'Esperando Wompi', value: adminSummary.disb_pending_activation, color: T.warning },
              { label: 'Fallidas', value: adminSummary.disb_failed, color: '#b91c1c' },
            ].map(d => (
              <View key={d.label} style={{ flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.cardBorder }}>
                <Text style={{ color: d.color, fontSize: 20, fontWeight: '700' }}>{d.value}</Text>
                <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 2, textAlign: 'center' }}>{d.label}</Text>
              </View>
            ))}
          </View>

          {/* Últimas sesiones */}
          {adminSummary.recent_sessions?.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Últimas sesiones</Text>
              {adminSummary.recent_sessions.map(s => (
                <View key={s.id} style={[styles.card, { marginBottom: 8 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: T.textPri, fontSize: 13, fontWeight: '600' }}>{s.charger_id}</Text>
                    <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>
                      $ {(s.total_charged || 0).toLocaleString('es-CO')}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={{ color: T.textMuted, fontSize: 12 }}>{s.session_user}</Text>
                    <Text style={{ color: T.textMuted, fontSize: 12 }}>{s.kwh_delivered?.toFixed(2)} kWh · comisión $ {(s.commission_cpo || 0).toLocaleString('es-CO')}</Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      ) : (
        <Text style={[styles.emptyHint, { marginTop: 32 }]}>Cargando datos de la plataforma...</Text>
      )}
    </ScrollView>
  );
}
