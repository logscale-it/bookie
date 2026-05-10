# GoBD-Compliance — Verfahrensdokumentation

Dieses Dokument beschreibt, wie die Anwendung **Bookie** die Anforderungen der
**Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern,
Aufzeichnungen und Unterlagen in elektronischer Form sowie zum Datenzugriff
(GoBD)** erfüllt. Es richtet sich an Steuerberaterinnen und Steuerberater
sowie an externe Prüferinnen und Prüfer (Betriebsprüfung,
Außenprüfung gemäß §§ 146, 147 AO).

Bookie ist eine lokal betriebene Buchhaltungs- und Rechnungsanwendung
(Tauri/SQLite) für kleine Unternehmen. Sämtliche buchführungsrelevanten
Daten liegen in einer SQLite-Datenbank (`bookie.db`) auf dem Endgerät der
Anwenderin oder des Anwenders. Optional können verschlüsselte Backups in
einen S3-kompatiblen Objektspeicher gesichert werden; die hier beschriebenen
Garantien beziehen sich jedoch ausschließlich auf den lokalen
Primärdatenbestand.

> Lesehilfe: Jede der folgenden Garantien verweist auf die konkrete
> Implementierung im Repository (Migration, Modul oder Pull Request).
> Auf diese Weise lässt sich jede Aussage 1:1 gegen den Quellcode
> verifizieren.

---

## 1. Anwendungsbereich — buchführungsrelevante Tabellen

Die folgenden Tabellen der lokalen SQLite-Datenbank enthalten
buchführungsrelevante Aufzeichnungen im Sinne der GoBD und unterliegen
den in den Abschnitten 2–5 beschriebenen Garantien.

| Tabelle                   | Inhalt                                                                          | Aufbewahrung |
| ------------------------- | ------------------------------------------------------------------------------- | ------------ |
| `companies`               | Stammdaten des bilanzierenden Unternehmens (Name, Anschrift, Steuernummer, USt-ID, Bankverbindung). | 10 Jahre     |
| `customers`               | Stammdaten der Geschäftspartner (Kunden und Lieferanten, vgl. Spalte `type`).   | 10 Jahre     |
| `invoices`                | Ausgangsrechnungen (Header inkl. Status, Beträge, Aussteller- und Empfänger­daten, Storno-Verweis). | 10 Jahre     |
| `invoice_items`           | Rechnungspositionen (Beschreibung, Menge, Einzelpreis, Steuersatz, Zeilensumme). | 10 Jahre     |
| `payments`                | Zahlungseingänge zu Ausgangsrechnungen.                                         | 10 Jahre     |
| `incoming_invoices`       | Eingehende Rechnungen (Lieferantenrechnungen) inkl. Originalbeleg.              | 10 Jahre     |
| `invoice_status_history`  | Statusübergänge der Ausgangsrechnungen (z. B. `draft` → `issued` → `paid`).     | 10 Jahre     |
| `invoice_audit`           | Lückenloser Änderungs­verlauf (siehe Abschnitt 3).                              | 10 Jahre     |

Die Aufbewahrungsfrist ergibt sich aus dem rechtlichen Profil der jeweiligen
Rechnung (Spalte `invoices.legal_country_code`). Für Deutschland (DE) wie
für alle weiteren ausgelieferten Länderprofile (AT, CH, FR, NL, US) ist sie
einheitlich auf **10 Jahre** gesetzt (`src/lib/legal/profiles/*.ts`,
Feld `retentionYears`). Dies entspricht § 147 Abs. 3 AO.

Nicht buchführungsrelevant — und damit nicht Gegenstand dieses Dokuments —
sind insbesondere die Tabellen `time_entries` (Zeiterfassung als
Kalkulationsgrundlage), `projects` (Projektstamm), `settings_*`
(Anwendungs­einstellungen) und `vat_taxes` (Stammtabelle der
Umsatzsteuer­sätze). Sie werden zwar mitgesichert, sind aber nicht durch
die hier dokumentierten Trigger- und Guard-Mechanismen geschützt.

---

## 2. Unveränderbarkeit ausgestellter Rechnungen (DAT-2)

GoBD verlangt, dass eine einmal ausgestellte Rechnung nicht mehr verändert
oder gelöscht werden darf (Grundsatz der Unveränderbarkeit, GoBD Rz. 58 ff.,
i. V. m. § 146 Abs. 4 AO). Bookie setzt diesen Grundsatz auf Datenbankebene
durch zwei SQL-Trigger sowie auf Anwendungsebene durch eine vorgeschaltete
TypeScript-Prüfung um.

