import './style.scss';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Base de la API. En prod apunta al backend (Cloudflare Tunnel).
// Override local: VITE_API_URL=http://localhost:8000 npm run dev
const API_URL = import.meta.env.VITE_API_URL || 'https://api.faroenergy.lat';
const TOKEN_KEY = 'faro_admin_token';

const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || null;
let state = { tab: 'resumen', overview: null, invoices: [], owners: [], users: [],
  invFilter: '', invKind: '', chargersData: { chargers: [], counts: {} },
  ownerDetail: null, commissions: null, comPeriod: 'month' };

// Estado del mapa (Leaflet) — vive fuera del re-render para no recrearlo en cada refresco
let mapInstance = null, markersLayer = null, mapTimer = null;
const STATE_COLOR = { charging: '#4f46e5', available: '#15803d', offline: '#b91c1c' };
const STATE_LABEL = { charging: 'Cargando', available: 'Disponible', offline: 'Fuera de línea' };

function clearMap() {
  if (mapTimer) { clearInterval(mapTimer); mapTimer = null; }
  if (mapInstance) { mapInstance.remove(); mapInstance = null; markersLayer = null; }
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  // Solo el 401 (token inválido/vencido) cierra sesión. El 403 u otros errores
  // se lanzan como error normal — no botan al usuario al login.
  if (res.status === 401) { logout(); throw new Error('Sesión vencida'); }
  if (!res.ok) {
    let detail = `Error ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const cop = (n) => '$' + (n ?? 0).toLocaleString('es-CO');

function logout() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  renderLogin();
}

// ── Login ───────────────────────────────────────────────────────────────────
function renderLogin(error = '') {
  app.innerHTML = `
    <div class="login">
      <div class="login-card">
        <img src="/logo-faro-claro.svg" class="brand-logo" alt="Faro Energy Admin" />
        <div class="brand-sub">Administración · CPO</div>
        <form id="login-form">
          <label>Correo</label>
          <input type="email" id="email" autocomplete="username" placeholder="admin@cpo.com" required />
          <label>Contraseña</label>
          <input type="password" id="password" autocomplete="current-password" required />
          ${error ? `<div class="error">${error}</div>` : ''}
          <button type="submit">Entrar</button>
        </form>
      </div>
    </div>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      if (data.user.role !== 'admin') throw new Error('Esta cuenta no es de administrador');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      renderApp();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

// ── Shell ─────────────────────────────────────────────────────────────────────
function renderApp() {
  clearMap();  // al cambiar de pestaña, soltar el mapa anterior
  const tabs = [['resumen', 'Resumen'], ['mapa', 'Mapa'], ['facturas', 'Facturas'], ['comisiones', 'Comisiones'], ['duenos', 'Dueños'], ['usuarios', 'Usuarios']];
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <img src="/logo-faro-claro.svg" class="brand-logo" alt="Faro Energy Admin" />
        <nav>
          ${tabs.map(([k, l]) => `<button class="nav ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
        </nav>
        <button class="logout" id="logout">Salir</button>
      </aside>
      <main class="content"><div id="view" class="view">Cargando…</div></main>
    </div>`;
  document.getElementById('logout').addEventListener('click', logout);
  app.querySelectorAll('.nav').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; state.ownerDetail = null; state.userDetail = null; renderApp(); }));
  renderTab();
}

async function renderTab() {
  const view = document.getElementById('view');
  try {
    if (state.tab === 'resumen') { state.overview = await api('/admin/overview'); renderResumen(view); }
    else if (state.tab === 'mapa') { state.chargersData = await api('/admin/chargers'); renderMapa(view); }
    else if (state.tab === 'facturas') {
      const p = new URLSearchParams();
      if (state.invFilter) p.set('status', state.invFilter);
      if (state.invKind) p.set('kind', state.invKind);
      state.invoices = await api('/admin/invoices' + (p.toString() ? '?' + p : ''));
      renderFacturas(view);
    }
    else if (state.tab === 'comisiones') { state.commissions = await api('/admin/commissions?period=' + state.comPeriod); renderComisiones(view); }
    else if (state.tab === 'duenos') {
      if (state.ownerDetail) { renderOwnerDetail(view); }
      else { state.owners = await api('/admin/owners'); renderDuenos(view); }
    }
    else if (state.tab === 'usuarios') {
      if (state.userDetail) { renderUserDetail(view); }
      else { state.users = await api('/admin/users'); renderUsuarios(view); }
    }
  } catch (err) {
    view.innerHTML = `<div class="error-box">${err.message}</div>`;
  }
}

// ── Resumen (bolsas) ───────────────────────────────────────────────────────────
function card(label, value, hint = '', tone = '') {
  return `<div class="card ${tone}"><div class="card-label">${label}</div>
    <div class="card-value">${value}</div>${hint ? `<div class="card-hint">${hint}</div>` : ''}</div>`;
}

function renderResumen(view) {
  const o = state.overview;
  view.innerHTML = `
    <h1>Resumen</h1>
    <div class="section-title">Ingreso de Faro · comisión ${o.money.commission_rate_pct ?? 15}%</div>
    <div class="cards">
      ${card('Comisión', cop(o.money.commission_income_cop ?? o.money.faro_revenue_cop), `${o.money.commission_rate_pct ?? 15}% de las cargas`)}
      ${card('Mensualidad', cop(o.money.subscription_income_cop ?? 0), 'plataforma, cobrada a tarjeta')}
      ${card('− Pasarela (Wompi)', cop(o.money.faro_gateway_cost_cop ?? 0), 'la asume Faro')}
      ${card('= Ingreso neto Faro', cop(o.money.faro_net_cop ?? o.money.faro_revenue_cop), '(comisión + mensualidad) − pasarela', 'accent')}
    </div>
    <p class="muted" style="margin:-2px 0 6px;font-size:.85rem;">El conductor y el dueño <b>no pagan</b> la pasarela — la asume Faro en cada recarga del saldo y en cada mensualidad.</p>

    <div class="section-title">Suscripciones de dueños</div>
    <div class="cards">
      ${card('Dueños activos', `${(o.subscriptions?.owners_total ?? 0) - (o.subscriptions?.owners_suspended ?? 0)} / ${o.subscriptions?.owners_total ?? 0}`, 'cargadores habilitados', 'ok')}
      ${card('Suspendidos', o.subscriptions?.owners_suspended ?? 0, 'cargadores ocultos', (o.subscriptions?.owners_suspended ?? 0) ? 'danger' : '')}
      ${card('Mensualidad cobrada', cop(o.money.subscription_income_cop ?? 0), 'ingreso por plataforma')}
    </div>
    <div class="section-title">Otras bolsas</div>
    <div class="cards">
      ${card('IVA por girar a DIAN', cop(o.money.iva_to_dian_cop), 'recaudado, no es ingreso')}
      ${card('Deuda con dueños', cop(o.money.owed_to_owners_cop), 'saldo por pagarles')}
      ${card('Recaudado (histórico)', cop(o.money.collected_cop), 'total cobrado a conductores')}
      ${card('Girado a dueños', cop(o.money.disbursed_cop), 'pagos enviados')}
    </div>
    <div class="section-title">Actividad</div>
    <div class="cards">
      ${card('Sesiones hoy', o.activity.sessions_today, `${o.activity.sessions_total} en total`)}
      ${card('GMV histórico', cop(o.activity.gmv_cop), 'valor total transado')}
      ${card('Cargadores en línea', `${o.chargers.online} / ${o.chargers.total}`, 'conectados por OCPP')}
    </div>
    <div class="section-title">Facturación electrónica</div>
    <div class="cards">
      ${card('Pendientes', o.invoices.pending, 'en cola de emisión')}
      ${card('Emitidas', o.invoices.issued, '', 'ok')}
      ${card('Fallidas', o.invoices.failed, 'requieren reintento', o.invoices.failed ? 'danger' : '')}
    </div>`;
}

// ── Mapa de monitoreo ───────────────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function mapCountsHtml(counts) {
  return `
    ${card('Total', counts.total ?? 0)}
    ${card('En línea', counts.online ?? 0, '', 'ok')}
    ${card('Cargando', counts.charging ?? 0)}
    ${card('Fuera de línea', counts.offline ?? 0, counts.offline ? 'requieren atención' : '', counts.offline ? 'danger' : '')}`;
}

