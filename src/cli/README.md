# Creator-Affiliate-Portal

Bewerbung, Code-Freigabe und tagesaktuelles Sales-Dashboard für Creator.

## Es läuft vollständig auf Netlify. Bei dir läuft nichts.

Alle vier Bestandteile liegen bei Netlify:

| Bestandteil | Wo es läuft |
|-------------|-------------|
| Web-Anwendung (Bewerbung, Adminbereich, Dashboard) | Netlify Function |
| Datenbank | Netlify DB (Postgres, von Netlify bereitgestellt) |
| Tägliche Aktualisierung um 11:00 Uhr | Netlify Scheduled Function |
| Stylesheet | Netlify CDN |

Es gibt **kein zweites Programm**, keinen Dienst auf deinem Rechner, keinen
Server bei dir zu Hause und keine Aufgabe, die du regelmäßig lokal anstoßen
müsstest. Wenn dein Rechner aus ist, läuft das Portal weiter und der 11-Uhr-Lauf
findet statt.

Auch der Betrieb ist vollständig im Browser abgedeckt: Umsätze hochladen,
Bewerbungen freigeben, Codes vergeben, Auszahlungen buchen und die
Aktualisierung von Hand auslösen – alles im Adminbereich.

Zwei Dinge sind trotzdem erwähnenswert, weil sie oft für „läuft lokal" gehalten
werden:

- **Der Code muss einmal zu Netlify.** Der bequemste Weg führt über ein
  GitHub-Repository. Das geht komplett im Browser, ohne Terminal – siehe unten.
- **E-Mails.** Für automatischen Versand braucht es einen SMTP-Zugang, also
  einen gehosteten Maildienst. Wenn du keinen einrichten willst: Das Portal
  funktioniert ohne. Jede Freigabe- und Login-Nachricht steht im Adminbereich
  unter **Nachrichten** mitsamt Login-Link zum Kopieren, und du schickst sie dem
  Creator über Instagram oder WhatsApp – also über den Kanal, über den ihr
  ohnehin schreibt.

Die Ordner `src/server.js` und `src/cli/` gehören zur Entwicklung und sind für
den Netlify-Betrieb nicht nötig. Sie sind dabei, damit du das Portal notfalls
auch woanders betreiben kannst.

Derselbe Code läuft auch auf jedem Host mit einem dauerhaften Node-Prozess –
dann ohne Kaltstarts. Nötig ist das nicht.

---

## Der Ablauf in vier Schritten

- **Creator** bewerben sich über einen Link: Name, E-Mail, Wunsch-Code und Instagram sind Pflicht, TikTok und YouTube freiwillig.
- **Ihr** prüft die Bewerbung, vergebt den Code und setzt Provision und Kundenrabatt.
- **Nach der Freigabe** bekommt der Creator einen Login-Link – per E-Mail, wenn SMTP eingerichtet ist, sonst direkt zum Kopieren im Adminbereich.
- **Das Dashboard wird täglich um 11:00 Uhr aktualisiert** und bleibt zwischen den Läufen unverändert.

---

## Deploy auf Netlify

### 1. Code zu GitHub

**Ohne Terminal, komplett im Browser:**

1. ZIP-Datei entpacken.
2. Auf github.com ein neues, leeres Repository anlegen (privat ist in Ordnung), ohne README.
3. Auf der Seite des leeren Repositories auf **uploading an existing file** klicken.
4. Den **Inhalt** des entpackten Ordners in das Browserfenster ziehen – nicht den Ordner selbst, sondern alles darin. Unterordner werden mit übernommen.
5. **Commit changes.**

Der Ordner `node_modules` darf nicht dabei sein; im ausgelieferten ZIP ist er
ohnehin nicht enthalten. Netlify installiert die Pakete selbst.

**Mit Terminal, falls dir das lieber ist:**

```bash
cd creator-affiliate
git init && git add -A && git commit -m "Creator-Affiliate-Portal"
git remote add origin git@github.com:DEIN-ACCOUNT/creator-affiliate.git
git push -u origin main
```

### 2. Site in Netlify anlegen

Netlify → **Add new site → Import an existing project** → das Repository wählen.
Build-Command und Publish-Verzeichnis stehen bereits in `netlify.toml`, es ist
nichts einzutragen.

### 3. Datenbank anlegen