### 2.1 SQL-Trigger zur Mutationssperre (DAT-2.a, PR #123)

Mit Migration `0020/01_invoice_immutability.sql` wurden zwei Trigger auf der
Tabelle `invoices` eingerichtet, die in einer späteren Migration
(`0021/01_storno_columns.sql`, DAT-2.b) um die Storno-Felder erweitert
wurden:

- **`invoices_immutable_update`** (`BEFORE UPDATE`): Wird die zu ändernde
  Zeile bereits ausgestellt (`OLD.status <> 'draft'`) und ändert sich
  irgendeine inhaltlich relevante Spalte (Beträge, Aussteller- und
  Empfängerdaten, Rechnungsnummer, Daten zu Leistungs- und Lieferzeitraum,
  Bankverbindung, Sprache, rechtliches Profil, Storno-Verweis,
  Storno-Begründung u. a.), so wird die Transaktion mit
  `RAISE(ABORT, 'invoice_immutable')` abgebrochen.
- **`invoices_immutable_delete`** (`BEFORE DELETE`): Eine ausgestellte Rechnung
  (`OLD.status <> 'draft'`) kann nicht gelöscht werden; die Transaktion wird
  ebenfalls mit `RAISE(ABORT, 'invoice_immutable')` abgebrochen.

Bewusst weiterhin zugelassen sind:

- **Statuswechsel** (z. B. `issued` → `paid`) — der Trigger prüft nur
  inhaltliche Spalten und schließt `status`, `updated_at` sowie `s3_key`
  ausdrücklich aus.
- **Aktualisierung des `updated_at`-Zeitstempels** — technisch erforderlich
  für die Reihenfolge der Audit-Einträge.
- **Setzen von `s3_key`** — wird ausschließlich nach erfolgreichem Backup
  in den Objektspeicher beschrieben und stellt selbst kein
  buchführungsrelevantes Datum dar.
- **Löschen von Entwürfen** (`status = 'draft'`) — solange eine Rechnung
  noch nicht ausgestellt ist, gilt sie nicht als Beleg.

### 2.2 Storno-Verfahren (DAT-2.b, PR #132)

Eine ausgestellte Rechnung kann nicht überschrieben, wohl aber durch eine
**Stornorechnung** korrigiert werden. Diese Funktion ist im Modul
`src/lib/db/invoices.ts` als `cancelInvoice(id, reason)` implementiert und
arbeitet ausschließlich additiv:

1. Die Originalrechnung bleibt **bit-genau unverändert** und ist weiterhin
   durch die Trigger aus 2.1 geschützt.
2. Es wird eine neue Rechnungszeile in `invoices` mit den folgenden
   Eigenschaften eingefügt:
   - `status = 'issued'` — die Stornorechnung ist selbst sofort
     ausgestellt und damit ebenfalls unveränderlich.
   - `references_invoice_id` zeigt auf die Originalrechnung.
   - `cancellation_reason` enthält den von der Anwenderin oder dem Anwender
     angegebenen Grund.
   - Die Rechnungsnummer hat das Format `<Originalnummer>-storno-N`,
     wobei `N` mit 1 beginnt und nur dann inkrementiert wird, wenn bereits
     ein Storno zur selben Originalrechnung existiert.
   - Sämtliche monetären Spalten (`net_amount`, `tax_amount`, `gross_amount`,
     `net_cents`, `tax_cents`, `gross_cents`, `due_surcharge`) werden
     **negiert**, sodass die Stornorechnung die Originalrechnung in der
     Buchhaltung exakt aufhebt.
3. Die Positionen aus `invoice_items` werden gespiegelt, mit negierter
   `quantity` und negierter `line_total_net(_cents)`. Der Einzelpreis
   (`unit_price_net(_cents)`) bleibt positiv, sodass die Invariante
   `line_total = quantity × unit_price` erhalten bleibt. Die hierfür
   notwendige Lockerung der `CHECK`-Constraints (vorher `>= 0`) erfolgt in
   derselben Migration `0021`.
4. Die Statusübergänge sowohl der Original- als auch der Stornorechnung
   werden in `invoice_status_history` als Übergang `NULL → 'issued'`
   protokolliert.
