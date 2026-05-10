# GoBD-Konformität — Verfahrensdokumentation

Dieses Dokument beschreibt, mit welchen technischen Maßnahmen Bookie die
Anforderungen der **Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung
von Büchern, Aufzeichnungen und Unterlagen in elektronischer Form sowie zum
Datenzugriff (GoBD)** umsetzt. Es richtet sich an Steuerberaterinnen und
Steuerberater sowie an Betriebsprüferinnen und Betriebsprüfer der
Finanzverwaltung.

Jede in diesem Dokument benannte Garantie verweist auf konkrete Stellen im
Quellcode (Dateipfad und gegebenenfalls Migrationsnummer), damit die Aussagen
1:1 auf die Implementierung abbildbar sind.

> Bookie ist eine lokal-first installierte Desktop-Anwendung (Tauri v2 +
> SQLite). Alle Datenbestände liegen auf dem Gerät der betreibenden Person;
> es gibt keinen zentralen Server. Sicherungskopien können optional in einen
> S3-kompatiblen Speicher hochgeladen werden, ändern an den GoBD-Garantien
> aber nichts: maßgeblich ist die SQLite-Datenbank `bookie.db`.

---

## 1. Geltungsbereich

GoBD-relevant sind alle Buchungsbelege, deren Änderungshistorie sowie die
zugehörigen Stamm- und Bewegungsdaten. In Bookie sind dies konkret:

| Tabelle                   | Inhalt                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `invoices`                | Ausgangsrechnungen inkl. Stornorechnungen                                                |
| `invoice_items`           | Rechnungspositionen                                                                     |
| `payments`                | Zahlungseingänge zu Ausgangsrechnungen                                                  |
| `incoming_invoices`       | Eingangsrechnungen (Lieferanten-/Eingangsbelege)                                        |
| `invoice_status_history`  | Statusübergänge einer Rechnung (z. B. `draft → issued → paid`)                          |
| `invoice_audit`           | Polymorphes Änderungsprotokoll für `invoices`, `invoice_items`, `payments`              |
| `companies`, `customers`  | Stammdaten (Unternehmen / Kunden), die im GoBD-Export mitgeliefert werden                |

Die für die Buchhaltung maßgeblichen Tabellen `invoices`, `invoice_items`,
`payments`, `invoice_audit` werden zusätzlich durch die in den Abschnitten
2 bis 4 beschriebenen Mechanismen geschützt. Die im GoBD-Export enthaltene
Tabellenliste ist in `src-tauri/src/gobd.rs` als `FULL_TABLES` und
`FILTERED_TABLES` deklariert.

Gesetzliche Aufbewahrungsfrist: **10 Jahre** für die deutsche Rechtskonfiguration
(`legal_country_code = 'DE'`), vorgegeben durch §147 Abs. 3 AO. Die
Konfiguration findet sich in `src/lib/legal/profiles/de.ts` (Feld
`retentionYears: 10`). Auch alle weiteren mitgelieferten Profile (AT, CH, FR,
NL, US) verwenden derzeit konservativ 10 Jahre, sofern die betreibende
Person nichts anderes konfiguriert.

---

## 2. Unveränderlichkeit (DAT-2)

Sobald eine Rechnung den Status `draft` verlässt (also ausgestellt wurde),
darf ihr Inhalt nicht mehr geändert werden. Korrekturen sind ausschließlich
über den Storno-Pfad zulässig (Abschnitt 2.3).

### 2.1 SQL-Trigger (DAT-2.a, Migration `0020`)

Datei: `src-tauri/migrations/0020/01_invoice_immutability.sql`

Zwei `BEFORE`-Trigger auf der Tabelle `invoices` setzen die Unveränderlichkeit
direkt in der Datenbank-Schicht durch:

- `invoices_immutable_update` — bricht jede `UPDATE`-Anweisung mit
  `RAISE(ABORT, 'invoice_immutable')` ab, wenn `OLD.status <> 'draft'` ist
  **und** sich mindestens eine Spalte ändert, die in der Trigger-Definition
  aufgeführt ist. Nicht geprüft werden ausschließlich `status`, `updated_at`
  und `s3_key` — diese drei Felder dürfen sich auch bei ausgestellten
  Rechnungen ändern (Statusübergang, Zeitstempel, Backup-Verweis).
- `invoices_immutable_delete` — bricht jede `DELETE`-Anweisung auf einer
  Zeile mit `OLD.status <> 'draft'` ab.

