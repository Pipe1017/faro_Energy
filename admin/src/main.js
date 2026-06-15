import './style.scss';

// Base de la API. En prod apunta al backend (Cloudflare Tunnel).
// Override local: VITE_API_URL=http://localhost:8000 npm run dev
const API_URL = import.meta.env.VITE_API_URL || 'https://api.faroenergy.lat';
const TOKEN_KEY = 'faro_admin_token';

const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || null;
let state = { tab: 'resumen', overview: null, invoices: [], owners: [], invFilter: '' };

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401 || res.status === 403) { logout(); throw new Error('Sesión inválida'); }
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
        <div class="brand">Faro <span>Energy</span></div>
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
  const tabs = [['resumen', 'Resumen'], ['facturas', 'Facturas'], ['duenos', 'Dueños']];
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <div class="brand">Faro <span>Energy</span></div>
        <nav>
          ${tabs.map(([k, l]) => `<button class="nav ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
        </nav>
        <button class="logout" id="logout">Salir</button>
      </aside>
      <main class="content"><div id="view" class="view">Cargando…</div></main>
    </div>`;
  document.getElementById('logout').addEventListener('click', logout);
  app.querySelectorAll('.nav').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; renderApp(); }));
  renderTab();
}

async function renderTab() {
  const view = document.getElementById('view');
  try {
    if (state.tab === 'resumen') { state.overview = await api('/admin/overview'); renderResumen(view); }
    else if (state.tab === 'facturas') { state.invoices = await api(`/admin/invoices${state.invFilter ? '?status=' + state.invFilter : ''}`); renderFacturas(view); }
    else if (state.tab === 'duenos') { state.owners = await api('/admin/owners'); renderDuenos(view); }
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
    <div class="section-title">Bolsas de plata</div>
    <div class="cards">
      ${card('Ingreso Faro', cop(o.money.faro_revenue_cop), 'comisión + mensualidad', 'accent')}
      ${card('IVA por girar a DIAN', cop(o.money.iva_to_dian_cop), 'recaudado, no es ingreso')}
      ${card('Deuda con dueños', cop(o.money.owed_to_owners_cop), 'saldo en sus bolsas')}
      ${card('Recaudado (histórico)', cop(o.money.collected_cop), 'total cobrado a conductores')}
      ${card('Girado a dueños', cop(o.money.disbursed_cop), 'liquidaciones enviadas')}
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

// ── Facturas ────────────────────────────────────────────────────────────────────
function badge(status) {
  const map = { ISSUED: 'ok', PENDING: 'warn', FAILED: 'danger', VOID: 'muted' };
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

function renderFacturas(view) {
  const filters = ['', 'PENDING', 'ISSUED', 'FAILED'];
  view.innerHTML = `
    <h1>Facturas</h1>
    <div class="filters">
      ${filters.map((f) => `<button class="chip ${state.invFilter === f ? 'active' : ''}" data-f="${f}">${f || 'Todas'}</button>`).join('')}
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
            <td>${i.status !== 'ISSUED' ? `<button class="mini" data-retry="${i.id}">Reintentar</button>` : (i.pdf_url ? `<a class="mini" href="${i.pdf_url}" target="_blank">PDF</a>` : '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  view.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.invFilter = c.dataset.f; renderTab(); }));
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
    <table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Saldo</th><th>Cargadores</th><th>IVA</th><th>RUT / KYC</th></tr></thead>
      <tbody>
        ${state.owners.length === 0 ? `<tr><td colspan="6" class="empty">Sin dueños</td></tr>` :
          state.owners.map((o) => `
          <tr>
            <td>${o.name} ${o.role === 'admin' ? '<span class="badge muted">admin</span>' : ''}</td>
            <td class="muted">${o.email}</td>
            <td>${cop(o.balance_cop)}</td>
            <td>${o.chargers}</td>
            <td>${o.responsable_iva ? '<span class="badge ok">Responsable</span>' : '<span class="badge muted">No</span>'}</td>
            <td>${o.kyc_ok ? `<span class="badge ok">${o.rut}</span>` : '<span class="badge danger">Falta</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Arranque ─────────────────────────────────────────────────────────────────
async function boot() {
  if (!token) return renderLogin();
  try {
    const me = await api('/auth/me');
    if (me.role !== 'admin') return logout();
    renderApp();
  } catch { renderLogin(); }
}

boot();