5. Alle Schritte laufen in **einer einzigen SQL-Transaktion**. Schlägt ein
   Schritt fehl, wird der gesamte Vorgang zurückgerollt; die Originalrechnung
   bleibt in jedem Fall unangetastet.

Entwurfsrechnungen können nicht storniert werden, sondern werden
regulär gelöscht. Der entsprechende Versuch wird mit dem typisierten Fehler
`InvoiceImmutable` und der Meldung „Entwurfsrechnungen können nicht
storniert werden — bitte löschen statt stornieren“ abgewiesen.

### 2.3 Vorgeschaltete Anwendungsschicht

Zusätzlich zum SQL-Trigger prüft `deleteInvoice` in
`src/lib/db/invoices.ts` vorab, ob die Rechnung noch im Entwurfsstatus ist
und wirft andernfalls denselben typisierten Fehler `InvoiceImmutable`. Die
Anwender­oberfläche kann die Meldung dadurch ohne Stringanalyse anzeigen.
Der SQL-Trigger ist die maßgebliche, nicht umgehbare Sicherung; die
TypeScript-Prüfung dient ausschließlich der Benutzerführung.

---

## 3. Audit-Trail (DAT-4)

GoBD verlangt eine lückenlose, nachvollziehbare Protokollierung aller
Änderungen an buchführungsrelevanten Datensätzen (GoBD Rz. 107 ff.,
„Unveränderbarkeit, Protokollierung, Nachvollziehbarkeit“). Bookie
realisiert dies durch eine eigene Audit-Tabelle und eine Reihe von
SQL-Triggern, die jede Mutation automatisch protokollieren — das
Anwendungsprogramm hat keine Möglichkeit, das Logging zu umgehen.

### 3.1 Tabelle `invoice_audit` (DAT-4.a)

Die Audit-Tabelle wurde mit Migration `0017/01_invoice_audit.sql`
eingeführt. Trotz des Namens ist sie **polymorph** und nimmt Einträge
für mehrere Entitätstypen auf:

```sql
CREATE TABLE invoice_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL,
  entity_id   INTEGER NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  actor       TEXT,
  ts_unix_us  INTEGER NOT NULL,
  fields_diff TEXT    NOT NULL -- JSON {field: {before, after}}
);
CREATE INDEX invoice_audit_entity_idx ON invoice_audit (entity_type, entity_id);
CREATE INDEX invoice_audit_ts_idx     ON invoice_audit (ts_unix_us);
```

Bedeutung der Spalten:

| Spalte         | Bedeutung                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `id`           | Aufsteigende Eintragsnummer (lückenlos je Datenbank).                                                    |
| `entity_type`  | Eine von `'invoices'`, `'invoice_items'`, `'payments'`.                                                  |
| `entity_id`    | Schlüssel der **Rechnung**: für `invoices` die Rechnungs-ID, für `invoice_items` und `payments` die `invoice_id` der Mutterrechnung. So kann ein Prüfer durch einen einzigen Filter `entity_id = X` den vollständigen Lebenszyklus einer Rechnung rekonstruieren. |
| `op`           | `'insert'`, `'update'` oder `'delete'`.                                                                  |
| `actor`        | Optional. Wird derzeit nicht durch die Trigger gesetzt; vorgesehen für eine spätere Anwendungsebene.     |
| `ts_unix_us`   | Mikrosekunden seit Unix-Epoche (UTC), berechnet aus `unixepoch('subsec') × 1 000 000`.                   |
| `fields_diff`  | JSON-Dokument mit dem Spalten-Diff (siehe Abschnitt 3.3).                                                |

### 3.2 Trigger (DAT-4.b, PR #121)

Mit Migration `0019/01_invoice_audit_triggers.sql` wurden je drei Trigger
für die Tabellen `invoices`, `invoice_items` und `payments` angelegt
(insgesamt neun):

- `*_audit_insert` — `AFTER INSERT FOR EACH ROW`
- `*_audit_update` — `AFTER UPDATE FOR EACH ROW`
- `*_audit_delete` — `AFTER DELETE FOR EACH ROW`

Da die Trigger als `AFTER`-Trigger auf Zeilenebene innerhalb der
Datenbank-Engine laufen, gibt es **keinen Codepfad in der Anwendung, der
sie umgehen könnte**: jede Mutation, gleich aus welcher Quelle (UI,
Skript, externes Tooling, manuelle SQL-Konsole), erzeugt einen
Audit-Eintrag.

