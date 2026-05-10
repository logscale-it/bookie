# GoBD-Konformität von Bookie

> **Hinweis für den Steuerberater / Betriebsprüfer:** Dieses Dokument beschreibt,
> welche technischen Maßnahmen Bookie umsetzt, um die _Grundsätze zur
> ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und
> Unterlagen in elektronischer Form sowie zum Datenzugriff_ (GoBD, BMF-Schreiben
> vom 28.11.2019) zu erfüllen. Jede Garantie ist 1:1 auf eine konkrete
> Implementierung zurückführbar; die Quelldatei-Pfade sind jeweils angegeben,
> damit ein Entwickler die Aussage direkt im Code nachprüfen kann.

---

## 1. Geltungsbereich

Die folgenden Tabellen der lokalen SQLite-Datenbank (`bookie.db`) gelten als
buchungsrelevante Unterlagen im Sinne der GoBD:

| Tabelle             | Inhalt                              | Buchungsrelevanz             |
| ------------------- | ----------------------------------- | ---------------------------- |
| `invoices`          | Ausgangsrechnungen (Header)         | Ja – Buchungsbeleg           |
| `invoice_items`     | Rechnungspositionen                 | Ja – Bestandteil des Belegs  |
| `payments`          | Zahlungseingänge                    | Ja – Buchungsnachweis        |
| `invoice_audit`     | Lückenloser Änderungslog            | Ja – Verfahrensdokumentation |
| `incoming_invoices` | Eingangsrechnungen (Belege Dritter) | Ja – Eingangsbeleg           |

Nicht buchungsrelevant und daher nicht im Fokus dieses Dokuments: `companies`,
`customers`, `projects`, `time_entries`, `settings` (reine Stamm- und
Konfigurationsdaten ohne eigenständigen Belegcharakter; sie werden dennoch
vollständig in den GoBD-Export einbezogen, damit der Prüfer den
Buchungskontext rekonstruieren kann).

---

## 2. Unveränderbarkeit (Immutabilität)

### 2.1 Anforderung

GoBD Rn. 64–68: Ein Buchungsbeleg darf nach seiner Verbuchung nicht mehr
geändert oder gelöscht werden, ohne dass die Änderung protokolliert wird.

### 2.2 SQL-Ebene — Trigger `invoices_immutable_*`

**Datei:** `src-tauri/migrations/0020/01_invoice_immutability.sql`
(ergänzt in `0021/01_storno_columns.sql`)

Sobald eine Rechnung den Status `'draft'` verlässt, greifen zwei
BEFORE-Trigger auf der Tabelle `invoices`:

- **`invoices_immutable_update`** – prüft bei jedem UPDATE, ob eine der
  buchungsrelevanten Spalten verändert wird. Erlaubte Ausnahmen sind
  ausschließlich `status` (z. B. `sent` → `paid`), `updated_at` und `s3_key`
  (Backup-Referenz). Bei unerlaubter Änderung bricht der Trigger mit
  `RAISE(ABORT, 'invoice_immutable')` ab.
- **`invoices_immutable_delete`** – verhindert das Löschen jeder nicht im
  Status `'draft'` befindlichen Rechnung ebenfalls mit `RAISE(ABORT, 'invoice_immutable')`.

Der Trigger ist die _letzte_ Verteidigungslinie und schützt die Daten auch
dann, wenn die Anwendungsschicht umgangen wird (z. B. Direktzugriff per
SQLite-Browser).

### 2.3 Anwendungsebene — TypeScript

**Datei:** `src/lib/db/invoices.ts`, Funktionen `updateInvoice` und
`deleteInvoice`

Vor dem Datenbankzugriff prüft die TypeScript-Schicht den Status der
Rechnung und wirft einen `InvoiceImmutable`-Fehler (`Error` mit
`err.name = 'InvoiceImmutable'`). Dies erlaubt der Oberfläche, eine
sprachlich klare deutsche Fehlermeldung anzuzeigen, bevor die Datenbank
überhaupt kontaktiert wird.

### 2.4 Storno-Verfahren

**Datei:** `src/lib/db/invoices.ts`, Funktion `cancelInvoice`
**Migration:** `src-tauri/migrations/0021/01_storno_columns.sql`

