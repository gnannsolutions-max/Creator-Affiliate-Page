-- =============================================================================
--  Creator-Affiliate-Portal – PostgreSQL-Schema
--
--  Bewusst getrennt:
--    sales      = Rohdaten aus den CSV-Importen (jederzeit veränderbar)
--    snapshot_* = eingefrorener Stand, den Creator im Dashboard sehen
--  Das Dashboard liest AUSSCHLIESSLICH aus den Snapshot-Tabellen. Dadurch
--  ändern sich die Zahlen für Creator nur beim täglichen Lauf um 11:00 Uhr.
--
--  Datumsfelder für Bestellungen liegen bewusst als TEXT im Format YYYY-MM-DD
--  vor: So sind Vergleiche und Sortierung identisch zur bisherigen Logik und
--  unabhängig von der Zeitzone des Datenbankservers.
-- =============================================================================

-- --- Creator / Bewerbungen ---------------------------------------------------
CREATE TABLE IF NOT EXISTS creators (
  id                 BIGSERIAL PRIMARY KEY,
  full_name          TEXT        NOT NULL,
  email              TEXT        NOT NULL,
  email_norm         TEXT        NOT NULL UNIQUE,
  instagram          TEXT        NOT NULL,
  tiktok             TEXT,
  youtube            TEXT,

  requested_code     TEXT        NOT NULL,
  assigned_code      TEXT,
  assigned_code_norm TEXT        UNIQUE,

  status             TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','paused')),
  commission_rate    DOUBLE PRECISION NOT NULL DEFAULT 15,
  customer_discount  DOUBLE PRECISION NOT NULL DEFAULT 10,

  source             TEXT,
  note_internal      TEXT,
  decision_reason    TEXT,

  -- Compliance-Nachweis (relevant für § 8 Abs. 2 UWG / Werbekennzeichnung)
  terms_version      TEXT        NOT NULL,
  terms_accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  terms_accepted_ip  TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at        TIMESTAMPTZ,
  reviewed_by        TEXT,
  last_login_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_creators_status ON creators(status);

-- --- Login per Magic-Link ----------------------------------------------------
CREATE TABLE IF NOT EXISTS login_tokens (
  id         BIGSERIAL PRIMARY KEY,
  creator_id BIGINT      NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_creator ON login_tokens(creator_id);

-- --- CSV-Importe -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imports (
  id            BIGSERIAL PRIMARY KEY,
  filename      TEXT        NOT NULL,
  rows_total    INTEGER     NOT NULL DEFAULT 0,
  rows_inserted INTEGER     NOT NULL DEFAULT 0,
  rows_updated  INTEGER     NOT NULL DEFAULT 0,
  rows_skipped  INTEGER     NOT NULL DEFAULT 0,
  unknown_codes TEXT,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Bestellungen (Rohdaten) -------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id           BIGSERIAL PRIMARY KEY,
  order_ref    TEXT        NOT NULL UNIQUE,
  code_norm    TEXT        NOT NULL,
  order_date   TEXT        NOT NULL,
  gross_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_amount   DOUBLE PRECISION NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'confirmed'
               CHECK (status IN ('confirmed','pending','refunded','cancelled')),
  import_id    BIGINT      REFERENCES imports(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_code_date ON sales(code_norm, order_date);
CREATE INDEX IF NOT EXISTS idx_sales_date      ON sales(order_date);

-- --- Snapshot: das, was der Creator sieht ------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_runs (
  id             BIGSERIAL PRIMARY KEY,
  as_of          TIMESTAMPTZ NOT NULL,
  as_of_label    TEXT        NOT NULL,
  as_of_day      TEXT        NOT NULL,          -- YYYY-MM-DD in Programm-Zeitzone
  creators_count INTEGER     NOT NULL DEFAULT 0,
  orders_count   INTEGER     NOT NULL DEFAULT 0,
  triggered_by   TEXT        NOT NULL DEFAULT 'cron',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshot_totals (
  run_id            BIGINT NOT NULL REFERENCES snapshot_runs(id) ON DELETE CASCADE,
  creator_id        BIGINT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  orders_total      INTEGER NOT NULL DEFAULT 0,
  revenue_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_total  DOUBLE PRECISION NOT NULL DEFAULT 0,
  orders_30d        INTEGER NOT NULL DEFAULT 0,
  revenue_30d       DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_30d    DOUBLE PRECISION NOT NULL DEFAULT 0,
  orders_prev30d    INTEGER NOT NULL DEFAULT 0,
  revenue_prev30d   DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_order_value   DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_sale_date   TEXT,
  last_sale_date    TEXT,
  commission_paid   DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_open   DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, creator_id)
);

CREATE TABLE IF NOT EXISTS snapshot_days (
  run_id     BIGINT NOT NULL REFERENCES snapshot_runs(id) ON DELETE CASCADE,
  creator_id BIGINT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  day        TEXT   NOT NULL,
  orders     INTEGER NOT NULL DEFAULT 0,
  revenue    DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, creator_id, day)
);

CREATE TABLE IF NOT EXISTS snapshot_orders (
  run_id     BIGINT NOT NULL REFERENCES snapshot_runs(id) ON DELETE CASCADE,
  creator_id BIGINT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  order_ref  TEXT   NOT NULL,
  order_date TEXT   NOT NULL,
  revenue    DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission DOUBLE PRECISION NOT NULL DEFAULT 0,
  status     TEXT   NOT NULL,
  PRIMARY KEY (run_id, creator_id, order_ref)
);

-- --- Auszahlungen ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
  id          BIGSERIAL PRIMARY KEY,
  creator_id  BIGINT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  period      TEXT   NOT NULL,
  amount      DOUBLE PRECISION NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid')),
  paid_at     TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creator_id, period)
);

-- --- Ausgangspostfach --------------------------------------------------------
--  Jede erzeugte E-Mail wird hier abgelegt – unabhängig davon, ob ein
--  SMTP-Zugang konfiguriert ist. Ohne SMTP ist das der Ersatzweg: Der Admin
--  liest den Login- oder Freigabelink unter /admin/mails ab und schickt ihn
--  dem Creator selbst. Damit braucht der Betrieb keinen weiteren Dienst.
CREATE TABLE IF NOT EXISTS outbox (
  id         BIGSERIAL PRIMARY KEY,
  recipient  TEXT        NOT NULL,
  subject    TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  kind       TEXT        NOT NULL DEFAULT 'info',
  link       TEXT,                                  -- der enthaltene Login-Link, falls vorhanden
  status     TEXT        NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','sent','failed')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at DESC);

-- --- Änderungsprotokoll ------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  subject    TEXT,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
