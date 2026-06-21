-- ============================================================================
--  LIMPIEZA DE TRANSACCIONES — Faro Energy
--  Borra SOLO lo transaccional/operativo. CONSERVA:
--    users, chargers, payment_methods, disbursement_accounts, charger_brand_profiles
--  Resetea: saldos de wallet (=0), ledger, sesiones, cobros, facturas, reservas,
--           ratings, eventos; y el estado de sesión/rating de cada cargador.
--
--  Uso (en el servidor):
--    docker compose -f docker-compose.prod.yml exec -T db \
--      psql -U postgres -d cpo_db < backend/clean_transactions.sql
--
--  Es transaccional: si algo falla, NO borra nada (ROLLBACK automático).
-- ============================================================================
BEGIN;

-- Datos transaccionales (RESTART IDENTITY reinicia los contadores de id).
TRUNCATE
    reservations,
    sessions,
    payment_transactions,
    pending_charges,
    disbursement_records,
    owner_events,
    ledger_entries,
    invoices,
    charger_ratings,
    wallet_transactions
  RESTART IDENTITY CASCADE;

-- Limpia el estado de sesión y los contadores de rating en los cargadores
-- (se conservan los cargadores y su configuración: precio, potencia, ubicación...).
UPDATE chargers SET
    active_transaction = NULL,
    "session_user"     = NULL,   -- entre comillas: session_user es palabra reservada en Postgres
    session_started_at = NULL,
    current_kwh        = NULL,
    meter_start        = NULL,
    last_kwh           = NULL,
    rating_up          = 0,
    rating_down        = 0,
    status             = 'Available';

-- Reactiva a todos los dueños (por si alguien quedó suspendido por mensualidad)
-- y olvida la cobertura de mensualidad previa. NO toca correo/clave/datos.
UPDATE users SET
    subscription_active     = TRUE,
    subscription_paid_until = NULL;

-- Verificación rápida de lo que se conservó.
SELECT 'users' AS tabla, count(*) FROM users
UNION ALL SELECT 'chargers', count(*) FROM chargers
UNION ALL SELECT 'payment_methods', count(*) FROM payment_methods
UNION ALL SELECT 'disbursement_accounts', count(*) FROM disbursement_accounts
UNION ALL SELECT 'sessions (debe ser 0)', count(*) FROM sessions
UNION ALL SELECT 'wallet_transactions (debe ser 0)', count(*) FROM wallet_transactions
UNION ALL SELECT 'ledger_entries (debe ser 0)', count(*) FROM ledger_entries;

COMMIT;