Die Spaltenliste des `UPDATE`-Triggers wird in Migration `0021` (DAT-2.b)
erweitert: dort werden zusätzlich `references_invoice_id` und
`cancellation_reason` aufgenommen, damit auch Storno-Metadaten nachträglich
nicht verändert werden können (siehe `src-tauri/migrations/0021/01_storno_columns.sql`,
Abschnitt 3 dieser Datei).

### 2.2 TypeScript-Vorprüfung (DAT-2.b)

Datei: `src/lib/db/invoices.ts`

Die Funktionen `updateInvoice` und `deleteInvoice` führen zusätzlich eine
Vorprüfung im Anwendungscode durch und werfen einen typisierten Fehler
mit `name = "InvoiceImmutable"`, bevor die Datenbank-Anweisung abgesetzt
wird. Damit erhält die Oberfläche eine klare Fehlerklasse statt eines
rohen SQL-Constraint-Fehlers; die Datenbank-Trigger aus Abschnitt 2.1
bleiben die letzte, autoritative Schicht.

### 2.3 Storno-Pfad (DAT-2.b)

Datei: `src/lib/db/invoices.ts` — Funktion `cancelInvoice(id, reason)`

Das Stornieren einer ausgestellten Rechnung erzeugt eine **neue** Rechnung
mit folgenden Eigenschaften:

- **Rechnungsnummer**: `<original.invoice_number>-storno-N`, wobei `N` bei 1
  beginnt und sich erhöht, falls bereits ein Storno für diese Rechnung
  existiert.
- **Status**: `issued` (die Stornorechnung selbst ist sofort und endgültig
  ausgestellt — sie unterliegt damit ebenfalls der Unveränderlichkeit aus
  Abschnitt 2.1).
- **Beträge** (`net_cents`, `tax_cents`, `gross_cents`, `due_surcharge`
  sowie die Legacy-`*_amount`-Spalten): vorzeichenmäßig **negiert**.
- **Rechnungspositionen**: aus dem Original gespiegelt, mit negierter
  `quantity` und negierten `line_total_net(_cents)`-Werten;
  `unit_price_net(_cents)` bleibt positiv, sodass die Invariante
  `line_total_net = quantity * unit_price_net` erhalten bleibt.
- **`references_invoice_id`**: zeigt auf die `id` der ursprünglichen
  Rechnung.
- **`cancellation_reason`**: enthält den von der betreibenden Person
  angegebenen Grund.

Die ursprüngliche Rechnung bleibt **bit-für-bit unverändert**. Der gesamte
Vorgang läuft in einer SQL-Transaktion (`withTransaction`); bei jedem
Fehler wird der Storno samt Positionen zurückgerollt.

Drafts können nicht storniert werden (sie sind buchhalterisch noch keine
Rechnung); für sie wirft `cancelInvoice` einen `InvoiceImmutable`-Fehler
mit der Empfehlung, stattdessen `deleteInvoice` zu verwenden.

### 2.4 Tests

Datei: `tests/db/invoices-immutability.test.ts` und
`tests/db/invoices-cancel.test.ts` (DAT-2.c) — verifizieren sowohl die
SQL-Trigger als auch den Storno-Pfad.

---

## 3. Audit-Trail (DAT-4)

### 3.1 Tabelle `invoice_audit` (DAT-4.a, Migration `0017`)