function offlineHtml(chargers) {
  const off = chargers.filter((c) => c.state === 'offline');
  if (!off.length) return `<div class="section-title">Todo en línea ✓</div>`;
  return `<div class="section-title">Fuera de línea (${off.length})</div>
    <table><thead><tr><th>ID</th><th>Lugar</th><th>Dueño</th><th>Última señal</th></tr></thead>
    <tbody>${off.map((c) => `<tr><td>${c.id}</td><td class="muted">${c.location || ''}</td><td>${c.owner || '—'}</td><td class="muted">${fmtTime(c.last_seen)}</td></tr>`).join('')}</tbody></table>`;
}

function renderMapa(view) {
  const { chargers, counts } = state.chargersData;
  view.innerHTML = `
    <h1>Mapa de monitoreo</h1>
    <div id="map-counts" class="cards">${mapCountsHtml(counts)}</div>
    <div class="legend">
      <span><i class="dot" style="background:${STATE_COLOR.available}"></i>Disponible</span>
      <span><i class="dot" style="background:${STATE_COLOR.charging}"></i>Cargando</span>
      <span><i class="dot" style="background:${STATE_COLOR.offline}"></i>Fuera de línea</span>
      <span class="muted" style="margin-left:auto;">Se actualiza cada 20 s</span>
    </div>
    <div id="map"></div>
    <div id="map-offline">${offlineHtml(chargers)}</div>`;

  initMap(chargers);

  // Refresco en vivo sin recrear el mapa (conserva el zoom/posición del usuario)
  mapTimer = setInterval(async () => {
    if (state.tab !== 'mapa') return;
    try {
      state.chargersData = await api('/admin/chargers');
      const cc = document.getElementById('map-counts');
      const oo = document.getElementById('map-offline');
      if (cc) cc.innerHTML = mapCountsHtml(state.chargersData.counts);
      if (oo) oo.innerHTML = offlineHtml(state.chargersData.chargers);
      updateMarkers(state.chargersData.chargers);
    } catch { /* silencioso */ }
  }, 20000);
}