Der Sonderfall „Storno-Felder“ (`references_invoice_id`,
`cancellation_reason` aus Migration `0021`) wird vollständig durch den
`invoices_audit_insert`-Trigger erfasst, weil `cancelInvoice` diese Felder
beim Einfügen der Stornozeile setzt und der Trigger alle Spalten der neuen
Zeile abbildet (vgl. Kommentar in Migration `0021`).

### 3.3 Format der Spalte `fields_diff`

`fields_diff` ist ein JSON-Objekt, dessen Schlüssel die jeweiligen
Spaltennamen sind und deren Werte stets ein Objekt der Form
`{"before": <alt>, "after": <neu>}` haben.

| Operation | Konvention                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------- |
| `insert`  | `before = null` für jede Spalte; `after` enthält den eingefügten Wert.                              |
| `delete`  | `before` enthält den vorherigen Wert; `after = null` für jede Spalte.                               |
| `update`  | Es werden **nur die tatsächlich geänderten** Spalten ausgegeben (NULL-sichere Vergleichslogik via `IS`). Unveränderte Spalten erscheinen nicht im Diff. |

Beispiel `insert` (gekürzt):

```json
{
  "company_id":     { "before": null, "after": 1 },
  "customer_id":    { "before": null, "after": 17 },
  "invoice_number": { "before": null, "after": "R-2025-001" },
  "status":         { "before": null, "after": "draft" },
  "issue_date":     { "before": null, "after": "2025-03-01" },
  "gross_cents":    { "before": null, "after": 11900 }
}
```

Beispiel `update` (Statuswechsel mit Neuberechnung von `updated_at`):

```json
{
  "status":     { "before": "draft", "after": "issued" },
  "updated_at": { "before": "2025-03-01 10:00:00", "after": "2025-03-01 10:42:17" }
}
```

Beispiel `delete` (gekürzt):

```json
{
  "company_id":     { "before": 1,            "after": null },
  "invoice_number": { "before": "R-2025-001", "after": null },
  "status":         { "before": "draft",      "after": null }
}
```

Hinweis zur technischen Umsetzung der `update`-Diffs: die Trigger
verwenden bewusst nicht `json_patch()`, weil dieses nach RFC 7396 jeden
`null`-Wert rekursiv entfernt (auch ein legitimes
`{"before": null, "after": ...}`). Stattdessen wird das Diff als String
mit `||`-Konkatenation aufgebaut und durch `json(...)` validiert; siehe
ausführlicher Kommentar im Kopf der Migration `0019`.

### 3.4 Schutz der Audit-Tabelle vor Löschung (DAT-4.c, PR #178)

Es existiert keine Anwender­oberfläche zum Löschen von Audit-Einträgen.
Die einzige programmatische Schnittstelle ist `deleteAuditRow(id)` in
`src/lib/db/audit.ts`; sie ruft `assertOutsideRetention(...)` (siehe
Abschnitt 4) auf und löscht nur, wenn die gesetzliche
Aufbewahrungsfrist **abgelaufen** ist. Direkte
`DELETE FROM invoice_audit`-Statements in der Anwendung gibt es nicht.

---

## 4. Aufbewahrungs-Guard (COMP-1.a, PR #148)

§ 147 AO verlangt die Aufbewahrung buchführungsrelevanter Unterlagen für
**zehn Jahre**. Bookie setzt diese Frist als applikatorischen Guard durch,
der jede destruktive Operation auf einer der relevanten Tabellen vor dem
SQL-Aufruf abfängt.

### 4.1 Implementierung

Die Implementierung liegt in `src/lib/db/retention.ts` und exportiert die
folgenden Funktionen:

- **`isWithinRetention(countryCode, createdAt, now?)`** — gibt `true`
  zurück, wenn die übergebene Zeile noch innerhalb des
  Aufbewahrungs­fensters für das angegebene Land liegt. Das Fenster wird
  aus dem rechtlichen Profil (`retentionYears`) gelesen; Bookie verwendet
  365,25 Tage pro Jahr, um Schaltjahre über 10 Jahre hinweg korrekt zu
  berücksichtigen.
- **`assertOutsideRetention(entityLabel, countryCode, createdAt, now?)`** —
  wirft den typisierten Fehler `RetentionViolation` mit deutscher Meldung
  (z. B. „Zahlung darf nicht gelöscht werden — gesetzliche
  Aufbewahrungsfrist von 10 Jahren ist noch nicht abgelaufen“), wenn die
  Zeile noch im Fenster liegt; sonst kein Effekt.

