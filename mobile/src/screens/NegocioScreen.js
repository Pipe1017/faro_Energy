import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Linking, RefreshControl } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { T } from '../theme';
import { styles } from '../styles';
import { apiFetch, API_URL } from '../api';
import { useApp } from '../context/AppContext';

// Pantalla "Negocio" (dueño): alertas, mensualidad+tarjeta, gráfica 7 días, saldo por
// cobrar + retiro, cuenta de dispersión e historial de sesiones con desglose.
export function NegocioScreen() {
  const {
    ownerEvents, setOwnerEvents, mySubscription, setMySubscription, paymentMethods,
    fetchPaymentMethods, setAddMethodModal, myStats, balance, withdrawing, withdrawBalance,
    myDisburses, disbAccount, verifyDisbAccount, setDisbForm, setAddDisbModal,
    earnings, ownerSessionsShown, setOwnerSessionsShown, token, refreshNegocio,
  } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => { setRefreshing(true); try { await refreshNegocio(); } finally { setRefreshing(false); } };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.green} />}>

      {/* Alertas del dueño */}
      {ownerEvents?.events?.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.sectionTitle}>
              Alertas{ownerEvents.unread_count > 0 ? ` (${ownerEvents.unread_count} nuevas)` : ''}
            </Text>
            {ownerEvents.unread_count > 0 && (
              <TouchableOpacity onPress={async () => {
                try {
                  await apiFetch('/my-events/read', { method: 'POST' }, token);
                  setOwnerEvents(ev => ({ ...ev, unread_count: 0, events: ev.events.map(e => ({ ...e, read: true })) }));
                } catch {}
              }}>
                <Text style={{ color: T.green, fontSize: 12, fontWeight: '600' }}>Marcar leídas</Text>
              </TouchableOpacity>
            )}
          </View>
          {ownerEvents.events.slice(0, 5).map(e => {
            const evIcon  = e.type === 'CHARGER_OFFLINE' ? 'wifi-off' : e.type === 'PAYMENT_UNPAID' ? 'alert-triangle'
                          : e.type === 'SETTLEMENT_SENT' ? 'send' : e.type === 'SESSION_STARTED' ? 'zap' : 'check-circle';
            const evColor = e.type === 'CHARGER_OFFLINE' || e.type === 'PAYMENT_UNPAID' ? T.warningText : T.green;
            return (
              <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: e.read ? T.surface : T.card, borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: e.read ? T.cardBorder : T.greenDark }}>
                <Feather name={evIcon} size={15} color={evColor} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: e.read ? T.textMuted : T.textPri, fontSize: 12, lineHeight: 17 }}>{e.message}</Text>
                  <Text style={{ color: T.textMuted, fontSize: 10, marginTop: 2 }}>
                    {new Date(e.created_at).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Mensualidad de plataforma + tarjeta */}
      <Text style={styles.sectionTitle}>Mi mensualidad de plataforma</Text>
      <View style={[styles.card, { borderWidth: 1, borderColor: mySubscription && !mySubscription.active ? '#b91c1c' : T.cardBorder, marginBottom: 8 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Feather name={mySubscription && !mySubscription.active ? 'alert-triangle' : 'check-circle'} size={16}
            color={mySubscription && !mySubscription.active ? T.dangerText : T.green} />
          <Text style={{ color: T.textPri, fontWeight: '700', fontSize: 14 }}>
            {mySubscription && !mySubscription.active ? 'Cargadores suspendidos' : 'Cargadores activos'}
          </Text>
        </View>
        <Text style={{ color: T.textMuted, fontSize: 12, lineHeight: 18 }}>
          {mySubscription
            ? `${mySubscription.chargers} cargador(es) · $ ${(mySubscription.monthly_fee_cop || 0).toLocaleString('es-CO')} / mes + IVA`
            : 'Cargando…'}
          {mySubscription?.paid_until ? `\nCubierta hasta ${new Date(mySubscription.paid_until).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}` : ''}
        </Text>
        {mySubscription && !mySubscription.has_card && (
          <Text style={{ color: T.dangerText, fontSize: 12, marginTop: 6 }}>
            Asocia una tarjeta para que podamos cobrar la mensualidad y mantener tus cargadores activos.
          </Text>
        )}
        {mySubscription && !mySubscription.active && (
          <Text style={{ color: T.dangerText, fontSize: 12, marginTop: 6 }}>
            Tus cargadores no aparecen en el mapa. Se reactivan cuando se cobre la mensualidad.
          </Text>
        )}
      </View>

      {/* Tarjeta para la mensualidad */}
      {paymentMethods.filter(m => m.type !== 'NEQUI').length === 0 ? (
        <Text style={[styles.emptyHint, { marginBottom: 8 }]}>No tienes tarjeta asociada</Text>
      ) : (
        paymentMethods.filter(m => m.type !== 'NEQUI').map(m => (
          <View key={m.id} style={[styles.card, m.is_default && { borderColor: T.green, borderWidth: 1 }]}>
            <View style={styles.cardHeader}>
              <Feather name="credit-card" size={16} color={m.is_default ? T.green : T.textMuted} style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.chargerId, { fontSize: 14 }]}>{m.nickname || m.display}</Text>
                {m.nickname && <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 1 }}>{m.display}</Text>}
              </View>
              <TouchableOpacity onPress={() => Alert.alert('Eliminar', `¿Eliminar ${m.nickname || m.display}?`, [
                { text: 'Eliminar', style: 'destructive', onPress: async () => { await apiFetch(`/payment-methods/${m.id}`, { method: 'DELETE' }, token); fetchPaymentMethods(); apiFetch('/my-subscription', {}, token).then(setMySubscription).catch(() => {}); }},
                { text: 'Cancelar' }
              ])} style={{ padding: 4 }}>
                <Feather name="trash-2" size={14} color={T.dangerText} />
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}
      <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginBottom: 16 }]} onPress={() => setAddMethodModal('card')}>
        <Feather name="credit-card" size={14} color="#fdfbf7" />
        <Text style={styles.btnText}>Agregar tarjeta</Text>
      </TouchableOpacity>

      {/* Gráfica: lo que entró a tu saldo por día (últimos 7 días) */}
      {myStats?.last_7_days?.length > 0 && (() => {
        const days   = myStats.last_7_days;
        const maxNet = Math.max(...days.map(d => d.net_cop), 1);
        const weekTotal = days.reduce((a, d) => a + d.net_cop, 0);
        const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
        return (
          <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: T.cardBorder }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <Text style={{ color: T.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>A TU SALDO · 7 DÍAS</Text>
              <Text style={{ color: T.green, fontSize: 14, fontWeight: '800' }}>$ {weekTotal.toLocaleString('es-CO')}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 80 }}>
              {days.map((d, i) => {
                const h        = Math.max(3, Math.round((d.net_cop / maxNet) * 64));
                const isToday  = i === days.length - 1;
                const dt       = new Date(d.date + 'T12:00:00');
                return (
                  <View key={d.date} style={{ flex: 1, alignItems: 'center' }}>
                    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                      <View style={{ width: 16, height: h, borderRadius: 4, backgroundColor: isToday ? T.green : T.greenLight }} />
                    </View>
                    <Text style={{ color: isToday ? T.green : T.textMuted, fontSize: 10, marginTop: 6, fontWeight: isToday ? '800' : '500' }}>
                      {DOW[dt.getDay()]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })()}

      {/* Config de cargadores ahora vive en su propia pestaña */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.surface, borderRadius: 10, padding: 10, marginBottom: 14, borderWidth: 1, borderColor: T.cardBorder }}>
        <Feather name="zap" size={14} color={T.green} />
        <Text style={{ color: T.textSec, fontSize: 12, flex: 1 }}>Configura precios y agrega cargadores en la pestaña <Text style={{ fontWeight: '700', color: T.textPri }}>Mis cargadores</Text>.</Text>
      </View>

      {/* Saldo disponible y retiro */}
      {balance && (
        <View style={[styles.card, { borderColor: T.greenDark, borderWidth: 1.5, marginBottom: 16 }]}>
          <Text style={{ color: T.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}>TU SALDO POR COBRAR</Text>
          <Text style={{ color: T.green, fontSize: 32, fontWeight: '800', marginTop: 4 }}>
            $ {balance.balance_cop.toLocaleString('es-CO')}
            <Text style={{ fontSize: 15, fontWeight: '600', color: T.textSec }}>  COP</Text>
          </Text>
          <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 4 }}>
            Tu ganancia de cada carga (ya con la comisión descontada) se suma aquí y baja cuando te pagamos.
          </Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
            {balance.in_transit_cop > 0 && (
              <Text style={{ color: T.textSec, fontSize: 12 }}>En camino: $ {balance.in_transit_cop.toLocaleString('es-CO')}</Text>
            )}
            {balance.pending_activation_cop > 0 && (
              <Text style={{ color: T.warningText, fontSize: 12 }}>En cola Wompi: $ {balance.pending_activation_cop.toLocaleString('es-CO')}</Text>
            )}
            {balance.total_sent_cop > 0 && (
              <Text style={{ color: T.textMuted, fontSize: 12 }}>Recibido: $ {balance.total_sent_cop.toLocaleString('es-CO')}</Text>
            )}
          </View>
          <TouchableOpacity
            disabled={withdrawing || balance.balance_cop < balance.min_withdraw_cop}
            style={[styles.btn, {
              marginTop: 12, paddingVertical: 12,
              backgroundColor: balance.balance_cop >= balance.min_withdraw_cop ? T.green : T.surface,
              borderWidth: 1, borderColor: balance.balance_cop >= balance.min_withdraw_cop ? T.greenDark : T.cardBorder,
              opacity: withdrawing ? 0.6 : 1,
            }]}
            onPress={withdrawBalance}
          >
            <Feather name="arrow-down-circle" size={15} color={balance.balance_cop >= balance.min_withdraw_cop ? T.bg : T.textMuted} />
            <Text style={[styles.btnText, { fontSize: 13, color: balance.balance_cop >= balance.min_withdraw_cop ? T.bg : T.textMuted }]}>
              {withdrawing ? 'Procesando…'
                : balance.balance_cop >= balance.min_withdraw_cop ? 'Retirar a mi cuenta'
                : `Retiro desde $ ${balance.min_withdraw_cop.toLocaleString('es-CO')}`}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 8, lineHeight: 15 }}>
            Giro automático los días 5 y 20 de cada mes (día hábil).
            {balance.next_settlement ? ` Próximo: ${new Date(balance.next_settlement + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}.` : ''}
          </Text>
        </View>
      )}

      {/* Mis pagos pendientes */}
      {myDisburses?.total_pendiente_cop > 0 && (
        <View style={{ backgroundColor: T.warningBg, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: T.warning }}>
          <Text style={{ color: T.warningText, fontWeight: '700', fontSize: 14, marginBottom: 4 }}>
            Pago pendiente: $ {myDisburses.total_pendiente_cop.toLocaleString('es-CO')} COP
          </Text>
          <Text style={{ color: T.warningText, fontSize: 12, lineHeight: 18 }}>
            Tu dinero ya está registrado pero Wompi no tiene activado el módulo de Dispersiones en esta cuenta aún.{'\n'}
            Cuando el admin active la función, recibirás el pago automáticamente.
          </Text>
        </View>
      )}
      {myDisburses?.total_enviado_cop > 0 && (
        <View style={{ backgroundColor: T.greenFaint, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: T.greenDark }}>
          <Text style={{ color: T.green, fontWeight: '700', fontSize: 14 }}>
            Total recibido: $ {myDisburses.total_enviado_cop.toLocaleString('es-CO')} COP
          </Text>
        </View>
      )}

      {/* Cuenta de dispersión */}
      <Text style={styles.sectionTitle}>Cuenta para recibir pagos</Text>

      {/* Explicación del flujo de dinero */}
      <View style={{ backgroundColor: T.surface, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.cardBorder }}>
        <Text style={{ color: T.textMuted, fontSize: 12, lineHeight: 18 }}>
          <Text style={{ color: T.green, fontWeight: '600' }}>¿Cómo funciona?{'\n'}</Text>
          1. El conductor paga → el dinero llega a la cuenta CPO en Wompi{'\n'}
          2. Confirmado el cobro, tu ganancia se abona a tu saldo (kWh × tu precio base){'\n'}
          3. Retiras cuando quieras — o el giro sale solo al acumular suficiente
        </Text>
      </View>

      {disbAccount ? (
        <View style={[styles.card, { borderColor: disbAccount.verified ? T.green : T.warning, borderWidth: 1.5 }]}>
          <View style={styles.cardHeader}>
            <Feather name={disbAccount.type === 'NEQUI' ? 'smartphone' : 'credit-card'} size={16} color={disbAccount.verified ? T.green : T.warning} style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.chargerId}>{disbAccount.display}</Text>
              <Text style={{ color: T.textMuted, fontSize: 12 }}>{disbAccount.holder_name}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: disbAccount.verified ? T.greenFaint : '#fbf0dc', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
              <Feather name={disbAccount.verified ? 'check-circle' : 'alert-circle'} size={12} color={disbAccount.verified ? T.green : T.warning} />
              <Text style={{ color: disbAccount.verified ? T.green : T.warning, fontSize: 11, fontWeight: '600' }}>
                {disbAccount.verified ? 'Verificada' : 'Sin verificar'}
              </Text>
            </View>
          </View>
          {!disbAccount.verified && (
            <View style={{ backgroundColor: T.warningBg, borderRadius: 8, padding: 10, marginTop: 8 }}>
              <Text style={{ color: T.warningText, fontSize: 12, marginBottom: 8 }}>
                ⚠ La cuenta no está verificada. Sin verificación no recibirás los pagos al terminar las sesiones.
              </Text>
              <TouchableOpacity style={[styles.btn, { backgroundColor: T.greenDark, borderWidth: 1, borderColor: T.warning, marginTop: 0, paddingVertical: 10 }]} onPress={verifyDisbAccount}>
                <Feather name="zap" size={14} color="#fdfbf7" />
                <Text style={[styles.btnText, { fontSize: 13 }]}>Verificar cuenta ahora ($500 prueba)</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 8 }]} onPress={() => { setDisbForm({ type: disbAccount.type, phone: '', account_number:'', bank_code:'', account_type:'SAVINGS', holder_name: disbAccount.holder_name, holder_id:'' }); setAddDisbModal(true); }}>
            <Feather name="edit-2" size={13} color={T.textMuted} />
            <Text style={[styles.btnText, { color: T.textMuted }]}>Cambiar cuenta</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={{ backgroundColor: '#fbe7e7', borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#b91c1c' }}>
            <Text style={{ color: '#b91c1c', fontSize: 12 }}>⚠ Sin cuenta registrada no recibirás tus ganancias.</Text>
          </View>
          <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={() => setAddDisbModal(true)}>
            <Feather name="plus" size={16} color="#fdfbf7" />
            <Text style={styles.btnText}>Agregar cuenta para cobros</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Historial de sesiones con desglose */}
      {earnings?.sessions?.length > 0 && (
        <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.sectionTitle}>Últimas sesiones</Text>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
              onPress={() => Linking.openURL(`${API_URL}/my-earnings/export?token=${token}`)}>
              <Feather name="download" size={12} color={T.green} />
              <Text style={{ color: T.green, fontSize: 12, fontWeight: '600' }}>Exportar CSV</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ color: T.textMuted, fontSize: 11, marginBottom: 6 }}>{earnings.sessions.length} sesiones · exporta el CSV para verlas todas</Text>
          {earnings.sessions.slice(0, ownerSessionsShown).map(s => {
            const when = s.ended_at || s.started_at
              ? new Date(s.ended_at || s.started_at).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
              : '—';
            // Separación (reserva): se muestra distinto, sin kWh
            if (s.kind === 'reservation') {
              return (
                <View key={s.id} style={styles.sessionHistCard}>
                  <View style={styles.sessionHistHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Feather name="clock" size={12} color={T.textSec} />
                      <Text style={styles.sessionHistId}>Separación</Text>
                    </View>
                    <Text style={styles.sessionHistRevenue}>+ $ {(s.net_profit_owner || 0).toLocaleString('es-CO')}</Text>
                  </View>
                  <Text style={styles.sessionHistLocation}>{s.location}</Text>
                  <Text style={[styles.sessionHistDetail, { marginTop: 2 }]}>a tu saldo · {when}</Text>
                </View>
              );
            }
            const who = (s.session_user || '').includes('@')
              ? s.session_user.slice(0, 3) + '•••@' + s.session_user.split('@')[1]
              : (s.session_user || 'Conductor');
            // Lo que entra a TU SALDO en esta sesión = recarga − comisión − IVA comisión
            const recibe = Math.round((s.total_charged || 0) - (s.commission_cpo || 0) * 1.19);
            return (
              <View key={s.id} style={styles.sessionHistCard}>
                <View style={styles.sessionHistHeader}>
                  <Text style={styles.sessionHistId}>{s.charger_id}</Text>
                  <Text style={styles.sessionHistRevenue}>+ $ {recibe.toLocaleString('es-CO')}</Text>
                </View>
                <Text style={styles.sessionHistLocation}>{s.location}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <Feather name="user" size={11} color={T.textMuted} />
                  <Text style={styles.sessionHistDetail}>{who}</Text>
                  <Text style={[styles.sessionHistDetail, { marginLeft: 'auto' }]}>{when}</Text>
                </View>
                <View style={styles.sessionHistRow}>
                  <Text style={styles.sessionHistDetail}>{s.kwh_delivered} kWh</Text>
                  <Text style={styles.sessionHistDetail}>a tu saldo · luz $ {s.electricity_cost.toLocaleString('es-CO')}</Text>
                </View>
              </View>
            );
          })}
          {earnings.sessions.length > 6 && (
            <TouchableOpacity style={{ paddingVertical: 10, alignItems: 'center' }}
              onPress={() => setOwnerSessionsShown(n => n < earnings.sessions.length ? n + 10 : 6)}>
              <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>
                {ownerSessionsShown < earnings.sessions.length
                  ? `Ver ${Math.min(10, earnings.sessions.length - ownerSessionsShown)} más`
                  : 'Ver menos'}
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {earnings?.sessions?.length === 0 && (
        <View style={styles.empty}>
          <Feather name="bar-chart-2" size={40} color={T.textMuted} />
          <Text style={[styles.emptyText, { marginTop: 16 }]}>Sin sesiones aún</Text>
          <Text style={styles.emptyHint}>Activa un cargador para ver tus ganancias</Text>
        </View>
      )}
    </ScrollView>
  );
}