function initMap(chargers) {
  const el = document.getElementById('map');
  if (!el) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  mapInstance = L.map(el).setView([6.22, -75.58], 12);  // Medellín
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(mapInstance);
  markersLayer = L.layerGroup().addTo(mapInstance);
  updateMarkers(chargers, true);
  setTimeout(() => mapInstance && mapInstance.invalidateSize(), 120);
}

function updateMarkers(chargers, fit = false) {
  if (!mapInstance || !markersLayer) return;
  markersLayer.clearLayers();
  const pts = [];
  chargers.forEach((c) => {
    if (c.lat == null || c.lng == null) return;
    const color = STATE_COLOR[c.state] || '#8a7d72';
    const sess = c.state === 'charging'
      ? `<br>⚡ ${c.current_kwh ?? 0} kWh · ${c.session_user || ''}` : '';
    L.circleMarker([c.lat, c.lng], {
      radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1,
    }).bindPopup(
      `<b>${c.id}</b><br>${c.location || ''}<br>` +
      `<span style="color:${color};font-weight:700;">${STATE_LABEL[c.state]}</span> · ${c.power_kw || '?'} kW<br>` +
      `Dueño: ${c.owner || '—'}${sess}`
    ).addTo(markersLayer);
    pts.push([c.lat, c.lng]);
  });
  if (fit && pts.length) mapInstance.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
}

// ── Facturas ────────────────────────────────────────────────────────────────────
function badge(status) {
  const map = { ISSUED: 'ok', PENDING: 'warn', FAILED: 'danger', VOID: 'muted' };
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

function renderFacturas(view) {
  const filters = ['', 'PENDING', 'ISSUED', 'FAILED'];
  const kinds = [['', 'Todos'], ['RECARGA', 'Recarga'], ['COMMISSION', 'Comisión'], ['SUBSCRIPTION', 'Mensualidad']];
  view.innerHTML = `
    <h1>Facturas</h1>
    <div class="filters">
      ${filters.map((f) => `<button class="chip ${state.invFilter === f ? 'active' : ''}" data-f="${f}">${f || 'Todas'}</button>`).join('')}
    </div>
    <div class="filters">
      ${kinds.map(([k, l]) => `<button class="chip ${state.invKind === k ? 'active' : ''}" data-k="${k}">${l}</button>`).join('')}
    </div>
    <table>
      <thead><tr><th>Tipo</th><th>Emisor</th><th>Total</th><th>Estado</th><th>Intentos</th><th>Error</th><th></th></tr></thead>
      <tbody>
        ${state.invoices.length === 0 ? `<tr><td colspan="7" class="empty">Sin facturas</td></tr>` :
          state.invoices.map((i) => `
          <tr>
            <td>${i.kind}</td>
            <td class="muted">${i.issuer}</td>
            <td>${cop(i.total_cop)}</td>
            <td>${badge(i.status)}</td>
            <td>${i.attempts}</td>
            <td class="err">${i.last_error ? i.last_error.slice(0, 60) : ''}</td>
            <td>${i.status !== 'ISSUED' ? `<button class="mini" data-retry="${i.id}">Reintentar</button>` : (i.pdf_url ? `<a class="mini" href="${API_URL}/admin/invoices/${i.id}/pdf?token=${token}" target="_blank">PDF</a>` : '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  view.querySelectorAll('[data-f]').forEach((c) =>
    c.addEventListener('click', () => { state.invFilter = c.dataset.f; renderTab(); }));
  view.querySelectorAll('[data-k]').forEach((c) =>
    c.addEventListener('click', () => { state.invKind = c.dataset.k; renderTab(); }));
  view.querySelectorAll('[data-retry]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '…';
      try { await api(`/admin/invoices/${b.dataset.retry}/retry`, { method: 'POST' }); renderTab(); }
      catch (err) { alert(err.message); b.disabled = false; b.textContent = 'Reintentar'; }
    }));
}

