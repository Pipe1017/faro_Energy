import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { apiFetch } from '../api';
import { useApp } from '../context/AppContext';

// Pantalla "Mi uso" (conductor): saldo/wallet, historial de cargas y métodos de pago.
export function MiUsoScreen() {
  const {
    wallet, myUsage, reservations, sessionsShown, paymentMethods, token,
    setRecargaAmount, setRecargaModal, requestRefund, cancelReservation,
    setSessionDetail, setSessionsShown, setRenameModal, fetchPaymentMethods, setAddMethodModal,
  } = useApp();

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
      {/* Mi saldo (wallet prepago) */}
      <View style={{ backgroundColor: T.card, borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: T.cardBorder }}>
        <Text style={{ color: T.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}>MI SALDO</Text>
        <Text style={{ color: T.green, fontSize: 34, fontWeight: '800', marginTop: 2, letterSpacing: -1 }}>
          $ {(wallet?.balance_cop ?? 0).toLocaleString('es-CO')}
        </Text>
        {wallet && (wallet.balance_cop ?? 0) < (wallet.low_balance_cop ?? 8000) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, backgroundColor: T.warningBg, borderRadius: 8, padding: 8 }}>
            <Feather name="alert-triangle" size={13} color={T.warningText} />
            <Text style={{ color: T.warningText, fontSize: 12, flex: 1 }}>Saldo bajo: recarga para seguir cargando.</Text>
          </View>
        )}
        <TouchableOpacity style={[styles.btn, styles.btnStart, { marginTop: 12 }]} onPress={() => { setRecargaAmount(wallet?.default_topup_cop || 50000); setRecargaModal(true); }}>
          <Text style={styles.btnText}>Recargar saldo</Text>
        </TouchableOpacity>
        {wallet && (wallet.refundable_cop ?? 0) > 0 && (
          <TouchableOpacity onPress={requestRefund} style={{ alignSelf: 'center', marginTop: 10 }}>
            <Text style={{ color: T.textMuted, fontSize: 12, fontWeight: '600' }}>Solicitar devolución de mi saldo</Text>
          </TouchableOpacity>
        )}
        {wallet?.movements?.length > 0 && (
          <View style={{ marginTop: 14 }}>
            {wallet.movements.slice(0, 4).map(m => (
              <View key={m.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                <Text style={{ color: T.textMuted, fontSize: 12 }}>
                  {m.type === 'TOPUP' ? 'Recarga' : m.type === 'CHARGE' ? 'Carga' : m.type === 'BONUS' ? 'Bono' : m.type === 'REFUND' ? 'Reembolso' : m.type}
                </Text>
                <Text style={{ color: m.amount_cop >= 0 ? T.green : T.textPri, fontSize: 12, fontWeight: '700' }}>
                  {m.amount_cop >= 0 ? '+' : ''}$ {m.amount_cop.toLocaleString('es-CO')}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {myUsage ? (
        <>
          <View style={styles.earningsCard}>
            <Text style={styles.earningsTitle}>Mi consumo total</Text>
            <Text style={styles.earningsAmount}>$ {(myUsage.total_paid_cop || 0).toLocaleString('es-CO')} COP</Text>
            <View style={styles.earningsRow}>
              <View style={styles.earningsStat}>
                <Text style={styles.earningsStatVal}>{myUsage.total_sessions}</Text>
                <Text style={styles.earningsStatLbl}>Sesiones</Text>
              </View>
              <View style={styles.earningsStat}>
                <Text style={styles.earningsStatVal}>{myUsage.total_kwh} kWh</Text>
                <Text style={styles.earningsStatLbl}>Cargados</Text>
              </View>
            </View>
          </View>

          {reservations.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Reservas activas</Text>
              {reservations.map(r => (
                <View key={r.id} style={[styles.card, { borderColor: T.green, borderWidth: 1 }]}>
                  <View style={styles.cardHeader}>
                    <Feather name="clock" size={14} color={T.green} style={{ marginRight: 8 }} />
                    <Text style={styles.chargerId}>{r.charger_id}</Text>
                    <TouchableOpacity onPress={() => cancelReservation(r.id)}>
                      <Text style={{ color: T.dangerText, fontSize: 12 }}>Cancelar</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.location}>{r.location}</Text>
                  <Text style={styles.sessionValue}>Hasta: {new Date(r.end_time).toLocaleTimeString('es-CO')}</Text>
                </View>
              ))}
            </>
          )}

          {myUsage.sessions?.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
                <Text style={styles.sectionTitle}>Historial de cargas</Text>
                <Text style={{ color: T.textMuted, fontSize: 11 }}>{myUsage.sessions.length} sesiones</Text>
              </View>

              {/* Filas compactas */}
              <View style={{ borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: T.cardBorder }}>
                {myUsage.sessions.slice(0, sessionsShown).map((s, i) => {
                  const ps = s.payment_status;
                  const payIcon = ps === 'CAPTURED' ? 'check-circle' : ps === 'UNPAID' ? 'x-circle' : ps === 'PENDING' || ps === 'APPROVED' ? 'clock' : 'minus-circle';
                  const payColor = ps === 'CAPTURED' ? T.green : ps === 'UNPAID' ? T.dangerText : ps === 'PENDING' || ps === 'APPROVED' ? T.warningText : T.textMuted;
                  return (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => setSessionDetail(s)}
                    style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10,
                      backgroundColor: ps === 'UNPAID' ? '#fbe7e7' : i % 2 === 0 ? T.card : T.surface,
                      borderBottomWidth: i < Math.min(sessionsShown, myUsage.sessions.length) - 1 ? 1 : 0,
                      borderBottomColor: T.cardBorder }}
                  >
                    <Feather name={payIcon} size={16} color={payColor} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 13 }}>{s.charger_id}</Text>
                        <Text style={{ color: T.textMuted, fontSize: 11 }}>· {s.kwh_delivered} kWh</Text>
                      </View>
                      <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }} numberOfLines={1}>{s.location}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: ps === 'UNPAID' ? T.dangerText : T.green, fontWeight: '700', fontSize: 13 }}>
                        {ps === 'UNPAID' ? 'Sin cobrar' : `$ ${(s.total_charged || 0).toLocaleString('es-CO')}`}
                      </Text>
                      <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 1 }}>
                        {s.ended_at || s.started_at
                          ? new Date(s.ended_at || s.started_at).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
                          : '—'}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={T.textMuted} />
                  </TouchableOpacity>
                  );})}
              </View>

              {/* Ver más / Ver menos */}
              {myUsage.sessions.length > 5 && (
                <TouchableOpacity
                  style={{ paddingVertical: 10, alignItems: 'center' }}
                  onPress={() => setSessionsShown(s => s < myUsage.sessions.length ? s + 10 : 5)}
                >
                  <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>
                    {sessionsShown < myUsage.sessions.length
                      ? `Ver ${Math.min(10, myUsage.sessions.length - sessionsShown)} más`
                      : 'Ver menos'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* Gestión de métodos de pago */}
          <Text style={styles.sectionTitle}>Mis métodos de pago</Text>
          {paymentMethods.length === 0 ? (
            <Text style={[styles.emptyHint, { marginBottom: 8 }]}>No tienes métodos guardados</Text>
          ) : (
            paymentMethods.map(m => (
              <View key={m.id} style={[styles.card, m.is_default && { borderColor: T.green, borderWidth: 1 }]}>
                <View style={styles.cardHeader}>
                  <Feather name={m.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={16} color={m.is_default ? T.green : T.textMuted} style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.chargerId, { fontSize: 14 }]}>{m.nickname || m.display}</Text>
                    {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }}>{m.display}</Text>}
                  </View>
                  {m.is_default && <View style={styles.mineBadge}><Text style={styles.mineText}>Predeterminado</Text></View>}
                  <TouchableOpacity onPress={() => setRenameModal({ method: m, value: m.nickname || '' })} style={{ padding: 4, marginLeft: 4 }}>
                    <Feather name="edit-2" size={14} color={T.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  {!m.is_default && (
                    <TouchableOpacity style={[styles.btn, styles.btnSecondary, { flex: 1, marginTop: 0, paddingVertical: 8 }]}
                      onPress={async () => { await apiFetch(`/payment-methods/${m.id}/default`, { method: 'PATCH' }, token); fetchPaymentMethods(); }}>
                      <Text style={[styles.btnText, { color: T.textMuted, fontSize: 12 }]}>Predeterminar</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={[styles.btn, { flex: 1, marginTop: 0, paddingVertical: 8, backgroundColor: '#fbe7e7', borderWidth: 1, borderColor: '#b91c1c' }]}
                    onPress={() => Alert.alert('Eliminar', `¿Eliminar ${m.nickname || m.display}?`, [
                      { text: 'Eliminar', style: 'destructive', onPress: async () => { await apiFetch(`/payment-methods/${m.id}`, { method: 'DELETE' }, token); fetchPaymentMethods(); }},
                      { text: 'Cancelar' }
                    ])}>
                    <Feather name="trash-2" size={14} color={T.dangerText} />
                    <Text style={[styles.btnText, { color: T.dangerText, fontSize: 12 }]}>Eliminar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
          <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => setAddMethodModal('card')}>
            <Feather name="credit-card" size={14} color="#fdfbf7" />
            <Text style={styles.btnText}>Agregar tarjeta</Text>
          </TouchableOpacity>

          {myUsage.sessions?.length === 0 && (
            <View style={styles.empty}>
              <Feather name="zap-off" size={40} color={T.textMuted} />
              <Text style={[styles.emptyText, { marginTop: 16 }]}>Sin cargas aún</Text>
              <Text style={styles.emptyHint}>Escanea el QR de un cargador para empezar</Text>
            </View>
          )}
        </>
      ) : (
        <ActivityIndicator color={T.green} style={{ marginTop: 40 }} />
      )}
    </ScrollView>
  );
}
