// Resolución de dependencias portable: usa node_modules local (este repo) y, si no,
// cae a un path global. Así corre igual en tu Mac que en otra máquina.
const GROOT = "/home/claude/.npm-global/lib/node_modules";
function dep(name) {
  try { return require(name); }            // node_modules local (exposiciones/)
  catch { return require(GROOT + "/" + name); }  // fallback global
}
const pptxgen = dep("pptxgenjs");
const React = dep("react");
const ReactDOMServer = dep("react-dom/server");
const sharp = dep("sharp");
const FA = dep("react-icons/fa");

// ---------- paleta "FARO CLARO" (oficial, ver DESIGN_PALETTE.txt) ----------
// Fondo SIEMPRE claro (marfil). Acento principal COBRE, acento vivo ÍNDIGO.
// Sin verde, sin degradados. Texto espresso sobre claro; blanco solo sobre relleno
// de color o como fondo de tarjeta.
const BG     = "FAF7F1";  // marfil cálido — fondo principal
const SURFACE= "F3EEE4";  // superficie/relleno cálido secundario
const DARK   = "2B2520";  // espresso — acento OSCURO (círculos de ícono), NO fondo
const DARK2  = "211C18";  // espresso más profundo (uso mínimo)
const COBRE  = "B45309";  // acento principal — CTAs, marca, números clave
const COBRED = "8A3E06";  // cobre oscuro — texto cobre sobre claro (AAA)
const INDIGO = "4338CA";  // acento vivo/secundario (estado Charging en la app)
const WHITE  = "FFFFFF";  // blanco: SOLO ícono sobre relleno de color o fondo de card
const INK    = "2B2520";  // espresso — texto principal (14:1 AAA)
const SLATE  = "6B5D4A";  // arena oscura — texto secundario
const CARD   = "FFFFFF";  // tarjeta (blanco suavizado con borde)
const CARDA  = "F7EAD8";  // cobre tenue — tarjeta de acento
const LINEC  = "E7DFD0";  // bordes / divisores

const makeShadow = () => ({ type: "outer", color: "2B2520", blur: 9, offset: 3, angle: 90, opacity: 0.10 });

async function icon(IC, color = "#FFFFFF", size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(IC, { color, size: String(size) }));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}