// ── Dueños ────────────────────────────────────────────────────────────────────
function renderDuenos(view) {
  view.innerHTML = `
    <h1>Dueños</h1>
    <p class="muted" style="margin-bottom:12px;">Toca un dueño para ver su estado de cuenta y pagarle.</p>
    <table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Mensualidad</th><th>Saldo</th><th>Cargadores</th><th>IVA</th><th>RUT / KYC</th></tr></thead>
      <tbody>
        ${state.owners.length === 0 ? `<tr><td colspan="7" class="empty">Sin dueños</td></tr>` :
          state.owners.map((o) => `
          <tr class="clickable" data-owner="${o.id}">
            <td>${o.name}</td>
            <td class="muted">${o.email}</td>
            <td>${o.subscription_active === false ? '<span class="badge danger">Suspendido</span>' : '<span class="badge ok">Activo</span>'}</td>
            <td><b>${cop(o.balance_cop)}</b></td>
            <td>${o.chargers}</td>
            <td>${o.responsable_iva ? '<span class="badge ok">Responsable</span>' : '<span class="badge muted">No</span>'}</td>
            <td>${o.kyc_ok ? `<span class="badge ok">${o.rut}</span>` : '<span class="badge danger">Falta</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  view.querySelectorAll('[data-owner]').forEach((r) => r.addEventListener('click', async () => {
    try { state.ownerDetail = await api(`/admin/owners/${r.dataset.owner}`); renderTab(); }
    catch (err) { alert(err.message); }
  }));
}