Sicheres Default­verhalten:

- Unbekannte oder leere Länderkennungen fallen auf das **DE-Profil** zurück
  (strengstes mitgeliefertes Profil, GoBD-konform).
- Ein nicht parsbarer `created_at`-Zeitstempel wird als „innerhalb der
  Frist“ gewertet; im Zweifel wird also abgelehnt, nicht gelöscht.

### 4.2 Geschützte Operationen

| Operation                              | Datei                                | Gesperrte Aktion                                        |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `deleteInvoice(id)`                    | `src/lib/db/invoices.ts`             | Löschen einer Rechnung (auch Entwurf, falls > 10 Jahre alt). |
| `deletePayment(id)`                    | `src/lib/db/payments.ts`             | Löschen eines Zahlungseingangs.                         |
| `deleteAuditRow(id)`                   | `src/lib/db/audit.ts`                | Löschen eines Audit-Eintrags (nur intern aufgerufen).   |
| DSGVO-Löschung (`requestErasure`)      | `src/lib/db/dsgvo_erasure.ts`        | Vollständige Löschung eines Kunden inkl. Rechnungen — wird bei Verstoß gegen die Aufbewahrungs­frist mit derselben `RetentionViolation` abgewiesen, der Kundendatensatz bleibt erhalten. |

Für ausgestellte Rechnungen greift zusätzlich der DAT-2.a-Trigger
(siehe Abschnitt 2): selbst wenn die Aufbewahrungs­frist abgelaufen
wäre, würde eine ausgestellte Rechnung nicht gelöscht.

### 4.3 Dauerhaftigkeit

Der Guard wirkt vor dem `DELETE`-Statement und kann nicht durch
Anwender-UI umgangen werden. Bei einem manuellen SQL-Eingriff (z. B.
über die SQLite-Konsole) greifen weiterhin die SQL-Trigger aus
Abschnitt 2 für ausgestellte Rechnungen. Der reine
applikatorische Aufbewahrungs-Guard ist auf Anwendungs­schicht
implementiert; eine Manipulation der Datenbank von außen ist Sache der
betrieblichen Zugriffskontrolle (siehe `docs/operations.md`).

---

## 5. GoBD-Export (COMP-1.b, PR #158)

Für eine Betriebsprüfung steht in den Einstellungen unter
„Backup & Export → GoBD-Export“ eine Funktion zum Erzeugen eines
revisionssicheren Export-Archivs zur Verfügung. Das Archiv ist so
aufgebaut, dass eine Prüferin oder ein Prüfer sämtliche
buchführungsrelevanten Daten eines oder mehrerer Geschäftsjahre ohne
Zugriff auf die Anwendung selbst auswerten kann (Datenträgerüberlassung
Z3 nach GoBD Rz. 165 ff.).

### 5.1 Aufruf und Parameter

Aufruf über die Tauri-Schnittstelle `export_gobd(fromYear, toYear)`,
implementiert in `src-tauri/src/lib.rs` (Funktion `export_gobd`) und
`src-tauri/src/gobd.rs` (Modul `gobd`). Die Parameter:

- `fromYear`, `toYear` — inklusiver Jahresbereich (`from <= to`,
  ansonsten Abweisung mit `InvalidRange`).

Die Datenbank wird ausschließlich **read-only** geöffnet
(`open_readonly`); ein Export verändert die Live-Datenbank nicht und kann
parallel zu produktivem Schreibverkehr ausgeführt werden.

### 5.2 Format des ZIP-Archivs

Das Archiv wird als `gobd-export-<from>-<to>.zip` ausgeliefert und enthält
die folgenden Einträge:

```text
gobd-export-<from>-<to>.zip
├── companies.csv          # vollständiger Stammdaten-Dump
├── customers.csv          # vollständiger Stammdaten-Dump
├── invoices.csv           # gefiltert auf issue_date in [from-01-01, to-12-31]
├── invoice_items.csv      # transitiv über invoice_id gefiltert
├── payments.csv           # transitiv über invoice_id gefiltert
├── invoice_audit.csv      # vollständiger Audit-Verlauf, ungefiltert
├── schema_version.txt     # PRAGMA user_version + Spaltenliste je Tabelle
├── manifest.json          # Verzeichnis aller Dateien mit SHA-256
└── export_signature.txt   # SHA-256 der manifest.json (Hex)
```