Datei: `src-tauri/migrations/0017/01_invoice_audit.sql`

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
```

Indizes: `invoice_audit_entity_idx` über `(entity_type, entity_id)` sowie
`invoice_audit_ts_idx` über `ts_unix_us`. Der Zeitstempel ist in
**Mikrosekunden seit Unix-Epoch (UTC)** angegeben.

Die Tabelle ist polymorph: `entity_type` ist eine der Werte `'invoices'`,
`'invoice_items'` oder `'payments'`. Bei `'invoice_items'` und `'payments'`
ist `entity_id` bewusst die übergeordnete `invoice_id` (nicht die Zeilen-ID
der Position bzw. Zahlung), damit die vollständige Historie einer Rechnung
mit einem einzigen Filter `entity_id = <id>` rekonstruiert werden kann.

### 3.2 Trigger (DAT-4.b, Migration `0019`)

Datei: `src-tauri/migrations/0019/01_invoice_audit_triggers.sql`

Drei `AFTER`-Trigger pro Tabelle (`*_audit_insert`, `*_audit_update`,
`*_audit_delete`) für jede der Tabellen `invoices`, `invoice_items`,
`payments` schreiben automatisch eine Zeile in `invoice_audit`:

| Operation | `before`               | `after`                | Welche Spalten erscheinen?       |
| --------- | ---------------------- | ---------------------- | -------------------------------- |
| `insert`  | `NULL`                 | `NEW.<col>`            | alle auditierten Spalten          |
| `update`  | `OLD.<col>`            | `NEW.<col>`            | nur Spalten mit echter Änderung  |
| `delete`  | `OLD.<col>`            | `NULL`                 | alle auditierten Spalten          |

Die Erkennung „Spalte hat sich geändert“ verwendet `OLD.x IS NOT NEW.x`
(SQL-Standard NULL-sichere Ungleichheit). Übergänge `NULL → NULL` zählen
korrekt als unverändert.

Das Feld `actor` wird auf SQL-Ebene noch nicht befüllt; die Anwendungsschicht
soll dies in einem Folgeschritt nachreichen (Anmerkung im SQL-Kommentar von
Migration `0019`).

### 3.3 Format des `fields_diff`-JSON

Beispiel: Eine ausgehende Rechnung im Status `draft` wird in `net_cents`
von `100000` auf `120000` aktualisiert. Der `AFTER UPDATE`-Trigger erzeugt
folgenden Audit-Eintrag (Beispielwerte):

```json
{
  "id": 42,
  "entity_type": "invoices",
  "entity_id": 7,
  "op": "update",
  "actor": null,
  "ts_unix_us": 1715342400000123,
  "fields_diff": {
    "net_cents": { "before": 100000, "after": 120000 }
  }
}
```

Bei einem `INSERT` enthält `fields_diff` einen Eintrag pro auditierter Spalte,
jeweils mit `"before": null` und dem eingefügten Wert in `"after"`. Bei
einem `DELETE` umgekehrt: alle Spalten mit `"before": <alt>` und
`"after": null`.

Verifiziert wird das Trigger-Verhalten durch den Integrationstest in
`src-tauri/tests/invoice_audit_diff.rs` (DAT-4.c, PR #178).

### 3.4 Destruktive Operationen auf dem Audit-Log selbst

Datei: `src/lib/db/audit.ts` — Funktion `deleteAuditRow(id)`

Das Audit-Log wird im Normalbetrieb ausschließlich von den SQL-Triggern
geschrieben; die Oberfläche bietet keinerlei Einstiegspunkt zum Löschen
einzelner Audit-Zeilen. Für etwaige spätere Wartungswerkzeuge existiert
`deleteAuditRow`, das die Aufbewahrungssperre aus Abschnitt 4 anwendet:
Audit-Zeilen, deren Zeitpunkt (`ts_unix_us`) noch innerhalb der
10-Jahres-Frist liegt, können nicht gelöscht werden.

---

## 4. Aufbewahrungssperre (COMP-1.a)

Datei: `src/lib/db/retention.ts`

### 4.1 Funktionsweise

Zwei exportierte Funktionen kapseln die §147 AO-Frist:

- `isWithinRetention(countryCode, createdAt, now?)` — `true`, wenn der Zeitpunkt
  `createdAt` noch innerhalb der durch das Rechtsprofil vorgegebenen
  `retentionYears` liegt.
- `assertOutsideRetention(entityLabel, countryCode, createdAt, now?)` — wirft
  einen typisierten `Error` mit `name = "RetentionViolation"` und
  deutschsprachiger Meldung, wenn die Aufbewahrungssperre noch greift; sonst
  No-Op.

Als Jahresumrechnung wird `365.25 Tage/Jahr` verwendet, damit Schaltjahre
über das volle 10-Jahres-Fenster hinweg korrekt absorbiert werden. Bei nicht
parsbarem Zeitstempel oder unbekanntem Ländercode fällt die Funktion bewusst
auf „noch innerhalb der Frist“ zurück (Fail-closed-Verhalten).

### 4.2 Aufrufstellen

| Aufrufer                            | Datei                          | Wirkung                                                                 |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `deleteInvoice(id)`                 | `src/lib/db/invoices.ts`       | Löschen einer (Draft-)Rechnung wird abgelehnt, solange Aufbewahrungsfrist läuft. |
| `deletePayment(id)`                 | `src/lib/db/payments.ts`       | Löschen eines Zahlungseingangs wird abgelehnt.                           |
| `deleteAuditRow(id)`                | `src/lib/db/audit.ts`          | Löschen einer Audit-Zeile wird abgelehnt.                                |
| `anonymizeCustomer(id)`             | `src/lib/db/dsgvo_erasure.ts`  | DSGVO-Löschantrag (Art. 17) wird verweigert, wenn der Kunde noch eine Rechnung innerhalb der Frist hat. Die Verweigerung wird zusätzlich als Audit-Zeile festgehalten. |

Ausgestellte (`status <> 'draft'`) Rechnungen können ohnehin nicht gelöscht
werden — dort greift bereits die Unveränderlichkeit aus Abschnitt 2. Die
Aufbewahrungssperre fängt insbesondere alte **Drafts** sowie Zahlungen und
DSGVO-Löschanträge ab.

### 4.3 Fehlerklasse

Der TypeScript-`Error` trägt `name === "RetentionViolation"`. Die
Oberfläche unterscheidet anhand dieses Diskriminators zwischen
„Rechnung darf nicht geändert werden“ (`InvoiceImmutable`) und „Rechnung
darf wegen Aufbewahrungsfrist nicht gelöscht werden“ (`RetentionViolation`).

---

## 5. Datenexport für die Betriebsprüfung (COMP-1.b)

Datei: `src-tauri/src/gobd.rs` (Erzeugung) und `src-tauri/src/lib.rs`
(Tauri-Befehl `export_gobd`).

### 5.1 Aufruf durch die betreibende Person

Oberfläche: **Einstellungen → Backup & Wiederherstellung → GoBD-Export**

Die betreibende Person wählt ein Geschäftsjahresfenster (`from_year`,
`to_year`, beide ganzzahlig, inklusiv) und löst den Export aus. Die App ruft
intern den Tauri-Befehl `export_gobd` auf, der eine ZIP-Datei erzeugt und
zum Download anbietet.

Die UI-Bindung ist in `src/routes/einstellungen/backup/+page.svelte`
(Funktion `handleGobdExport`) implementiert.

### 5.2 Inhalt des ZIP-Archivs

Das Archiv heißt `gobd-export-<from>-<to>.zip` und enthält:

```text
gobd-export-<from>-<to>.zip
├── companies.csv          # vollständig (kein Jahres-Filter)
├── customers.csv          # vollständig
├── invoice_audit.csv      # vollständig — der Änderungsverlauf wird
│                          #   gemäß GoBD vollständig ausgegeben
├── invoices.csv           # gefiltert: issue_date ∈ [from-01-01, to-12-31]
├── invoice_items.csv      # transitiv über invoices.id gefiltert
├── payments.csv           # transitiv über invoices.id gefiltert
├── schema_version.txt     # PRAGMA user_version + Spaltenliste je Tabelle
├── manifest.json          # SHA-256 + Bytegröße je Datei
└── export_signature.txt   # SHA-256 der manifest.json (Hex, klein)
```

Das CSV-Format folgt RFC 4180 (`\r\n`-Zeilenenden, Quoting bei Kommas,
doppelten Anführungszeichen oder Zeilenumbrüchen; `NULL` als leeres Feld).
Die Spaltenreihenfolge folgt der Reihenfolge aus `PRAGMA table_info`. Blobs
werden hexcodiert ausgegeben.

Der Datenbankzugriff erfolgt **read-only** (`SQLITE_OPEN_READ_ONLY`), damit
während des Exports keine Schreibkonflikte mit der laufenden Anwendung
auftreten.

### 5.3 Manifest und Signatur

Die `manifest.json` enthält pro Datei einen Eintrag mit Pfad, SHA-256-Hex
und Bytegröße, dazu Format-Version, Erzeugungszeitpunkt (RFC 3339, UTC) und
das verwendete Jahresfenster. Beispiel (gekürzt):

```json
{
  "format_version": 1,
  "generated_at": "2026-05-10T09:15:42Z",
  "year_range": { "from": 2024, "to": 2024 },
  "files": [
    {
      "path": "companies.csv",
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "bytes": 412
    },
    {
      "path": "invoices.csv",
      "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "bytes": 8231
    },
    {
      "path": "invoice_audit.csv",
      "sha256": "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
      "bytes": 184772
    }
  ]
}
```

> Die SHA-256-Werte oben sind illustrativ; sie werden zur Laufzeit aus dem
> tatsächlichen Inhalt der jeweiligen Datei berechnet (`sha2`-Crate).

Die Datei `export_signature.txt` enthält genau **eine Zeile**: den
SHA-256-Hex-Wert der Bytes von `manifest.json`. Damit kann ein Prüfer das
Archiv zweistufig auf Manipulationsfreiheit prüfen:

1. Hash jeder einzelnen CSV/Text-Datei berechnen und mit dem Eintrag in
   `manifest.json` vergleichen.
2. Hash der `manifest.json` berechnen und mit `export_signature.txt`
   vergleichen.

### 5.4 Filterregeln

Der Jahresfilter ist beidseitig inklusiv und greift auf
`invoices.issue_date` (TEXT, Format `YYYY-MM-DD`); `invoice_items` und
`payments` werden transitiv über `invoice_id` gefiltert, sodass das Archiv
in sich konsistent ist (keine verwaisten Positionen oder Zahlungen).
`companies`, `customers` und `invoice_audit` werden vollständig
ausgegeben — der Audit-Trail muss laut GoBD ungekürzt bleiben.

---

## 6. Operator-Workflow für eine Betriebsprüfung

| Schritt | Wer    | Aktion                                                                                        |
| ------- | ------ | --------------------------------------------------------------------------------------------- |
| 1       | Operator | Vollbackup der Datenbank über **Einstellungen → Backup & Wiederherstellung → Datenbank herunterladen** erzeugen (Sicherungskopie).                       |
| 2       | Operator | GoBD-Export für den geprüften Zeitraum auslösen (Abschnitt 5.1) und das ZIP übergeben.        |
| 3       | Prüfer | `export_signature.txt` und `manifest.json` zur Integritätskontrolle nutzen (Abschnitt 5.3). |
| 4       | Prüfer | CSV-Dateien in das Auswertungswerkzeug seiner Wahl einlesen.                                  |
| 5       | Operator | Eingangsbelege (`incoming_invoices`-PDFs) gemäß `docs/operations.md` Abschnitt 4 separat bereitstellen, falls vom Prüfer angefordert. |

Eingangsrechnungs-PDFs sind nicht Bestandteil des GoBD-ZIPs; ihre
Metadaten stehen in der Datenbank, die Originaldateien liegen je nach
Konfiguration im S3-Bucket unter dem Präfix `eingehende-rechnungen/` oder
in einem lokalen Ordner. Das Vorgehen ist im Betriebshandbuch
(`docs/operations.md`, Abschnitt 4) beschrieben.

---

## 7. Verweisliste Code → Garantie

| Garantie                                          | Datei / Migration                                                |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Tabelle `invoice_audit`                           | `src-tauri/migrations/0017/01_invoice_audit.sql`                 |
| Audit-Trigger (INSERT/UPDATE/DELETE)              | `src-tauri/migrations/0019/01_invoice_audit_triggers.sql`        |
| Unveränderlichkeit (UPDATE/DELETE auf `invoices`) | `src-tauri/migrations/0020/01_invoice_immutability.sql`          |
| Storno-Spalten + Trigger-Erweiterung              | `src-tauri/migrations/0021/01_storno_columns.sql`                |
| TS-Vorprüfung & Storno-Logik                      | `src/lib/db/invoices.ts` (`updateInvoice`, `deleteInvoice`, `cancelInvoice`) |
| Aufbewahrungs-Helfer                              | `src/lib/db/retention.ts`                                        |
| Zahlung löschen mit Aufbewahrungssperre           | `src/lib/db/payments.ts` (`deletePayment`)                       |
| Audit-Zeile löschen mit Aufbewahrungssperre       | `src/lib/db/audit.ts` (`deleteAuditRow`)                         |
| DSGVO-Löschung mit Aufbewahrungs-Vorbehalt        | `src/lib/db/dsgvo_erasure.ts` (`anonymizeCustomer`)              |
| GoBD-Export ZIP                                   | `src-tauri/src/gobd.rs`                                          |
| Tauri-Befehl `export_gobd`                        | `src-tauri/src/lib.rs`                                           |
| UI-Auslöser GoBD-Export                           | `src/routes/einstellungen/backup/+page.svelte` (`handleGobdExport`) |
| Aufbewahrungsfristen je Land                      | `src/lib/legal/profiles/<de|at|ch|fr|nl|us>.ts` (`retentionYears`) |
| Audit-Trigger Integrationstest                    | `src-tauri/tests/invoice_audit_diff.rs`                          |
| Unveränderlichkeits-/Storno-Tests                 | `tests/db/invoices-immutability.test.ts`, `tests/db/invoices-cancel.test.ts` |
| Aufbewahrungs-Tests                               | `tests/db/retention.test.ts`                                     |