function renderOwnerDetail(view) {
  const o = state.ownerDetail;
  const s = o.statement;
  const acc = o.disbursement_account;
  view.innerHTML = `
    <button class="mini" id="back" style="background:none;color:#b45309;padding:0;margin-bottom:14px;">← Volver a dueños</button>
    <h1>${o.name}</h1>
    <p class="muted" style="margin-bottom:14px;">${o.email} · tag ${o.tag || '—'} · ${o.responsable_iva ? 'Responsable de IVA' : 'No responsable de IVA'} · KYC: ${o.kyc_ok ? 'OK' : 'Falta RUT'} · Mensualidad plataforma: <b>${cop(o.monthly_fee_cop ?? 0)}</b></p>

    <div class="section-title">Estado de cuenta</div>
    <div class="cards">
      ${card('Recaudado', cop(s.recaudado_cop), 'recargas cobradas')}
      ${card('− Comisión Faro', cop(s.comision_cop))}
      ${card('− Pasarela', cop(s.pasarela_cop))}
      ${card('Ya pagado', cop(s.girado_cop), 'dispersado')}
      ${card('SALDO POR PAGAR', cop(s.saldo_cop), '', 'accent')}
    </div>

    <div class="section-title">Mensualidad de plataforma</div>
    <div class="card" style="max-width:460px;">
      <div style="margin-bottom:8px;">
        Estado: ${o.subscription_active
          ? '<span class="badge ok">Activa — cargadores habilitados</span>'
          : '<span class="badge danger">Suspendida — cargadores ocultos</span>'}
      </div>
      <div class="muted" style="font-size:.85rem;margin-bottom:8px;">
        ${o.chargers.length} cargador(es) · ${cop(o.monthly_fee_cop ?? 0)} / mes + IVA · periodo ${o.current_period || ''}
        ${o.subscription_charged ? ' · <span class="badge ok">cobrada este mes</span>' : ''}<br/>
        ${o.has_card
          ? 'Tarjeta asociada ✓'
          : '<span class="badge danger">El dueño no tiene tarjeta — debe asociarla en la app</span>'}
        ${o.subscription_paid_until ? ` · cubierta hasta ${fmtTime(o.subscription_paid_until)}` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="mini" id="sub" ${(o.subscription_charged || o.chargers.length === 0 || !o.has_card) ? 'disabled' : ''}>
          ${o.subscription_charged ? 'Mensualidad ya cobrada' : `Cobrar a la tarjeta ${cop((o.monthly_fee_cop ?? 0))} + IVA`}
        </button>
        ${o.subscription_active
          ? '<button class="mini" id="suspend" style="background:none;color:#b91c1c;border:1px solid #e7c9c4;">Suspender manual</button>'
          : '<button class="mini" id="reactivate">Reactivar manual</button>'}
      </div>
    </div>

    <div class="section-title">Pago al dueño</div>
    <div class="card" style="max-width:420px;">
      <div class="muted" style="font-size:.85rem;margin-bottom:6px;">
        Cuenta: ${acc ? `${acc.display || (acc.type + ' ' + (acc.phone || acc.account_number || ''))}` : '<span class="badge danger">sin cuenta de dispersión</span>'}
      </div>
      <button class="mini" id="pay" ${s.saldo_cop <= 0 ? 'disabled' : ''}>Registrar pago de ${cop(s.saldo_cop)}</button>
    </div>

    <div class="section-title">Pagos realizados</div>
    <table>
      <thead><tr><th>Fecha</th><th>Monto</th><th>Método</th><th>Referencia</th><th>Estado</th></tr></thead>
      <tbody>
        ${o.disbursements.length === 0 ? `<tr><td colspan="5" class="empty">Sin pagos</td></tr>` :
          o.disbursements.map((d) => `<tr><td class="muted">${fmtTime(d.created_at)}</td><td>${cop(d.amount_cop)}</td>
            <td>${d.method || 'WOMPI'}</td><td class="muted">${d.note || ''}</td><td>${badge(d.status)}</td></tr>`).join('')}
      </tbody>
    </table>

    <div class="section-title">Facturas</div>
    <table>
      <thead><tr><th>Tipo</th><th>Total</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        ${o.invoices.length === 0 ? `<tr><td colspan="4" class="empty">Sin facturas</td></tr>` :
          o.invoices.map((i) => `<tr><td>${i.kind}</td><td>${cop(i.total_cop)}</td><td>${badge(i.status)}</td>
            <td>${i.pdf_url ? `<a class="mini" href="${API_URL}/admin/invoices/${i.id}/pdf?token=${token}" target="_blank">PDF</a>` : ''}</td></tr>`).join('')}
      </tbody>
    </table>

    <div class="section-title">Cargadores (${o.chargers.length}) · ${o.subscription_active
      ? '<span class="badge ok">activos por mensualidad</span>'
      : '<span class="badge danger">desactivados por mensualidad</span>'}</div>
    <table>
      <thead><tr><th>ID</th><th>Lugar</th><th>kW</th><th>Precio</th><th>Mensualidad</th><th>Conexión</th></tr></thead>
      <tbody>
        ${o.chargers.map((c) => `<tr><td>${c.id}</td><td class="muted">${c.location}</td><td>${c.power_kw}</td>
          <td>${cop(c.price)}</td>
          <td>${o.subscription_active ? '<span class="badge ok">Activo</span>' : '<span class="badge danger">Oculto</span>'}</td>
          <td>${c.online ? '<span class="badge ok">En línea</span>' : '<span class="badge danger">Offline</span>'}</td></tr>`).join('')}
      </tbody>
    </table>`;

  document.getElementById('back').addEventListener('click', () => { state.ownerDetail = null; renderTab(); });
  const payBtn = document.getElementById('pay');
  if (payBtn) payBtn.addEventListener('click', () => openPayModal(o));
  const subBtn = document.getElementById('sub');
  if (subBtn && !subBtn.disabled) subBtn.addEventListener('click', () => chargeSubscription(o));
  const suspendBtn = document.getElementById('suspend');
  if (suspendBtn) suspendBtn.addEventListener('click', () => setSubscription(o, false));
  const reactivateBtn = document.getElementById('reactivate');
  if (reactivateBtn) reactivateBtn.addEventListener('click', () => setSubscription(o, true));
}

