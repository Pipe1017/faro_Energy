// Paleta "Faro Claro" v3 — tokens de diseño
export const T = {
  // Fondos — marfil cálido, nunca negro
  bg:         '#faf7f1',
  surface:    '#f3eee4',
  card:       '#ffffff',
  cardBorder: '#e7dfd0',

  // Acción principal — cobre Faro
  green:      '#b45309',   // nombre heredado, es COBRE
  greenDark:  '#8a3e06',
  greenLight: '#e8c49a',
  greenFaint: '#f7ead8',

  // Texto — espresso sobre claro
  textPri:    '#2b2520',
  textSec:    '#6b5d4a',
  textMuted:  '#94866f',

  // Estado Charging — índigo
  charging:   '#4338ca',
  chargingBg: '#eceafb',

  // Alerta / advertencia
  warning:    '#92580c',
  warningText:'#92580c',
  warningBg:  '#fbf0dc',

  danger:     '#b91c1c',
  dangerText: '#b91c1c',
  offline:    '#a8a29e',
  preparing:  '#b45309',

  headerDriver: '#f3eee4',
  headerOwner:  '#f7ead8',
};

// Color por tipo de ACCESO del cargador (identificación en el mapa):
//   public     → cobre (café): cualquiera puede cargar
//   member     → índigo (azul): privado de una unidad a la que tienes acceso
//   restricted → espresso (negro): privado, sin acceso (solo residentes)
export const ACCESS_COLOR = {
  public:     T.green,
  member:     T.charging,
  restricted: T.textPri,
};
export const ACCESS_LABEL = {
  public:     'Público',
  member:     'Unidad · tienes acceso',
  restricted: 'Acceso restringido por administración',
};

export const STATUS_COLOR = {
  Available: T.green,      // gold
  Charging:  T.charging,   // púrpura
  Reserved:  '#0d9488',    // teal — separado, garantía retenida
  Faulted:   '#b91c1c',
  Offline:   T.offline,
  Preparing: T.warningText,
};
