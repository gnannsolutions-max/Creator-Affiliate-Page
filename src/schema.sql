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

-- --- Zähler gegen automatisierte Versuche ------------------------------------
--  Die Anwendung läuft serverlos: Zähler im Arbeitsspeicher einer Instanz
--  wären wirkungslos, weil jede Anfrage auf einer anderen Instanz landen kann.
--  Deshalb liegt der Zähler hier. Eine Zeile je Schlüssel (z. B. Formular+IP),
--  festes Zeitfenster, alte Zeilen werden beim täglichen Lauf entfernt.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT        PRIMARY KEY,
  hits         INTEGER     NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- --- Zahlungsempfänger -------------------------------------------------------
--  Bewusst eine eigene Tabelle statt weiterer Spalten in `creators`:
--  Die Anwendung liest an vielen Stellen `SELECT * FROM creators`, und das
--  Ergebnis landet über die Sitzung in Views und Listen. Bankdaten sollen dort
--  nicht beiläufig mitfahren – sie werden nur dort geladen, wo sie gebraucht
--  werden. Ein Löschverlangen betrifft außerdem genau eine Zeile.
CREATE TABLE IF NOT EXISTS payout_details (
  creator_id     BIGINT      PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,

  method         TEXT        NOT NULL DEFAULT 'sepa' CHECK (method IN ('sepa','paypal')),
  account_holder TEXT        NOT NULL,
  iban           TEXT,
  bic            TEXT,
  paypal_email   TEXT,

  -- Anschrift: steht auf der Gutschrift und ist dort Pflichtangabe.
  street         TEXT        NOT NULL,
  postal_code    TEXT        NOT NULL,
  city           TEXT        NOT NULL,
  country        TEXT        NOT NULL DEFAULT 'DE',

  -- Steuerlicher Status. Entscheidet, ob auf der Gutschrift Umsatzsteuer
  -- ausgewiesen wird. 'privat' heißt: keine unternehmerische Tätigkeit –
  -- dann ist eine Gutschrift im Sinne des § 14 Abs. 2 UStG nicht möglich.
  tax_status     TEXT        NOT NULL DEFAULT 'kleinunternehmer'
                 CHECK (tax_status IN ('kleinunternehmer','regelbesteuert','privat')),
  tax_id         TEXT,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Marken ------------------------------------------------------------------
--  Jede Marke ist ein eigener Shop mit eigener Domain und eigenem Rabattsystem.
--  `link_template` enthält den Platzhalter {CODE}; daraus entsteht der Link,
--  den der Creator postet.
CREATE TABLE IF NOT EXISTS brands (
  id                        BIGSERIAL PRIMARY KEY,
  name                      TEXT        NOT NULL,
  slug                      TEXT        NOT NULL UNIQUE,
  shop_url                  TEXT        NOT NULL,
  link_template             TEXT        NOT NULL,
  default_commission_rate   DOUBLE PRECISION NOT NULL DEFAULT 15,
  default_customer_discount DOUBLE PRECISION NOT NULL DEFAULT 10,
  note                      TEXT,
  active                    BOOLEAN     NOT NULL DEFAULT true,
  sort_order                INTEGER     NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Codes je Creator und Marke ----------------------------------------------
--  Ersetzt den einen Code je Creator. Ein Creator kann für mehrere Marken
--  werben und hat je Marke einen eigenen Code, eigene Provision und einen
--  eigenen Link. Der Code muss nur innerhalb einer Marke eindeutig sein –
--  zwei getrennte Shops dürfen denselben Code vergeben.
CREATE TABLE IF NOT EXISTS creator_codes (
  id                BIGSERIAL PRIMARY KEY,
  creator_id        BIGINT      NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  brand_id          BIGINT      NOT NULL REFERENCES brands(id)   ON DELETE CASCADE,
  code              TEXT        NOT NULL,
  code_norm         TEXT        NOT NULL,
  commission_rate   DOUBLE PRECISION NOT NULL DEFAULT 15,
  customer_discount DOUBLE PRECISION NOT NULL DEFAULT 10,
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creator_id, brand_id),
  UNIQUE (brand_id, code_norm)
);

CREATE INDEX IF NOT EXISTS idx_creator_codes_creator ON creator_codes(creator_id);
CREATE INDEX IF NOT EXISTS idx_creator_codes_brand   ON creator_codes(brand_id, code_norm);

-- --- Bestellungen gehören zu einer Marke -------------------------------------
--  Wichtig: Bestellnummern sind nur je Shop eindeutig. Zwei Marken dürfen
--  beide eine Bestellung "1001" haben. Die frühere globale Eindeutigkeit von
--  order_ref wird deshalb durch eine je Marke ersetzt.
ALTER TABLE sales   ADD COLUMN IF NOT EXISTS brand_id BIGINT REFERENCES brands(id) ON DELETE CASCADE;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS brand_id BIGINT REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE sales   DROP CONSTRAINT IF EXISTS sales_order_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_brand_order ON sales(brand_id, order_ref);

-- Damit die Bestellliste zeigen kann, aus welchem Shop eine Bestellung stammt.
-- Und aus demselben Grund wie oben muss auch hier die Marke in den Schlüssel:
-- derselbe Creator kann bei zwei Marken eine Bestellung "1001" haben.
ALTER TABLE snapshot_orders ADD COLUMN IF NOT EXISTS brand_id BIGINT;
ALTER TABLE snapshot_orders DROP CONSTRAINT IF EXISTS snapshot_orders_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshot_orders
  ON snapshot_orders(run_id, creator_id, brand_id, order_ref);

-- --- Snapshot je Marke -------------------------------------------------------
--  snapshot_totals bleibt die Gesamtsumme je Creator. Hier steht zusätzlich die
--  Aufschlüsselung, die das Dashboard je Marke anzeigt.
CREATE TABLE IF NOT EXISTS snapshot_brand_totals (
  run_id           BIGINT NOT NULL REFERENCES snapshot_runs(id) ON DELETE CASCADE,
  creator_id       BIGINT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  brand_id         BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  orders_total     INTEGER NOT NULL DEFAULT 0,
  revenue_total    DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  orders_30d       INTEGER NOT NULL DEFAULT 0,
  revenue_30d      DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission_30d   DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_sale_date   TEXT,
  PRIMARY KEY (run_id, creator_id, brand_id)
);

-- --- Akquise -----------------------------------------------------------------
--  Creator, die noch keine Bewerbung abgeschickt haben: angeschrieben auf
--  Instagram, Termin vereinbart, zu- oder abgesagt. Bewusst eine eigene Tabelle
--  und nicht ein weiterer Status in `creators` – ein Lead hat weder E-Mail noch
--  Code noch eine dokumentierte Zustimmung zu den Regeln, und genau die sind
--  dort Pflichtfelder.
--
--  Sobald sich jemand über seinen persönlichen Bewerbungslink bewirbt, wird
--  creator_id gesetzt. Ab da ist der Lead nur noch Historie; gearbeitet wird
--  mit dem Creator-Datensatz.
CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  instagram     TEXT NOT NULL,
  instagram_norm TEXT NOT NULL,
  full_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'contacted',
  meeting_at    TIMESTAMPTZ,
  follow_up_on  DATE,
  note          TEXT,
  creator_id    BIGINT REFERENCES creators(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ein Instagram-Konto nur einmal – sonst schreibt man denselben Menschen
-- zweimal an, was schlechter ist als ihn gar nicht anzuschreiben.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_instagram ON leads(instagram_norm);
CREATE INDEX IF NOT EXISTS ix_leads_follow_up ON leads(follow_up_on) WHERE follow_up_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_leads_status ON leads(status);

-- --- Zugänge zum Adminbereich ------------------------------------------------
--  Vorher hing der Adminbereich an einem einzigen Passwort aus den
--  Umgebungsvariablen. Sobald mehr als eine Person damit arbeitet, reicht das
--  nicht: Man kann niemandem den Zugang entziehen, ohne neu auszuliefern, und
--  im Protokoll steht nie, wer etwas getan hat.
--
--  Zwei Rollen:
--    owner   – alles, wie bisher
--    manager – Akquise und Creator; keine Marken, Umsätze, Auszahlungen,
--              Nachrichten, keine Kontodaten und keine Login-Links
--
--  ADMIN_PASSWORD bleibt als Notzugang für den Inhaber bestehen, damit ein
--  Fehler in dieser Tabelle niemanden aussperrt.
CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  email_norm    TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'manager',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_email ON admin_users(email_norm);