Filterregeln:

- **Vollständig** (kein Filter) ausgegeben werden `companies`, `customers`
  sowie `invoice_audit` — die Beteiligten und der vollständige
  Änderungsverlauf müssen GoBD-konform unverändert mitgeliefert werden.
- **Gefiltert** nach Jahresbereich werden `invoices` (über `issue_date`),
  `invoice_items` (über `invoice_id`-Join) und `payments` (über
  `invoice_id`-Join). Damit ist sichergestellt, dass das Archiv
  **in sich konsistent** ist: keine Positionen oder Zahlungen ohne
  zugehörige Rechnung im Archiv.

CSV-Format:

- UTF-8, RFC 4180-konform, Trennzeichen `,`, Zeilenende `\r\n`.
- Erste Zeile = Spaltenkopf in `PRAGMA table_info`-Reihenfolge
  (entspricht der Spaltenreihenfolge im Schema).
- `NULL` wird als leeres Feld dargestellt (RFC 4180 kennt keinen
  NULL-Marker; ein leeres unquotetes Feld ist die übliche Konvention).
- Felder mit `,`, `"`, `\n` oder `\r` werden in doppelte Anführungszeichen
  gesetzt; interne `"` werden verdoppelt.
- BLOBs werden als hexadezimal codierter String ausgegeben.

`schema_version.txt` enthält in der ersten Zeile `user_version=<N>` (der
Wert von `PRAGMA user_version`, gleichbedeutend mit der höchsten
angewendeten Migrations­nummer) und anschließend je Tabelle eine Zeile
`<table>: <col1>,<col2>,...` mit den Spaltennamen in PRAGMA-Reihenfolge.
Damit kann ein Prüfer die Spaltenreihenfolge der CSVs jederzeit
nachvollziehen.

`manifest.json` ist das Verzeichnis aller Archiveinträge:

```json
{
  "format_version": 1,
  "generated_at": "2026-05-10T08:42:17Z",
  "year_range": { "from": 2024, "to": 2025 },
  "files": [
    { "path": "companies.csv",      "sha256": "...", "bytes": 87 },
    { "path": "customers.csv",      "sha256": "...", "bytes": 312 },
    { "path": "invoice_audit.csv",  "sha256": "...", "bytes": 145 },
    { "path": "invoices.csv",       "sha256": "...", "bytes": 540 },
    { "path": "invoice_items.csv",  "sha256": "...", "bytes": 220 },
    { "path": "payments.csv",       "sha256": "...", "bytes": 138 },
    { "path": "schema_version.txt", "sha256": "...", "bytes": 410 }
  ]
}
```

`export_signature.txt` enthält den **lowercase-Hex-SHA-256 von
`manifest.json`** (genau 64 Zeichen, kein Zeilenumbruch). Da die SHA-256
jeder einzelnen Datei im Manifest hinterlegt ist und die Signatur
ihrerseits das Manifest absichert, kann ein Prüfer die Integrität des
gesamten Archivs in zwei Schritten verifizieren:

1. SHA-256 der `manifest.json` neu berechnen und mit
   `export_signature.txt` vergleichen.
2. Für jede in `manifest.json` aufgeführte Datei die SHA-256 neu
   berechnen und mit dem dort hinterlegten Wert vergleichen.

### 5.3 Beispiel-Export