function chargeSubscription(o) {
  if (!confirm(
    `Cobrar la mensualidad de ${o.current_period} a la tarjeta de ${o.name}?\n\n` +
    `${o.chargers.length} cargador(es) → ${cop(o.monthly_fee_cop ?? 0)} + IVA.\n` +
    `Si la tarjeta es aprobada se habilitan los cargadores; si es rechazada se suspenden.`)) return;
  api(`/admin/owners/${o.id}/charge-subscription`, {
    method: 'POST', body: JSON.stringify({}),
  }).then((r) => {
    if (r.ok) alert(`Mensualidad ${r.period} cobrada: ${cop(r.fee_cop)} + IVA ${cop(r.iva_cop)} = ${cop(r.total_cop)}.\nCargadores habilitados.`);
    else alert(`La tarjeta fue rechazada (${r.status}). El dueño quedó SUSPENDIDO y sus cargadores ocultos hasta que actualice la tarjeta.`);
    return api(`/admin/owners/${o.id}`);
  }).then((d) => { state.ownerDetail = d; renderTab(); })
    .catch((err) => alert(err.message));
}

function setSubscription(o, active) {
  const verb = active ? 'reactivar' : 'suspender';
  if (!confirm(`¿Seguro que quieres ${verb} a ${o.name}?\n\n` +
    (active ? 'Sus cargadores volverán a aparecer en el mapa.' : 'Sus cargadores se ocultarán y no podrán cargar.'))) return;
  api(`/admin/owners/${o.id}/subscription-status`, {
    method: 'POST', body: JSON.stringify({ active }),
  }).then(() => api(`/admin/owners/${o.id}`))
    .then((d) => { state.ownerDetail = d; renderTab(); })
    .catch((err) => alert(err.message));
}

function openPayModal(o) {
  const note = prompt(
    `Registrar pago manual a ${o.name} por ${cop(o.statement.saldo_cop)}.\n\n` +
    `Escribe la referencia del pago (ej. "Nequi 300..." o "Transf. Bancolombia #123"):`, '');
  if (note === null) return;   // canceló
  api(`/admin/owners/${o.id}/disburse`, {
    method: 'POST', body: JSON.stringify({ method: 'MANUAL', note }),
  }).then((r) => {
    alert(`Pago registrado: ${cop(r.amount_cop)}. Saldo nuevo: ${cop(r.new_balance_cop)}.`);
    return api(`/admin/owners/${o.id}`);
  }).then((d) => { state.ownerDetail = d; renderTab(); })
    .catch((err) => alert(err.message));
}

// ── Comisiones ──────────────────────────────────────────────────────────────────
function renderComisiones(view) {
  const c = state.commissions;
  const periods = [['today', 'Hoy'], ['week', '7 días'], ['month', '30 días']];
  view.innerHTML = `
    <h1>Comisiones</h1>
    <div class="filters">
      ${periods.map(([p, l]) => `<button class="chip ${state.comPeriod === p ? 'active' : ''}" data-p="${p}">${l}</button>`).join('')}
    </div>
    <div class="cards">
      ${card('Comisión Faro', cop(c.total_cop), 'en el periodo', 'accent')}
    </div>
    <div class="section-title">Por dueño</div>
    <table>
      <thead><tr><th>Dueño</th><th>Comisión</th></tr></thead>
      <tbody>
        ${c.by_owner.length === 0 ? `<tr><td colspan="2" class="empty">Sin comisiones en el periodo</td></tr>` :
          c.by_owner.map((r) => `<tr><td>${r.owner}</td><td><b>${cop(r.commission_cop)}</b></td></tr>`).join('')}
      </tbody>
    </table>`;
  view.querySelectorAll('[data-p]').forEach((b) =>
    b.addEventListener('click', () => { state.comPeriod = b.dataset.p; renderTab(); }));
}