GoBD schreibt vor, dass eine falsche Buchung nicht gelöscht, sondern durch
einen Gegenbuchungssatz (Storno) korrigiert wird. Bookie implementiert
dies wie folgt:

1. Die Originalrechnung bleibt bit-identisch unverändert.
2. Es wird eine neue Rechnung mit Statuswert `'issued'` eingefügt:
   - `invoice_number` erhält das Suffix `-storno-N` (N zählt ab 1).
   - Alle Geldbeträge (`net_cents`, `tax_cents`, `gross_cents`) werden
     negiert.
   - `references_invoice_id` verweist auf die Originalrechnung.
   - `cancellation_reason` enthält die vom Nutzer angegebene Begründung.
3. Die Storno-Positionen spiegeln die Originalpositionen mit negativer
   `quantity` und negativem `line_total_net_cents`.
4. Der gesamte Vorgang läuft in einer SQL-Transaktion – schlägt er fehl,
   bleibt die Datenbank unverändert.

Wichtig: Die Storno-Rechnung selbst ist nach dem Einfügen sofort durch die
Trigger aus Abschnitt 2.2 gegen Mutation geschützt.

**Tests:** `tests/db/invoices-cancel.test.ts` (DAT-2.c, PR #136)

---

## 3. Vollständigkeit und Nachvollziehbarkeit (Audit-Trail)

### 3.1 Anforderung

GoBD Rn. 71–73: Jede Änderung an buchungsrelevanten Daten muss mit Zeitstempel
und Art der Änderung protokolliert werden; der ursprüngliche Inhalt muss
erkennbar bleiben.

### 3.2 Tabelle `invoice_audit`

**Migration:** `src-tauri/migrations/0017/01_invoice_audit.sql`

```sql
CREATE TABLE invoice_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL,            -- 'invoices' | 'invoice_items' | 'payments'
  entity_id   INTEGER NOT NULL,            -- Rechnungs-ID (auch für Kindzeilen)
  op          TEXT    NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  actor       TEXT,                        -- derzeit NULL; vorgesehen für Benutzerkennung
  ts_unix_us  INTEGER NOT NULL,            -- Mikrosekunden seit Unix-Epoch (UTC)
  fields_diff TEXT    NOT NULL             -- JSON {"spalte": {"before": …, "after": …}}
);
```

Indizes auf `(entity_type, entity_id)` und `ts_unix_us` ermöglichen
effiziente Abfragen sowohl nach Beleg als auch nach Zeitraum.

### 3.3 AFTER-Trigger für `invoices`, `invoice_items`, `payments`

**Migration:** `src-tauri/migrations/0019/01_invoice_audit_triggers.sql`

Für jede der drei buchungsrelevanten Tabellen existieren drei AFTER-Trigger
(INSERT / UPDATE / DELETE), die automatisch Einträge in `invoice_audit`
schreiben:

- **INSERT:** `before = NULL`, `after = NEW.spalte` für jede Spalte.
- **UPDATE:** Nur geänderte Spalten werden als `{"before": …, "after": …}`
  JSON emittiert; unveränderte Spalten fehlen im Diff, um den Log schlank
  zu halten. NULL-Gleichheit wird korrekt via `OLD.x IS NEW.x` gehandhabt.
- **DELETE:** `before = OLD.spalte`, `after = NULL` für jede Spalte.

Der Zeitstempel `ts_unix_us` wird mit
`CAST(unixepoch('subsec') * 1000000 AS INTEGER)` in Mikrosekunden gesetzt
und ist damit auf SQLite-Trigger-Ebene so präzise wie möglich.

Die `entity_id` für `invoice_items`- und `payments`-Trigger ist jeweils die
übergeordnete `invoice_id`, sodass der gesamte Lebensweg einer Rechnung
(Header + Positionen + Zahlungen) durch Filterung auf `entity_id` in einem
einzigen Abfrageschritt rekonstruierbar ist.

### 3.4 Löschen von Audit-Zeilen

**Datei:** `src/lib/db/audit.ts`, Funktion `deleteAuditRow`

Audit-Zeilen haben im normalen Betrieb keine Lösch-UI. Die Funktion
`deleteAuditRow` existiert ausschließlich als zukünftiger Einstiegspunkt
für Wartungswerkzeuge und unterliegt ebenfalls der Aufbewahrungsschutzprüfung
aus Abschnitt 4.

---

## 4. Aufbewahrung (10-Jahres-Frist)

### 4.1 Anforderung

§ 147 Abs. 1 Nr. 1 und 4 i. V. m. Abs. 3 AO: Buchungsbelege und
Aufzeichnungen sind zehn Jahre aufzubewahren. Die GoBD konkretisiert dies
dahin, dass ein Löschen während der Aufbewahrungsfrist nicht zulässig ist.

### 4.2 Retention Guard

**Datei:** `src/lib/db/retention.ts`

Bookie verhindert destruktive Operationen auf buchungsrelevanten Zeilen,
solange die Aufbewahrungsfrist noch läuft. Die Kernfunktionen sind:

```typescript
// Gibt true zurück, wenn createdAt noch innerhalb der Frist liegt.
export function isWithinRetention(
  countryCode: string | null | undefined,
  createdAt: string, // SQLite 'YYYY-MM-DD HH:MM:SS'
  now: Date = new Date(),
): boolean;

// Wirft RetentionViolation, wenn die Frist noch nicht abgelaufen ist.
export function assertOutsideRetention(
  entityLabel: string,
  countryCode: string | null | undefined,
  createdAt: string,
  now: Date = new Date(),
): void;
```

Die Fristlänge stammt aus dem _Legal Profile_ des jeweiligen Landes
(`src/lib/legal/types.ts`, Feld `retentionYears`). Für Deutschland:

**Datei:** `src/lib/legal/profiles/de.ts`

```typescript
// § 147 Abs. 3 AO — buchungsrelevante Unterlagen: 10 Jahre.
retentionYears: 10;
```

Alle anderen Länderprofile (AT, CH, FR, NL, US) sind auf denselben Wert
gesetzt, da der GoBD-Standard die konservativste Vorgabe darstellt und ein
unbeabsichtigter Kurzschluss auf einen kürzeren Wert vermieden werden soll.

**Fallback:** Kann der Ländercode nicht aufgelöst werden (unbekannter Wert
oder `null`), greift immer das deutsche Profil – Sicherheit geht vor
Nachsicht.

**Fehlertyp:** `RetentionViolation` (`Error` mit `err.name = 'RetentionViolation'`)
mit deutscher Fehlermeldung, z. B.:

> „Rechnung darf nicht gelöscht werden — gesetzliche Aufbewahrungsfrist von
> 10 Jahren ist noch nicht abgelaufen"

### 4.3 Absicherung pro Entität

| Funktion         | Datei                    | Guard                                        |
| ---------------- | ------------------------ | -------------------------------------------- |
| `deleteInvoice`  | `src/lib/db/invoices.ts` | `assertOutsideRetention('Rechnung', …)`      |
| `deletePayment`  | `src/lib/db/payments.ts` | `assertOutsideRetention('Zahlung', …)`       |
| `deleteAuditRow` | `src/lib/db/audit.ts`    | `assertOutsideRetention('Audit-Eintrag', …)` |

Hinweis: `deleteInvoice` prüft den Guard auch für Entwurfsrechnungen (`draft`),
die nie ausgestellt wurden, sobald deren `created_at` noch innerhalb der
Frist liegt. Damit ist keine Buchungsunterlage während der Frist durch
einfaches Verbleiben im Draft-Status löschbar.

**Tests:** `tests/db/retention.test.ts` (COMP-1.a, PR #148)

---

## 5. Export für die Betriebsprüfung (GoBD-Export)

### 5.1 Auslösen des Exports

Der Export wird unter **Einstellungen → Backup → GoBD-Export** ausgelöst.
Dort wählt der Nutzer einen Zeitraum (Von-Jahr / Bis-Jahr, jeweils
ganzzahlige Kalenderjahre), und Bookie erzeugt eine ZIP-Datei, die direkt
an den Betriebsprüfer übergeben werden kann.

**Tauri-Kommando:** `export_gobd(from_year, to_year)`
**Backend-Implementierung:** `src-tauri/src/gobd.rs` (COMP-1.b, PR #158)

### 5.2 Archivaufbau

```
gobd-export-<from>-<to>.zip
├── companies.csv          Vollständige Stammtabelle (keine Jahresfilterung)
├── customers.csv          Vollständige Stammtabelle
├── invoices.csv           Rechnungen mit issue_date im Exportzeitraum
├── invoice_items.csv      Positionen der exportierten Rechnungen
├── payments.csv           Zahlungen zu den exportierten Rechnungen
├── invoice_audit.csv      Vollständiger Änderungslog (keine Jahresfilterung)
├── schema_version.txt     PRAGMA user_version + Spaltenreihenfolge je Tabelle
├── manifest.json          {"files": [{"path":…, "sha256":…, "bytes":…}, …]}
└── export_signature.txt   Hex-SHA-256 von manifest.json
```

Alle CSV-Dateien folgen RFC 4180:

- Zeichensatz: UTF-8.
- Zeilenende: CRLF (`\r\n`).
- Erste Zeile: Spaltenüberschriften in der Reihenfolge `PRAGMA table_info`.
- Felder mit Komma, Anführungszeichen, Zeilenumbruch oder Wagenrücklauf
  werden in doppelte Anführungszeichen eingeschlossen; interne
  Anführungszeichen werden verdoppelt (`""`).
- NULL-Werte werden als leeres Feld ohne Anführungszeichen dargestellt.

### 5.3 Jahresfilterung

| Tabelle                                   | Filterbedingung                                      |
| ----------------------------------------- | ---------------------------------------------------- |
| `invoices`                                | `issue_date BETWEEN '<from>-01-01' AND '<to>-12-31'` |
| `invoice_items`                           | `invoice_id` gehört zu einer exportierten Rechnung   |
| `payments`                                | `invoice_id` gehört zu einer exportierten Rechnung   |
| `companies`, `customers`, `invoice_audit` | Kein Filter – vollständiger Dump                     |

Der uneingeschränkte Dump der `invoice_audit`-Tabelle entspricht der GoBD-
Anforderung, den Änderungslog unverändert zu bewahren: Ein Prüfer muss alle
Änderungen sehen können, nicht nur die im Exportzeitraum erzeugten.

Die DB-Verbindung für den Export wird READ-ONLY geöffnet
(`SQLITE_OPEN_READ_ONLY`), um Schreibkonflikte mit dem laufenden
Anwendungsbetrieb zu vermeiden.

### 5.4 Ausgearbeitetes Beispiel

Angenommen, die Datenbank enthält folgende Rechnung:

| Feld             | Wert                 |
| ---------------- | -------------------- |
| `id`             | 42                   |
| `invoice_number` | `R-2024-001`         |
| `issue_date`     | `2024-06-15`         |
| `customer_id`    | 7                    |
| `net_cents`      | 10000 (= 100,00 EUR) |
| `tax_cents`      | 1900 (= 19,00 EUR)   |
| `gross_cents`    | 11900 (= 119,00 EUR) |
| `status`         | `paid`               |

**Ausschnitt `invoices.csv`** (Export 2024–2024, vereinfachte Spaltenauswahl
zur Übersichtlichkeit):

```
id,invoice_number,issue_date,customer_id,net_cents,tax_cents,gross_cents,status
42,R-2024-001,2024-06-15,7,10000,1900,11900,paid
```

**Zugehörige Position `invoice_items.csv`:**

```
id,invoice_id,position,description,quantity,unit_price_net_cents,line_total_net_cents
101,42,1,Beratungsleistung Mai 2024,1.0,10000,10000
```

**Zugehörige Zahlung `payments.csv`:**

```
id,invoice_id,payment_date,amount_cents,method
55,42,2024-07-03,11900,bank_transfer
```

**Ausschnitt `manifest.json`:**

```json
{
  "format_version": 1,
  "generated_at": "2025-01-10T08:30:00Z",
  "year_range": { "from": 2024, "to": 2024 },
  "files": [
    {
      "path": "companies.csv",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "bytes": 0
    },
    {
      "path": "invoices.csv",
      "sha256": "a1b2c3d4e5f6...",
      "bytes": 1234
    }
  ]
}
```

**`export_signature.txt`:**

```
8f14e45fceea167a5a36dedd4bea2543ce2e72a8f56b3d7d8e0f9bc4c57f4e1a
```

Der Inhalt von `export_signature.txt` ist der SHA-256-Hash der gesamten
`manifest.json`-Datei. Damit kann ein Prüfer mit einem standardmäßigen
SHA-256-Werkzeug die Unverfälschtheit des Manifests verifizieren.

---

## 6. Schlüssel- und Signaturkonzept

### 6.1 Integritätssicherung pro Datei

**Datei:** `src-tauri/src/gobd.rs`, Funktion `build_export`

Für jede Datei im Archiv (CSVs, `schema_version.txt`) wird ein SHA-256-Digest
über die erzeugten Bytes berechnet und als `sha256`-Feld in `manifest.json`
eingetragen. Ein Betriebsprüfer oder ein nachgelagertes Prüfwerkzeug kann
jeden einzelnen Digest reproduzieren, indem er die CSV aus dem ZIP extrahiert
und erneut hasht.

### 6.2 Export-Signatur

`export_signature.txt` enthält den SHA-256-Hash der gesamten
`manifest.json`-Datei (kleingeschriebenes Hex). Die Kette lautet:

```
CSV-Datei  →  SHA-256 → manifest.json (Eintrag sha256)
                            ↓
                         manifest.json gesamt  →  SHA-256 → export_signature.txt
```

Damit ist sowohl die Integrität jeder einzelnen CSV-Datei als auch die
Unverfälschtheit des Manifests selbst prüfbar – mit handelsüblichen
Betriebssystem-Werkzeugen (`sha256sum` / `Get-FileHash`) ohne proprietäre
Software.

### 6.3 Einschränkungen

- Es gibt **keine asymmetrische Signatur** (kein privater Schlüssel). Der
  SHA-256-Hash der Manifest-Datei schützt gegen unbeabsichtigte Datenverfälschung
  während der Übertragung oder Archivierung, nicht gegen vorsätzliche
  Manipulation durch jemanden mit Zugriff auf den Exportprozess.
- Der Export trägt keinen qualifizierten Zeitstempel. Der Wert `generated_at`
  in `manifest.json` wird lokal berechnet (keine vertrauenswürdige
  Zeitquelle). Für Zwecke einer Betriebsprüfung ist das in der Regel
  ausreichend, da der Prüfer den Export anfordert und das Erstellungsdatum
  aus dem Prüfungsprotokoll ersichtlich ist.

---

## 7. Querverweise Implementierung ↔ GoBD-Anforderung

| GoBD-Anforderung                       | Implementierung                                | Quelldatei / PR                                      |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Unveränderbarkeit (Rn. 64–68)          | SQL-Trigger `invoices_immutable_*`             | `src-tauri/migrations/0020/`, `0021/`; PR #123, #132 |
| Unveränderbarkeit – TS-Schicht         | `updateInvoice`, `deleteInvoice` mit Pre-Check | `src/lib/db/invoices.ts`; PR #132                    |
| Storno-Verfahren                       | `cancelInvoice`                                | `src/lib/db/invoices.ts`; PR #132                    |
| Nachvollziehbarkeit (Rn. 71–73)        | `invoice_audit`-Tabelle + AFTER-Trigger        | `src-tauri/migrations/0017/`, `0019/`; PR #110, #121 |
| Aufbewahrungsfrist 10 Jahre (§ 147 AO) | `isWithinRetention`, `assertOutsideRetention`  | `src/lib/db/retention.ts`; PR #148                   |
| Unveränderbarkeit des Audit-Logs       | `deleteAuditRow` mit Retention-Guard           | `src/lib/db/audit.ts`; PR #148                       |
| Datenzugriff für Betriebsprüfer        | `export_gobd` Tauri-Kommando + ZIP-Generator   | `src-tauri/src/gobd.rs`; PR #158                     |
| Maschinelle Auswertbarkeit (CSV)       | RFC-4180-konforme CSV-Ausgabe                  | `src-tauri/src/gobd.rs` (`dump_table_to_csv`)        |
| Integrität des Exports                 | SHA-256 je Datei + Manifest-Signatur           | `src-tauri/src/gobd.rs` (`build_export`)             |