In der Site: **Project configuration → Database → Add database** (Netlify DB,
läuft auf Neon). Netlify setzt `NETLIFY_DATABASE_URL` selbst – diese Variable
also **nicht** von Hand eintragen.

Alternativ per CLI:

```bash
npx netlify db init
```

Die Tabellen werden beim Deploy angelegt. Falls die Datenbank zu diesem
Zeitpunkt noch nicht verbunden war, legt die Anwendung sie beim ersten Aufruf
selbst an – der Deploy scheitert daran nicht.

### 4. Umgebungsvariablen setzen

**Site configuration → Environment variables.** Diese vier sind Pflicht:

| Variable | Wert |
|----------|------|
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | mindestens 12 Zeichen |
| `NODE_ENV` | `production` |
| `PROGRAM_BRAND` | euer Markenname |

Sinnvoll dazu: `PROGRAM_NAME`, `SUPPORT_EMAIL`, `DEFAULT_COMMISSION_RATE`,
`DEFAULT_CUSTOMER_DISCOUNT`, `REFRESH_HOUR`. Alle Namen stehen in `.env.example`.

`BASE_URL` braucht ihr nur bei eigener Domain – sonst nimmt die Anwendung
automatisch die URL der Site (wichtig für die Login-Links).

**E-Mail ist optional.** Ohne `SMTP_HOST` verschickt das Portal nichts, bleibt
aber voll benutzbar: Jede Nachricht landet im Adminbereich unter
**Nachrichten**, mit dem Login-Link als Kopierknopf. Nach einer Freigabe steht
der Link außerdem direkt auf der Creator-Seite. Ihr schickt ihn dann selbst –
über Instagram, WhatsApp oder eure normale Mailadresse.

Wenn das Portal die Mails übernehmen soll, setzt ihr `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` und `MAIL_FROM`. Ab dann verschwindet der Hinweis im
Adminbereich, und der Versandstatus steht bei jeder Nachricht.

### 5. Deploy

Nach dem ersten erfolgreichen Deploy:

- Die Site zeigt das Bewerbungsformular.
- `/admin` fragt nach `ADMIN_PASSWORD`.
- Unter **Functions** stehen `app` und `snapshot`; bei `snapshot` steht der Zeitplan.

Schnelltest, ob Datenbank und Function zusammenspielen: `https://eure-site.netlify.app/healthz`
muss `{"ok":true,…}` liefern.

---

## Wie der 11-Uhr-Lauf auf Netlify funktioniert

Netlify führt Scheduled Functions **ausschließlich nach UTC** aus. Ein fester
UTC-Zeitpunkt würde durch die Sommerzeit zweimal im Jahr um eine Stunde
verrutschen: 11:00 Uhr deutscher Zeit sind im Sommer 09:00 UTC und im Winter
10:00 UTC.

Deshalb läuft `netlify/functions/snapshot.js` **stündlich** und entscheidet
selbst:

1. Ist es in `REFRESH_TIMEZONE` gerade `REFRESH_HOUR`? Wenn nein: sofort raus.
2. Gibt es für den heutigen Tag schon einen Lauf? Wenn ja: sofort raus.
3. Sonst: Snapshot bauen.

Das kostet 23 Aufrufe pro Tag, die jeweils nach wenigen Millisekunden
zurückkommen, und ist dafür über die Zeitumstellung hinweg korrekt. Ein
doppelter Aufruf bleibt folgenlos.

Uhrzeit ändern: `REFRESH_HOUR` (und optional `REFRESH_MINUTE`,
`REFRESH_TIMEZONE`) in den Umgebungsvariablen. Der Cron-Ausdruck in
`netlify.toml` bleibt auf stündlich.

---

## Warum die Zahlen nur einmal am Tag wechseln

Das ist eine bewusste Entscheidung und der Kern des Datenmodells:

- `sales` enthält die Rohdaten aus den Importen. Ihr könnt dort jederzeit korrigieren, nachimportieren und Retouren nachreichen.
- `snapshot_*` enthält den eingefrorenen Stand, den Creator sehen. Das Dashboard liest **ausschließlich** aus diesen Tabellen.

Ein Creator, der um 9 Uhr und um 16 Uhr schaut, sieht dieselbe Zahl. Ohne diese
Trennung schwanken Beträge im Tagesverlauf, sobald ihr etwas korrigiert – und
ihr bekommt Nachrichten wie „gestern standen da 340 €, jetzt nur noch 310 €".