// ── Usuarios ─────────────────────────────────────────────────────────────────
function renderUsuarios(view) {
  const users = state.users;
  const unverified = users.filter((u) => !u.email_verified && u.role !== 'admin');
  view.innerHTML = `
    <h1>Usuarios</h1>
    <div class="filters">
      <span class="muted">${users.length} usuarios · ${unverified.length} sin verificar</span>
      ${unverified.length ? `<button class="mini del" id="cleanup" style="margin-left:auto;">Limpiar no verificados (${unverified.length})</button>` : ''}
    </div>
    <p class="muted" style="margin-bottom:10px;">Toca un usuario para ver su historial.</p>
    <table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Saldo</th><th>Verificación</th><th>Creado</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr class="clickable" data-user="${u.id}">
            <td>${u.name}</td>
            <td class="muted">${u.email}</td>
            <td>${u.role}${u.role === 'admin' ? ' <span class="badge muted">admin</span>' : ''}</td>
            <td>${u.role === 'conductor' ? cop(u.wallet_cop) : '—'}</td>
            <td>${u.email_verified ? '<span class="badge ok">Verificado</span>' : '<span class="badge danger">Sin verificar</span>'}</td>
            <td class="muted">${fmtTime(u.created_at)}</td>
            <td>
              ${u.role === 'conductor' ? `<button class="mini" data-bono="${u.id}">+ Saldo</button> ` : ''}
              ${!u.email_verified ? `<button class="mini" data-verify="${u.id}">Verificar</button> ${u.role !== 'admin' ? `<button class="mini del" data-del="${u.id}">Borrar</button>` : ''}` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  view.querySelectorAll('[data-user]').forEach((r) => r.addEventListener('click', async (e) => {
    if (e.target.closest('button')) return;   // no abrir si tocó un botón de acción
    try { state.userDetail = await api(`/admin/users/${r.dataset.user}`); renderTab(); }
    catch (err) { alert(err.message); }
  }));

  view.querySelectorAll('[data-bono]').forEach((b) => b.addEventListener('click', async () => {
    const raw = prompt('Crédito/bono al saldo del conductor (COP). Negativo para ajustar:');
    if (raw === null) return;
    const n = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    if (!n) return;
    try {
      const r = await api(`/admin/users/${b.dataset.bono}/wallet-credit`, { method: 'POST', body: JSON.stringify({ amount_cop: n }) });
      alert('Saldo nuevo: ' + cop(r.balance_cop));
      renderTab();
    } catch (e) { alert(e.message); }
  }));

  const cleanupBtn = document.getElementById('cleanup');
  if (cleanupBtn) cleanupBtn.addEventListener('click', async () => {
    if (!confirm(`¿Borrar ${unverified.length} usuario(s) sin verificar? Los que tengan actividad (cargadores, cobros) se conservan.`)) return;
    cleanupBtn.disabled = true; cleanupBtn.textContent = 'Limpiando…';
    try {
      const res = await api('/admin/users/cleanup-unverified', { method: 'POST' });
      alert(`Borrados: ${res.deleted_count}\nOmitidos (con actividad): ${res.skipped.length}`);
      renderTab();
    } catch (err) { alert(err.message); cleanupBtn.disabled = false; }
  });
  view.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '…';
    try { await api(`/admin/users/${b.dataset.verify}/verify`, { method: 'POST' }); renderTab(); }
    catch (err) { alert(err.message); b.disabled = false; b.textContent = 'Verificar'; }
  }));
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar este usuario sin verificar?')) return;
    b.disabled = true;
    try { await api(`/admin/users/${b.dataset.del}`, { method: 'DELETE' }); renderTab(); }
    catch (err) { alert(err.message); b.disabled = false; }
  }));
}

function renderUserDetail(view) {
  const u = state.userDetail;
  const txLabel = { TOPUP: 'Recarga', CHARGE: 'Carga', REFUND: 'Devolución', BONUS: 'Bono' };
  let body = '';

  if (u.role === 'conductor' && u.conductor) {
    const c = u.conductor;
    body = `
      <div class="section-title">Resumen</div>
      <div class="cards">
        ${card('Saldo actual', cop(c.wallet_cop), 'wallet prepago', 'accent')}
        ${card('Cargas', c.sessions_total, `${c.kwh_total} kWh en total`)}
        ${card('Gasto histórico', cop(c.spent_total_cop), 'total cobrado')}
      </div>

      <div class="section-title">Devolución de saldo</div>
      <div class="card" style="max-width:460px;">
        <div class="muted" style="font-size:.85rem;margin-bottom:8px;">
          Reembolsable (solo dinero propio, menos costo de procesamiento; los bonos no se devuelven):
          <b>${cop(c.refundable_cop ?? 0)}</b>
        </div>
        <button class="mini" id="refund" ${(c.refundable_cop ?? 0) <= 0 ? 'disabled' : ''}>
          ${(c.refundable_cop ?? 0) > 0 ? `Procesar devolución de ${cop(c.refundable_cop)}` : 'Sin saldo reembolsable'}
        </button>
      </div>

      <div class="section-title">Movimientos de saldo</div>
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Monto</th></tr></thead>
        <tbody>
          ${c.wallet_tx.length === 0 ? `<tr><td colspan="4" class="empty">Sin movimientos</td></tr>` :
            c.wallet_tx.map((t) => `<tr>
              <td class="muted">${fmtTime(t.created_at)}</td>
              <td>${txLabel[t.type] || t.type}</td>
              <td class="muted">${t.description || ''}</td>
              <td style="color:${t.amount_cop < 0 ? '#b91c1c' : '#15803d'};font-weight:700;">${t.amount_cop < 0 ? '' : '+'}${cop(t.amount_cop)}</td>
            </tr>`).join('')}
        </tbody>
      </table>

      <div class="section-title">Historial de cargas</div>
      <table>
        <thead><tr><th>Fecha</th><th>Cargador</th><th>kWh</th><th>Cobrado</th></tr></thead>
        <tbody>
          ${c.sessions.length === 0 ? `<tr><td colspan="4" class="empty">Sin cargas</td></tr>` :
            c.sessions.map((s) => `<tr>
              <td class="muted">${fmtTime(s.ended_at)}</td>
              <td>${s.charger_id}</td>
              <td>${s.kwh}</td>
              <td>${cop(s.cost_cop)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else if (u.role === 'owner' && u.owner) {
    const o = u.owner;
    body = `
      <div class="section-title">Dueño</div>
      <div class="cards">
        ${card('Mensualidad', o.subscription_active ? 'Activo' : 'Suspendido', o.subscription_active ? 'cargadores habilitados' : 'cargadores ocultos', o.subscription_active ? 'ok' : 'danger')}
        ${card('Cargadores', o.chargers_total)}
        ${card('Saldo por pagar', cop(o.balance_cop), '', 'accent')}
      </div>
      <p class="muted">Para el estado de cuenta completo y cobrar la mensualidad, ve a la pestaña <b>Dueños</b>.</p>`;
  } else {
    body = `<p class="muted">Usuario administrador.</p>`;
  }

  view.innerHTML = `
    <button class="mini" id="back" style="background:none;color:#b45309;padding:0;margin-bottom:14px;">← Volver a usuarios</button>
    <h1>${u.name}</h1>
    <p class="muted" style="margin-bottom:14px;">${u.email} · ${u.role} · ${u.email_verified ? 'Verificado' : 'Sin verificar'} · desde ${fmtTime(u.created_at)}</p>
    ${body}`;

  document.getElementById('back').addEventListener('click', () => { state.userDetail = null; renderTab(); });
  const refundBtn = document.getElementById('refund');
  if (refundBtn && !refundBtn.disabled) refundBtn.addEventListener('click', () => refundUser(u));
}

function refundUser(u) {
  const c = u.conductor || {};
  if (!confirm(`Procesar devolución de ${cop(c.refundable_cop)} a ${u.name}?\n\n` +
    `Primero haz la transferencia real; esto registra el débito en su saldo.`)) return;
  const note = prompt('Referencia del pago (ej. "Nequi 300..." / "Transf. #123"):', '');
  if (note === null) return;
  api(`/admin/users/${u.id}/refund`, { method: 'POST', body: JSON.stringify({ note }) })
    .then((r) => {
      alert(`Devolución registrada: ${cop(r.refunded_cop)}. Saldo nuevo: ${cop(r.balance_cop)}.`);
      return api(`/admin/users/${u.id}`);
    })
    .then((d) => { state.userDetail = d; renderTab(); })
    .catch((err) => alert(err.message));
}

// ── Arranque ─────────────────────────────────────────────────────────────────
async function boot() {
  if (!token) return renderLogin();
  // Optimista: con un token guardado, entramos directo (no se sale al recargar).
  renderApp();
  // Validamos en segundo plano: si el token es inválido (401), api() cierra sesión;
  // si es un error de red/transitorio, mantenemos la sesión.
  try {
    const me = await api('/auth/me');
    if (me.role !== 'admin') logout();
  } catch { /* red/transitorio: no tocar la sesión */ }
}

boot();
