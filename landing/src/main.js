import './main.scss'

// ── Nav scroll + burger ───────────────────────────────────────────────────────
const nav    = document.querySelector('.nav')
const burger = document.getElementById('nav-burger')

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40)
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

const POWER_KW  = 22
const ELEC_COST = 700      // COP/kWh (tarifa comercial Medellín con IVA incluido)
const EFFICIENCY = 0.62    // factor real: vehículos no siempre cargan a potencia máxima
const INVEST    = 5_500_000 // COP — equipo + instalación promedio en Colombia

function calcROI() {
  const h = parseFloat(hoursRange.value)
  const p = parseFloat(priceRange.value)

  const kwhDay    = POWER_KW * h * EFFICIENCY
  const kwhMonth  = kwhDay * 30
  const income    = kwhMonth * p
  const cost      = kwhMonth * ELEC_COST
  const net       = Math.round(income - cost)
  const months    = net > 0 ? Math.ceil(INVEST / net) : '—'

  hoursVal.textContent = `${h}h / día`
  priceVal.textContent = `$${p.toLocaleString('es-CO')} / kWh`
  monthlyEl.textContent = net > 0 ? `$${net.toLocaleString('es-CO')} COP` : '—'
  roiEl.textContent = net > 0
    ? months <= 12  ? `~${months} meses`
    : months <= 24  ? `~${months} meses`
    : `~${Math.ceil(months/12)} años`
    : '—'
}

hoursRange?.addEventListener('input', calcROI)
priceRange?.addEventListener('input', calcROI)
calcROI()

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