Die komplette Aggregation läuft in vier SQL-Anweisungen, nicht in einer Schleife
über alle Creator. Das ist die Voraussetzung dafür, dass der Lauf in das
30-Sekunden-Limit einer Scheduled Function passt.

---

## Provisionslogik

- Provision entsteht **nur auf Bestellungen mit Status „bestätigt"**.
- Grundlage ist der Nettobetrag (`net_amount`/`netto`). Fehlt die Spalte, wird der Bruttobetrag verwendet – dann rechnet ihr auf Bruttobasis, was selten gewollt ist.
- Retouren kommen automatisch heraus: dieselbe Bestellnummer mit Status `refunded` erneut hochladen, der nächste Snapshot korrigiert Umsatz und Provision.
- `commission_open` = verdiente Provision minus bereits gebuchte Auszahlungen.

---

## CSV-Format

Erkannt werden `,`, `;` und Tab als Trennzeichen, deutsche und englische
Zahlenformate sowie mehrere Datumsformate. Spaltennamen werden über Aliase
erkannt.

| Feld | Pflicht | Erkannte Spaltennamen |
|------|---------|------------------------|
| Bestellnummer | ja | `order_ref`, `bestellnummer`, `order_id`, `name` |
| Code | ja | `code`, `rabattcode`, `gutscheincode`, `discount_code`, `coupon` |
| Datum | ja | `order_date`, `datum`, `bestelldatum`, `created_at` |
| Bruttobetrag | ja | `gross_amount`, `brutto`, `total`, `umsatz` |
| Provisionsbasis | nein | `net_amount`, `netto`, `subtotal` |
| Status | nein | `status`, `financial_status` |

Beispiel: `sample/umsatz-beispiel.csv`, Vorlage unter `/admin/import/vorlage.csv`.

Bestehende Bestellnummern werden aktualisiert statt doppelt angelegt – denselben
Export mehrfach hochzuladen ist gefahrlos. Bestellungen mit unbekanntem Code
werden gespeichert und im Importergebnis aufgelistet, aber niemandem zugeordnet.
So fällt auf, wenn ein Creator einen falsch geschriebenen Code kommuniziert.

---

## Lokal entwickeln

Gebraucht wird Node ab Version 20 und ein Postgres.

```bash
npm install
cp .env.example .env          # DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD setzen
createdb creator_affiliate    # oder eine vorhandene Datenbank eintragen
npm run migrate
npm run seed                  # optionale Demo-Daten
npm start                     # http://localhost:3000
```

Ohne SMTP steht jede Nachricht mitsamt Login-Link unter `/admin/mails` – so
lässt sich der komplette Ablauf durchspielen, ohne eine einzige Mail zu
verschicken.

```bash
npm test          # 26 Tests; ohne erreichbares Postgres laufen die reinen Funktionstests
npm run refresh   # Snapshot manuell erzeugen
npm run import datei.csv
```

Für die Testsuite empfiehlt sich eine eigene Datenbank, weil sie die Tabellen leert:

```bash
createdb creator_affiliate_test
TEST_DATABASE_URL=postgres://localhost/creator_affiliate_test npm test
```

Der lokale Start (`npm start`) nutzt `node-cron` mit echter Zeitzonenangabe.
Die Netlify-Variante mit dem stündlichen Scheduler wird nur in der Function
verwendet – beide rufen denselben Code auf.

---

## Was noch fehlt, bevor das live geht

1. **Rechtstexte ersetzen.** `src/views/terms.ejs` und `src/views/privacy.ejs` sind Gerüste, keine geprüften Texte.
2. **Impressum ergänzen** – Pflicht nach § 5 DDG, aktuell nicht enthalten.
3. **Rate-Limit** auf `/login` und `/bewerben`, sobald die Seite öffentlich verlinkt ist.
4. **Zweiter Admin-Zugang**, falls mehrere Leute freigeben sollen – aktuell gibt es ein gemeinsames Passwort.
5. **SMTP**, sobald ihr mehr als eine Handvoll Creator habt – Links von Hand zu verschicken skaliert nicht ewig.
6. **Backups.** Netlify DB (Neon) hat Point-in-Time-Recovery; prüft, welcher Zeitraum in eurem Tarif enthalten ist.

---