Für einen Bestand mit zwei Kunden (Müller AG, O'Brien & Co), drei
Rechnungen (eine in 2024, zwei in 2025) und zwei Zahlungseingängen
liefert ein Aufruf `export_gobd(2024, 2025)` ein Archiv mit den oben
genannten Einträgen. Auszug aus den CSV-Layouts:

`companies.csv` (Beispielzeile):

```csv
id,name
1,Acme GmbH
```

`customers.csv` (Beispielzeilen mit Sonderzeichen-Escaping nach
RFC 4180):

```csv
id,company_id,name,notes
1,1,Müller AG,"Notes with, comma"
2,1,O'Brien & Co,"Has ""quotes"" and a newline
inside"
```

`invoices.csv` (Auszug der wichtigsten Spalten):

```csv
id,company_id,customer_id,invoice_number,status,issue_date,due_date,gross_amount,gross_cents,...
1,1,1,R-2024-001,issued,2024-06-01,2024-07-01,119.0,11900,...
2,1,1,R-2025-001,paid,2025-02-15,2025-03-15,238.0,23800,...
3,1,2,R-2025-002,issued,2025-11-30,2025-12-30,100.5,10050,...
```

`invoice_items.csv` (Auszug):

```csv
id,invoice_id,description,quantity,unit_price_net,tax_rate,line_total_net,...
1,1,Beratung 2024,1.0,100.0,0.19,100.0,...
2,2,Beratung 2025 Q1,2.0,100.0,0.19,200.0,...
3,3,Lizenz,1.0,84.45,0.19,84.45,...
```

`payments.csv` (Auszug):

```csv
id,invoice_id,payment_date,amount,amount_cents,method,reference,note,...
1,1,2024-07-01,119.0,11900,...
2,2,2025-03-01,238.0,23800,...
```

`invoice_audit.csv` (Beispielzeile):

```csv
id,entity_type,entity_id,op,actor,ts_unix_us,fields_diff
1,invoices,1,insert,system,1717200000000000,"{""company_id"":{""before"":null,""after"":1},...}"
```

`schema_version.txt` (Beispielinhalt):

```text
user_version=24
companies: id,name,...
customers: id,company_id,name,notes,type,...
invoice_audit: id,entity_type,entity_id,op,actor,ts_unix_us,fields_diff
invoices: id,company_id,customer_id,project_id,invoice_number,status,...
invoice_items: id,invoice_id,project_id,time_entry_id,position,description,...
payments: id,invoice_id,payment_date,amount,amount_cents,method,reference,...
```

`manifest.json` und `export_signature.txt` siehe Abschnitt 5.2.

### 5.4 Prüfanweisung für Steuerberaterinnen und Steuerberater

1. Das Archiv mit einem beliebigen ZIP-Werkzeug entpacken.
2. Die SHA-256-Prüfsumme der Datei `manifest.json` berechnen
   (z. B. unter Linux/macOS: `shasum -a 256 manifest.json`, unter Windows
   per `Get-FileHash`); sie muss mit dem Inhalt von
   `export_signature.txt` übereinstimmen.
3. Für jede in `manifest.json` aufgeführte Datei die dort hinterlegte
   SHA-256-Prüfsumme nachrechnen und vergleichen.
4. Die CSVs lassen sich direkt in Excel, LibreOffice Calc oder ein
   beliebiges Auswertungs­werkzeug einlesen (UTF-8, Trennzeichen `,`,
   Zeilenende `\r\n`).
5. Die Spaltenreihenfolge der CSVs entspricht der in
   `schema_version.txt` dokumentierten Schemaversion; Felder mit dem
   Suffix `_cents` enthalten den jeweiligen Betrag in Eurocent als
   ganzzahligen Wert (Primärquelle gegenüber den Real-Spalten ohne
   `_cents`-Suffix).

---

## 6. Verweis auf weitere Unterlagen

- `docs/operations.md` — Betriebshandbuch (Datenpfade, Backup,
  Wiederherstellung, S3-Konfiguration).
- `src-tauri/migrations/` — sämtliche schema-relevanten
  Migrationsskripte; jeder Schritt enthält im Kopfkommentar die
  zugehörige Issue- bzw. PR-Nummer.
- `src/lib/legal/profiles/` — länderspezifische Rechtsprofile
  (Aufbewahrungsfrist, Pflichtangaben, Steuerregelwerke).

---

## 7. Änderungs- und Versionsstand

Dieses Dokument beschreibt den Stand wie folgt:

- DAT-2.a (#57, PR #123) — Migration `0020`
- DAT-2.b (#58, PR #132) — Migration `0021`, `cancelInvoice`
- DAT-4.a (#60) — Migration `0017`
- DAT-4.b (#63, PR #121) — Migration `0019`
- DAT-4.c (#64, PR #178) — `deleteAuditRow` mit Aufbewahrungs-Guard
- COMP-1.a (#90, PR #148) — `src/lib/db/retention.ts`
- COMP-1.b (#91, PR #158) — `src-tauri/src/gobd.rs`, `export_gobd`
- COMP-1.c (#92) — vorliegendes Dokument

Bei künftigen Änderungen am Schema, an den Triggern oder am Export-Format
ist dieses Dokument fortzuschreiben, sodass jede dokumentierte Garantie
weiterhin 1:1 der Implementierung entspricht.
