import './main.scss'

// ── Nav scroll + burger ───────────────────────────────────────────────────────
const nav    = document.querySelector('.nav')
const burger = document.getElementById('nav-burger')

window.addEventListener('scroll', () => {
  nav?.classList.toggle('scrolled', window.scrollY > 40)
})

burger?.addEventListener('click', () => {
  nav.classList.toggle('nav--open')
})

// Cerrar menú al tocar un link
document.querySelectorAll('.nav__links a').forEach(a => {
  a.addEventListener('click', () => nav.classList.remove('nav--open'))
})

// ── Tabs cómo funciona ────────────────────────────────────────────────────────
document.querySelectorAll('.tabs__btn').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab
    document.querySelectorAll('.tabs__btn').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tabs__panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    document.getElementById(target).classList.add('active')
  })
})

// ── Calculadora ROI ───────────────────────────────────────────────────────────
const hoursRange  = document.getElementById('hours')
const priceRange  = document.getElementById('price')
const hoursVal    = document.getElementById('hours-val')
const priceVal    = document.getElementById('price-val')
const monthlyEl   = document.getElementById('monthly')
const roiEl       = document.getElementById('roi-months')

// Números reales del modelo (Medellín 2026)
const ELEC_COST  = 800        // COP/kWh — energía comercial EPM
const COMMISSION = 0.15       // comisión Faro 15%
const INVEST     = 6_000_000  // COP — cargador AC instalado

function calcROI() {
  const kwhDay = parseFloat(hoursRange.value)   // el slider es kWh/día (utilización)
  const p      = parseFloat(priceRange.value)

  // Lo que le queda al dueño por kWh = precio − comisión 15% − costo de energía
  const netPerKwh = p * (1 - COMMISSION) - ELEC_COST
  const net       = Math.round(netPerKwh * kwhDay * 30)
  const months    = net > 0 ? Math.ceil(INVEST / net) : null

  hoursVal.textContent  = `${kwhDay} kWh/día`
  priceVal.textContent  = `$${p.toLocaleString('es-CO')} / kWh`
  monthlyEl.textContent = net > 0 ? `$${net.toLocaleString('es-CO')} COP` : '—'
  roiEl.textContent     = !months ? '—' : months <= 24 ? `~${months} meses` : `~${Math.ceil(months / 12)} años`
}

hoursRange?.addEventListener('input', calcROI)
priceRange?.addEventListener('input', calcROI)
if (hoursRange && priceRange) calcROI()   // solo en la página que tiene la calculadora

// ── Reveal on scroll ──────────────────────────────────────────────────────────
const observer = new IntersectionObserver(
  entries => entries.forEach(e => e.isIntersecting && e.target.classList.add('visible')),
  { threshold: 0.1 }
)
document.querySelectorAll('.reveal').forEach(el => observer.observe(el))

// ── Smooth CTA scrolls ────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault()
    document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' })
  })
})