## Warum die Werberegeln fest eingebaut sind

Nach § 8 Abs. 2 UWG haftet ihr als Auftraggeber für die Werbung eurer Creator
mit – auch für Verstöße, von denen ihr nichts wisst. Eine Abmahnung wegen
fehlender Werbekennzeichnung oder einer Heilaussage landet bei euch, nicht beim
Creator.

Deshalb enthält das System drei Dinge, die im Streitfall zählen:

- **Zustimmung mit Zeitstempel, IP und Versionsnummer** (`terms_version`, `terms_accepted_at`). Bei einer Änderung der Regeln zählt ihr `termsVersion` in `src/config.js` hoch – dann ist nachvollziehbar, wer welcher Fassung zugestimmt hat.
- **Die Regeln im Dashboard**, konkret formuliert statt als Fließtext im Anhang.
- **Codesperren für Arzneimittelbegriffe.** Ein Code wie `OZEMPIC10` wäre für sich genommen bereits Publikumswerbung für ein verschreibungspflichtiges Arzneimittel. Die Liste steht in `src/lib/validate.js` und gehört an euer Sortiment angepasst.

Das ersetzt keine anwaltliche Prüfung, verschiebt aber die Beweislage deutlich
zu euren Gunsten.

---

## Aufbau

```
netlify.toml             Build, Function-Bundling, Redirect, Zeitplan
netlify/functions/
  app.js                 die Express-App als Function (serverless-http)
  snapshot.js            stündlicher Scheduler mit Zeitzonenprüfung
src/
  app.js                 baut die Express-App (ohne listen – für beide Betriebsarten)
  server.js              klassischer Serverstart mit node-cron
  config.js              Konfiguration aus Umgebungsvariablen
  db.js / schema.sql     Postgres-Pool, Transaktionen, Migration mit Advisory Lock
  lib/
    validate.js          Formular- und Code-Prüfung, gesperrte Begriffe
    auth.js              Magic-Link-Login, signierte Cookies (zustandslos)
    mailer.js            SMTP optional; jede Nachricht landet im Ausgangspostfach
    csv.js               CSV-Parser inkl. deutscher Zahlen- und Datumsformate
    chart.js             Balkenchart als Inline-SVG, ohne Chart-Bibliothek
    dates.js / format.js Zeitzone und deutsche Formatierung
  services/
    importSales.js       CSV → Rohdaten
    snapshot.js          Rohdaten → eingefrorener Dashboard-Stand (reines SQL)
  routes/                public.js, creator.js, admin.js (inkl. /admin/mails)
  views/                 EJS-Templates
  cli/                   migrate.js, seed.js, import.js, refresh.js
public/styles.css        ein Stylesheet, hell und dunkel (liefert das Netlify-CDN)
test/                    26 Tests
```

Keine Frontend-Build-Kette, kein CDN für Skripte: Das Dashboard funktioniert
auch, wenn externe Ressourcen blockiert sind, und das Chart ist
server-gerendertes SVG.

---

## Bekannte Grenzen der Netlify-Variante

Ehrlich, damit es später keine Überraschungen gibt:

- **Kaltstarts.** Nach längerer Ruhe dauert der erste Aufruf spürbar länger, weil die Function startet und eine Postgres-Verbindung aufbaut. Für ein Partnerportal ist das unkritisch, fällt aber auf.
- **10 Sekunden pro Request.** Der CSV-Import ist auf 10 MB begrenzt und läuft in Blöcken; sehr große Exporte teilt ihr auf.
- **30 Sekunden für den Snapshot.** Bei einigen hundert Creatern kein Thema, weil alles in SQL läuft. Wenn ihr in den vierstelligen Bereich kommt, gehört das gemessen.
- **Verbindungen.** Jede Function-Instanz hält eine Verbindung. Nutzt die gepoolte Verbindungszeichenfolge von Netlify DB (Standard), nicht die ungepoolte.
- **Keine Dateiablage.** Uploads werden im Speicher verarbeitet und nicht abgelegt. Wenn ihr Importdateien archivieren wollt, braucht es einen Objektspeicher.

Wenn eine dieser Grenzen stört, läuft dieselbe Anwendung unverändert mit
`npm start` auf jedem Host mit dauerhaftem Prozess – dann übernimmt `node-cron`
den 11-Uhr-Lauf und es gibt keine Kaltstarts.