(async () => {
  const I = {};
  const need = {
    bolt: FA.FaBolt, plug: FA.FaPlugCircleXmark || FA.FaPlug, car: FA.FaCarSide, station: FA.FaChargingStation,
    hand: FA.FaHandshake, store: FA.FaStore, mobile: FA.FaMobileScreenButton || FA.FaMobileAlt,
    qr: FA.FaQrcode, gauge: FA.FaGaugeHigh || FA.FaTachometerAlt, coins: FA.FaCoins,
    wallet: FA.FaWallet, percent: FA.FaPercent, scale: FA.FaBalanceScale, check: FA.FaCircleCheck || FA.FaCheckCircle,
    file: FA.FaFileContract, shield: FA.FaShieldHalved || FA.FaShieldAlt, globe: FA.FaGlobe,
    chart: FA.FaChartLine, map: FA.FaMapLocationDot || FA.FaMapMarkedAlt, network: FA.FaNetworkWired,
    server: FA.FaServer, route: FA.FaRoute, layers: FA.FaLayerGroup, bullseye: FA.FaBullseye,
    leaf: FA.FaLeaf, tools: FA.FaScrewdriverWrench || FA.FaTools, building: FA.FaBuilding,
  };
  for (const [k, C] of Object.entries(need)) {
    // Variantes de color del ícono. Todos los círculos son de relleno oscuro
    // (cobre, índigo o espresso) → el ícono va en blanco o marfil para contraste.
    I[k] = { white: await icon(C, "#FFFFFF"), light: await icon(C, "#FAF7F1"),
             cobre: await icon(C, "#B45309"), indigo: await icon(C, "#4338CA"),
             dark: await icon(C, "#FAF7F1") };
  }

  // ---------- logo oficial (landing/public/logo-faro-claro.svg → PNG) ----------
  const fs = require("fs"), path = require("path");
  const logoSvg = fs.readFileSync(path.join(__dirname, "..", "landing", "public", "logo-faro-claro.svg"));
  // Rasterizado nítido (alta densidad). El logo cobre/espresso va perfecto sobre marfil.
  const logoPng = "image/png;base64," + (await sharp(logoSvg, { density: 400 }).resize({ width: 1400 }).png().toBuffer()).toString("base64");
  const LOGO_AR = 252 / 64; // relación de aspecto del SVG (ancho/alto)

  // Símbolo solo (la linterna-faro), para la marca discreta de esquina en las demás
  // slides. Mismas formas del logo oficial, recortadas a su viewBox.
  const symSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 10 56 100">
       <path d="M48 16 L62 30 L34 30 Z" fill="#2b2520"/>
       <path d="M35 30 L61 30 L62 40 L34 40 Z" fill="#b45309"/>
       <path d="M34 40 L62 40 L66 96 L30 96 Z" fill="#2b2520"/>
       <path d="M51 46 L42 68 L48 68 L45 88 L57 64 L51 64 Z" fill="#faf7f1"/>
       <rect x="27" y="95" width="42" height="7" rx="2" fill="#b45309"/>
     </svg>`);
  const symPng = "image/png;base64," + (await sharp(symSvg, { density: 600 }).resize({ width: 400 }).png().toBuffer()).toString("base64");
  const SYM_AR = 40 / 74; // ancho/alto del símbolo

  const p = new pptxgen();
  p.layout = "LAYOUT_16x9"; // 10 x 5.625
  p.author = "Faro Energy";
  p.title = "Faro Energy — Perfilamiento";
  const W = 10, H = 5.625, M = 0.5;

  // ---------- helpers ----------
  function bg(s, c) { s.background = { color: c }; }
  function iconCircle(s, ic, cx, cy, d, circleColor, iconVariant) {
    s.addShape(p.shapes.OVAL, { x: cx, y: cy, w: d, h: d, fill: { color: circleColor }, line: { type: "none" } });
    const ip = d * 0.46, off = (d - ip) / 2;
    s.addImage({ data: ic[iconVariant], x: cx + off, y: cy + off, w: ip, h: ip });
  }
  function kicker(s, text, color, x = M, y = 0.42, dark = false) {
    s.addText(text.toUpperCase(), { x, y, w: 9, h: 0.3, fontFace: "Arial", fontSize: 11.5, bold: true,
      color, charSpacing: 3, align: "left", margin: 0 });
  }
  function title(s, text, color = INK, x = M, y = 0.72, w = 9, size = 30) {
    s.addText(text, { x, y, w, h: 0.95, fontFace: "Arial", fontSize: size, bold: true, color, align: "left", margin: 0, lineSpacingMultiple: 0.98 });
  }
  function card(s, x, y, w, h, fill) {
    s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.09, fill: { color: fill }, line: { type: "none" }, shadow: makeShadow() });
  }
  // Marca discreta: símbolo solo, diminuto, en la esquina superior derecha
  // (zona vacía sobre los títulos → nunca choca con tarjetas ni texto).
  function brandMark(s) {
    const h = 0.42, w = h * SYM_AR;
    s.addImage({ data: symPng, x: W - w - 0.32, y: 0.3, w, h });
  }

  // ============================================================ SLIDE 1 — PORTADA
  let s = p.addSlide(); bg(s, BG);
  // beacon concentric rings (top-right)
  const rx = 8.4, ry = -0.7;
  [3.6, 2.7, 1.9].forEach((d, i) => {
    s.addShape(p.shapes.OVAL, { x: rx - d / 2, y: ry - d / 2 + 1.0, w: d, h: d, fill: { type: "none" },
      line: { color: i === 1 ? INDIGO : COBRE, width: 1.25, transparency: i === 0 ? 78 : 60 } });
  });
  iconCircle(s, I.bolt, rx - 0.55, ry + 0.45, 1.1, INDIGO, "dark");
  // Logo oficial (grande) en la portada
  s.addImage({ data: logoPng, x: M, y: 1.18, w: 2.95, h: 2.95 / LOGO_AR });
  s.addText("El Airbnb de la recarga de\nvehículos eléctricos", { x: M, y: 2.05, w: 8.2, h: 1.5, fontFace: "Arial", fontSize: 40, bold: true, color: INK, margin: 0, lineSpacingMultiple: 1.0 });
  s.addText("Plataforma de carga inteligente para Colombia — con foco en carga de destino.\nEmpezamos en Medellín.", { x: M, y: 3.65, w: 8.4, h: 0.8, fontFace: "Arial", fontSize: 15, color: SLATE, margin: 0, lineSpacingMultiple: 1.1 });
  s.addShape(p.shapes.LINE, { x: M, y: 4.7, w: 2.2, h: 0, line: { color: INDIGO, width: 2.5 } });
  s.addText("Presentación de perfilamiento · Ruta de emprendimiento e incubación · 2026", { x: M, y: 4.85, w: 9, h: 0.4, fontFace: "Arial", fontSize: 12, italic: true, color: SLATE, margin: 0 });
  s.addNotes("Gancho: imaginen los carros eléctricos creciendo a tres dígitos y la infraestructura sin existir. Esa brecha es la oportunidad. Faro la cierra. Soy un proyecto con producto ya construido, no una idea en servilleta.");

  // ============================================================ SLIDE 2 — PROBLEMA
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "El problema", COBRE);
  title(s, "Llegan los carros, faltan los enchufes", INK);
  // intro line
  s.addText("Colombia adopta vehículos eléctricos a gran velocidad, pero la infraestructura de carga pública va años atrás. La brecha es enorme — y crece cada mes.", { x: M, y: 1.62, w: 4.5, h: 1.2, fontFace: "Arial", fontSize: 14, color: SLATE, margin: 0, lineSpacingMultiple: 1.15 });
  // three stat callouts (left column)
  const stats = [
    ["+217%", "crecimiento de carros eléctricos nuevos en 2026"],
    ["2ª", "región del país en adopción: Medellín y el Valle de Aburrá"],
  ];
  let sy = 3.05;
  stats.forEach(([n, l]) => {
    s.addText(n, { x: M, y: sy, w: 1.7, h: 0.7, fontFace: "Arial", fontSize: 33, bold: true, color: COBRE, margin: 0, align: "left" });
    s.addText(l, { x: M + 1.8, y: sy + 0.04, w: 2.75, h: 0.7, fontFace: "Arial", fontSize: 12.5, color: INK, margin: 0, valign: "middle", lineSpacingMultiple: 1.05 });
    sy += 0.92;
  });
  // gap chart (right)
  card(s, 5.45, 1.5, 4.05, 3.6, CARD);
  s.addText("La brecha en cifras", { x: 5.7, y: 1.68, w: 3.6, h: 0.4, fontFace: "Arial", fontSize: 14, bold: true, color: INK, margin: 0 });
  s.addChart(p.charts.BAR, [{ name: "Cantidad", labels: ["Carros\neléctricos", "Puntos de\ncarga públicos"], values: [30000, 1200] }], {
    x: 5.6, y: 2.15, w: 3.75, h: 2.8, barDir: "col", chartColors: [COBRE, INDIGO],
    showValue: true, dataLabelPosition: "outEnd", dataLabelColor: INK, dataLabelFontSize: 12, dataLabelFontBold: true,
    catAxisLabelColor: SLATE, catAxisLabelFontSize: 10.5, valAxisHidden: true, valGridLine: { style: "none" },
    showLegend: false, showTitle: false, barGapWidthPct: 60, chartArea: { fill: { color: CARD } }, plotArea: { fill: { color: CARD } },
  });
  s.addNotes("Dato clave: un carro eléctrico llegando cada hora y casi sin dónde cargar. La brecha es la oportunidad de oro.");

  // ============================================================ SLIDE 3 — OPORTUNIDAD
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "La oportunidad", COBRE);
  title(s, "Dos lados que nadie ha conectado", INK);
  s.addText("Mientras faltan cargadores, sobran espacios con energía ociosa. Faro conecta ambos lados.", { x: M, y: 1.6, w: 9, h: 0.5, fontFace: "Arial", fontSize: 14.5, color: SLATE, margin: 0 });
  // two cards
  const colW = 3.85, gap = 0.5;
  // conductor
  card(s, M, 2.25, colW, 2.7, CARD);
  iconCircle(s, I.car, M + 0.3, 2.55, 0.85, COBRE, "white");
  s.addText("El conductor", { x: M + 1.3, y: 2.62, w: colW - 1.5, h: 0.6, fontFace: "Arial", fontSize: 17, bold: true, color: INK, margin: 0, valign: "middle" });
  s.addText([
    { text: "No encuentra dónde cargar fuera de casa", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Quiere precio claro y pago simple", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Valor Faro: red amplia, mapa y pago exacto por kWh", options: { bullet: true } },
  ], { x: M + 0.32, y: 3.55, w: colW - 0.6, h: 1.25, fontFace: "Arial", fontSize: 12.5, color: INK, margin: 0, lineSpacingMultiple: 1.0 });
  // dueño
  const x2 = M + colW + gap;
  card(s, x2, 2.25, colW, 2.7, CARDA);
  iconCircle(s, I.store, x2 + 0.3, 2.55, 0.85, INDIGO, "dark");
  s.addText("El dueño del espacio", { x: x2 + 1.3, y: 2.62, w: colW - 1.5, h: 0.6, fontFace: "Arial", fontSize: 17, bold: true, color: INK, margin: 0, valign: "middle" });
  s.addText([
    { text: "Hotel, mall, edificio, gimnasio, parqueadero", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Tiene el espacio y la energía, no el software ni el cobro", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Valor Faro: activa su espacio y atrae clientes premium", options: { bullet: true } },
  ], { x: x2 + 0.32, y: 3.55, w: colW - 0.6, h: 1.25, fontFace: "Arial", fontSize: 12.5, color: INK, margin: 0, lineSpacingMultiple: 1.0 });
  // center connector
  iconCircle(s, I.hand, M + colW + (gap - 0.7) / 2, 3.25, 0.7, DARK, "white");
  s.addNotes("Marketplace de dos caras. El dueño pone el cargador y el espacio; Faro pone la plataforma, el cobro y la red; el conductor encuentra, carga y paga.");

  // ============================================================ SLIDE 4 — SOLUCIÓN / CÓMO FUNCIONA
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "La solución", COBRE);
  title(s, "La plataforma que activa el espacio ocioso", INK);
  s.addText("Foco en carga de DESTINO (mientras te hospedas, compras o vas al gimnasio) — no carga rápida de carretera.", { x: M, y: 1.62, w: 9, h: 0.5, fontFace: "Arial", fontSize: 14, color: COBRED, bold: true, margin: 0 });
  // 4 step flow
  const steps = [
    [I.station, "1 · Registra", "El dueño conecta su cargador OCPP y aparece en el mapa con su precio."],
    [I.qr, "2 · Carga", "El conductor escanea el QR y autoriza el pago, sin descargar app obligatoria."],
    [I.gauge, "3 · Mide", "El sistema mide el kWh en tiempo real vía protocolo OCPP."],
    [I.coins, "4 · Reparte", "Cobro exacto y reparto automático: dueño recibe su saldo, Faro su comisión."],
  ];
  const sw = (9 - 3 * 0.35) / 4;
  steps.forEach(([ic, h, d], i) => {
    const x = M + i * (sw + 0.35);
    card(s, x, 2.5, sw, 2.5, i % 2 ? CARDA : CARD);
    iconCircle(s, ic, x + (sw - 0.8) / 2, 2.72, 0.8, i % 2 ? INDIGO : COBRE, i % 2 ? "dark" : "white");
    s.addText(h, { x: x + 0.1, y: 3.62, w: sw - 0.2, h: 0.35, fontFace: "Arial", fontSize: 14, bold: true, color: INK, align: "center", margin: 0 });
    s.addText(d, { x: x + 0.18, y: 4.0, w: sw - 0.36, h: 0.95, fontFace: "Arial", fontSize: 11, color: SLATE, align: "center", margin: 0, lineSpacingMultiple: 1.02 });
  });
  s.addNotes("El demo en vivo va aquí en la presentación real: 90 segundos mostrando el ciclo completo. Vale más que diez slides.");

  // ============================================================ SLIDE 5 — MODELO DE NEGOCIO
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "Modelo de negocio", COBRE);
  title(s, "Modelo híbrido, diseñado para la rentabilidad", INK);
  s.addText("Ni SaaS plano que genera cancelaciones, ni comisión sola que pierde dinero en cargas pequeñas. Lo mejor de ambos.", { x: M, y: 1.62, w: 9, h: 0.5, fontFace: "Arial", fontSize: 14, color: SLATE, margin: 0 });
  const models = [
    [I.building, "Tarifa de plataforma", "Cuota baja por cargador/mes. Ingreso estable que cubre operación y monitoreo.", COBRE, "white"],
    [I.percent, "Comisión 12–15%", "Sobre cada transacción. Captura el crecimiento a medida que sube el volumen.", INDIGO, "dark"],
    [I.wallet, "Wallet prepago", "El conductor recarga saldo y diluye el costo fijo de la pasarela ($700 + 2,65% por transacción).", DARK, "white"],
  ];
  const mw = (9 - 2 * 0.4) / 3;
  models.forEach(([ic, h, d, cc, iv], i) => {
    const x = M + i * (mw + 0.4);
    card(s, x, 2.35, mw, 2.6, i === 1 ? CARDA : CARD);
    iconCircle(s, ic, x + 0.28, 2.6, 0.78, cc, iv);
    s.addText(h, { x: x + 0.26, y: 3.45, w: mw - 0.5, h: 0.4, fontFace: "Arial", fontSize: 15, bold: true, color: INK, margin: 0 });
    s.addText(d, { x: x + 0.26, y: 3.85, w: mw - 0.5, h: 1.0, fontFace: "Arial", fontSize: 12, color: SLATE, margin: 0, lineSpacingMultiple: 1.08 });
  });
  s.addNotes("El wallet no es capricho técnico: es la solución de diseño al fijo de la pasarela. Esto demuestra que conozco mis unit economics.");

  // ============================================================ SLIDE 6 — REGULACIÓN (POWER SLIDE)
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "Respaldo regulatorio", INDIGO);
  s.addText("La ley ya exige lo que nosotros construimos", { x: M, y: 0.72, w: 9, h: 0.9, fontFace: "Arial", fontSize: 29, bold: true, color: INK, margin: 0 });
  s.addText("La nueva regulación del Ministerio de Minas y Energía no solo permite nuestro modelo: lo vuelve obligatorio.", { x: M, y: 1.66, w: 9, h: 0.5, fontFace: "Arial", fontSize: 13.5, color: SLATE, margin: 0 });
  const regs = [
    [I.network, "OCPP obligatorio", "Toda estación pública debe conectarse vía protocolo abierto OCPP (Res. 40123/2024). Es nuestro backend."],
    [I.chart, "OCPI en tiempo real", "Reporte de estado, precio y energía vía OCPI (Res. 40559/2025). Ya lo integramos."],
    [I.check, "Acceso abierto", "Cobro sin descarga ni suscripción obligatoria. Nuestro wallet es opcional, no un muro."],
    [I.shield, "Cumplimiento llave en mano", "Registro en CárgaME, dictamen RETIE e incentivos (exención de IVA y aranceles): lo hacemos por el dueño."],
  ];
  const rw = (9 - 0.4) / 2, rh = 1.35;
  regs.forEach(([ic, h, d], i) => {
    const cx = M + (i % 2) * (rw + 0.4);
    const cy = 2.3 + Math.floor(i / 2) * (rh + 0.3);
    s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: cx, y: cy, w: rw, h: rh, rectRadius: 0.08, fill: { color: CARD }, line: { color: LINEC, width: 1 } });
    iconCircle(s, ic, cx + 0.25, cy + 0.27, 0.8, i % 2 ? INDIGO : COBRE, i % 2 ? "dark" : "white");
    s.addText(h, { x: cx + 1.2, y: cy + 0.18, w: rw - 1.4, h: 0.4, fontFace: "Arial", fontSize: 14.5, bold: true, color: INK, margin: 0 });
    s.addText(d, { x: cx + 1.2, y: cy + 0.58, w: rw - 1.45, h: 0.7, fontFace: "Arial", fontSize: 11, color: SLATE, margin: 0, lineSpacingMultiple: 1.05 });
  });
  s.addNotes("Este es tu slide más fuerte. No pides permiso para existir: estás listo para el marco que apenas se crea. Si el experto en energía pregunta, cita 40123/2024, 40559/2025 y RETIE 40177/2024.");

  // ============================================================ SLIDE 7 — VALIDACIÓN + FOSO
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "Validación y diferenciador", COBRE);
  title(s, "Modelo probado afuera, foso construido aquí", INK);
  // left: validation
  card(s, M, 1.75, 4.15, 3.3, CARD);
  iconCircle(s, I.globe, M + 0.3, 2.0, 0.8, COBRE, "white");
  s.addText("Modelo validado internacionalmente", { x: M + 1.25, y: 2.05, w: 2.7, h: 0.7, fontFace: "Arial", fontSize: 14.5, bold: true, color: INK, margin: 0, valign: "middle", lineSpacingMultiple: 0.95 });
  s.addText([
    { text: "Monta (Europa): plataforma de operación con comisión + suscripción. Su tesis: la restricción real es la operación y el uptime, no el hardware.", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: "ChargePoint (EE.UU.): empresa pública que probó el modelo red + software a gran escala.", options: { bullet: true } },
  ], { x: M + 0.32, y: 3.0, w: 3.55, h: 1.9, fontFace: "Arial", fontSize: 11.5, color: INK, margin: 0, lineSpacingMultiple: 1.05 });
  // right: moat
  const mx = M + 4.15 + 0.4;
  card(s, mx, 1.75, 4.15, 3.3, CARDA);
  s.addText("Nuestro foso competitivo", { x: mx + 0.3, y: 1.95, w: 3.6, h: 0.4, fontFace: "Arial", fontSize: 14.5, bold: true, color: INK, margin: 0 });
  const moat = [
    [I.map, "Densidad por zona", "Dominamos un barrio antes de expandir; red densa > cargadores sueltos."],
    [I.bolt, "Balanceo dinámico de carga", "Más cargadores sin obra eléctrica de millones. Avalado por la guía oficial."],
    [I.network, "Interoperabilidad OCPI", "Aparecemos en PlugShare y Google Maps; el conductor nos encuentra."],
  ];
  let my = 2.45;
  moat.forEach(([ic, h, d]) => {
    iconCircle(s, ic, mx + 0.3, my, 0.6, INDIGO, "dark");
    s.addText(h, { x: mx + 1.05, y: my - 0.04, w: 3.0, h: 0.32, fontFace: "Arial", fontSize: 12.5, bold: true, color: INK, margin: 0 });
    s.addText(d, { x: mx + 1.05, y: my + 0.28, w: 2.95, h: 0.5, fontFace: "Arial", fontSize: 10, color: SLATE, margin: 0, lineSpacingMultiple: 1.0 });
    my += 0.85;
  });
  s.addNotes("Cítalo como validación, no como copia. Si preguntan '¿y si Monta entra a Colombia?': densidad local, acuerdos con sitios y cumplimiento DIAN/RETIE/CárgaME que un recién llegado no tiene.");

  // ============================================================ SLIDE 8 — MERCADO / POR QUÉ AHORA
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "Mercado y momento", COBRE);
  title(s, "El momento exacto", INK);
  s.addText("Ni muy temprano (ya hay demanda real y creciente) ni muy tarde (los grandes son lentos en software y se enfocan en carga rápida de carretera).", { x: M, y: 1.6, w: 9, h: 0.6, fontFace: "Arial", fontSize: 14, color: SLATE, margin: 0, lineSpacingMultiple: 1.1 });
  // three stat blocks
  const ms = [
    [I.chart, "Mercado en aceleración", "Adopción de eléctricos creciendo a tres dígitos cada año en Colombia."],
    [I.bullseye, "Inicio enfocado", "Medellín, 2ª región del país, como primera plaza para ganar densidad."],
    [I.route, "Replicable", "Modelo escalable a Bogotá, Cali y el Eje Cafetero zona por zona."],
  ];
  const bw = (9 - 2 * 0.4) / 3;
  ms.forEach(([ic, h, d], i) => {
    const x = M + i * (bw + 0.4);
    card(s, x, 2.5, bw, 2.45, i === 1 ? CARDA : CARD);
    iconCircle(s, ic, x + (bw - 0.85) / 2, 2.75, 0.85, i === 1 ? INDIGO : COBRE, i === 1 ? "dark" : "white");
    s.addText(h, { x: x + 0.15, y: 3.7, w: bw - 0.3, h: 0.55, fontFace: "Arial", fontSize: 14, bold: true, color: INK, align: "center", margin: 0, lineSpacingMultiple: 0.95 });
    s.addText(d, { x: x + 0.2, y: 4.25, w: bw - 0.4, h: 0.65, fontFace: "Arial", fontSize: 11, color: SLATE, align: "center", margin: 0, lineSpacingMultiple: 1.03 });
  });
  s.addNotes("No uses un TAM/SAM/SOM inventado: vende dirección y velocidad del mercado. Eso es más creíble en perfilamiento.");

  // ============================================================ SLIDE 9 — TRACCIÓN HONESTA
  s = p.addSlide(); bg(s, BG); brandMark(s);
  kicker(s, "Dónde estamos", COBRE);
  title(s, "El motor ya está armado", INK);
  s.addText("Tenemos el producto completo funcionando de punta a punta. El riesgo técnico ya está resuelto; lo que falta es la calle.", { x: M, y: 1.6, w: 9, h: 0.55, fontFace: "Arial", fontSize: 14, color: SLATE, margin: 0, lineSpacingMultiple: 1.1 });
  // built card
  card(s, M, 2.35, 4.5, 2.65, CARD);
  iconCircle(s, I.check, M + 0.3, 2.55, 0.65, COBRE, "white");
  s.addText("Ya construido", { x: M + 1.05, y: 2.6, w: 3.2, h: 0.4, fontFace: "Arial", fontSize: 15, bold: true, color: INK, margin: 0, valign: "middle" });
  s.addText([
    { text: "Backend OCPP + app móvil + página web", options: { bullet: true, breakLine: true, paraSpaceAfter: 5 } },
    { text: "Wallet, mensualidad y usuarios de prueba", options: { bullet: true, breakLine: true, paraSpaceAfter: 5 } },
    { text: "Cobro y reparto automático funcionando", options: { bullet: true, breakLine: true, paraSpaceAfter: 5 } },
    { text: "Ciclo completo validado en pruebas", options: { bullet: true } },
  ], { x: M + 0.34, y: 3.3, w: 4.0, h: 1.6, fontFace: "Arial", fontSize: 12.5, color: INK, margin: 0, lineSpacingMultiple: 1.0 });
  // next card
  const nx = M + 4.5 + 0.4;
  card(s, nx, 2.35, 4.5, 2.65, CARDA);
  iconCircle(s, I.route, nx + 0.3, 2.55, 0.65, INDIGO, "dark");
  s.addText("El siguiente paso (con honestidad)", { x: nx + 1.05, y: 2.58, w: 3.3, h: 0.45, fontFace: "Arial", fontSize: 14, bold: true, color: INK, margin: 0, valign: "middle", lineSpacingMultiple: 0.95 });
  s.addText([
    { text: "Hoy: cargadores simulados y pagos en sandbox (a propósito, para probar sin riesgo)", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Falta: primer cargador real + Wompi producción + facturación DIAN", options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } },
    { text: "Meta: primeros pagos reales en un sitio de Medellín", options: { bullet: true } },
  ], { x: nx + 0.34, y: 3.25, w: 4.0, h: 1.65, fontFace: "Arial", fontSize: 12, color: INK, margin: 0, lineSpacingMultiple: 1.02 });
  s.addNotes("Sé transparente: lo simulado es buena práctica de ingeniería, no debilidad. Eliminamos el riesgo técnico; venimos por el riesgo comercial.");

  // ============================================================ SLIDE 10 — VISIÓN + ASK (cierre)
  s = p.addSlide(); bg(s, BG);   // cierre: sin marca discreta (slide ya saturada)
  kicker(s, "Visión y lo que buscamos", INDIGO);
  s.addText("Hacia dónde vamos", { x: M, y: 0.72, w: 9, h: 0.8, fontFace: "Arial", fontSize: 30, bold: true, color: INK, margin: 0 });
  // three phases
  const phases = [
    [I.bullseye, "Fase 1 — Densidad", "Red de carga AC de destino concentrada en una zona de Medellín."],
    [I.layers, "Fase 2 — Interoperabilidad", "Agregar terceros y carga rápida DC vía OCPI. Crecimiento capital-ligero."],
    [I.globe, "Fase 3 — La red", "Ser la app por defecto del conductor eléctrico colombiano."],
  ];
  const pw = (9 - 2 * 0.35) / 3;
  phases.forEach(([ic, h, d], i) => {
    const x = M + i * (pw + 0.35);
    s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y: 1.7, w: pw, h: 1.85, rectRadius: 0.08, fill: { color: CARD }, line: { color: LINEC, width: 1 } });
    iconCircle(s, ic, x + 0.25, 1.92, 0.7, i === 1 ? INDIGO : COBRE, i === 1 ? "dark" : "white");
    s.addText(h, { x: x + 0.22, y: 2.72, w: pw - 0.4, h: 0.35, fontFace: "Arial", fontSize: 13, bold: true, color: INK, margin: 0 });
    s.addText(d, { x: x + 0.22, y: 3.05, w: pw - 0.42, h: 0.45, fontFace: "Arial", fontSize: 10.5, color: SLATE, margin: 0, lineSpacingMultiple: 1.0 });
  });
  // the ask
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: M, y: 3.75, w: 9, h: 1.35, rectRadius: 0.08, fill: { color: COBRE }, line: { type: "none" } });
  s.addText("Qué buscamos en la ruta", { x: M + 0.35, y: 3.9, w: 8.3, h: 0.4, fontFace: "Arial", fontSize: 14, bold: true, color: WHITE, margin: 0 });
  s.addText([
    { text: "Acompañamiento para pasar de sandbox a producción    ", options: {} },
    { text: "·    Red para firmar los primeros 5–10 sitios reales    ", options: {} },
    { text: "·    Mentoría regulatoria y tributaria", options: {} },
  ], { x: M + 0.35, y: 4.32, w: 8.3, h: 0.6, fontFace: "Arial", fontSize: 12.5, color: "FAF7F1", margin: 0, lineSpacingMultiple: 1.05 });
  s.addText("\"Tenemos el motor; lo que falta es encenderlo.\"", { x: M, y: 5.18, w: 9, h: 0.35, fontFace: "Arial", fontSize: 13, italic: true, bold: true, color: INDIGO, align: "center", margin: 0 });
  s.addNotes("Cierra con energía, sin disculparte por lo que falta: lo que falta ES el ask, y eso es posición de fuerza. Frase final mirando al panel.");

  // Escribe junto a este script (portable). __dirname = carpeta exposiciones/
  const outFile = require("path").join(__dirname, "Faro_Energy_Perfilamiento.pptx");
  await p.writeFile({ fileName: outFile });
  console.log("OK deck written →", outFile);
})();
