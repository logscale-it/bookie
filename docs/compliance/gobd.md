# Bookie — GoBD-Konformität

> **Status:** Entwurf (`human`-Tier-Aufgabe COMP-1.c). Dieses Dokument
> beschreibt, wie Bookie die GoBD-Anforderungen technisch umsetzt. Es ersetzt
> keine steuerliche Beratung. Die im Folgenden zugesicherten Garantien
> beziehen sich auf den Code-Stand der Migrationen `0017`, `0019`, `0020`,
> `0021` sowie auf die Module `src/lib/db/retention.ts`, `src/lib/db/audit.ts`,
> `src/lib/db/invoices.ts`, `src/lib/db/payments.ts` und `src-tauri/src/gobd.rs`.

Die GoBD (BMF, **Grundsätze ordnungsmäßiger Buchführung**) verlangen für
jeden buchungsrelevanten Datensatz vier Eigenschaften:

1. **Unveränderbarkeit** — einmal festgeschriebene Buchungen dürfen nicht
   stillschweigend überschrieben werden (§ 146 Abs. 4 AO).
2. **Vollständigkeit und Nachvollziehbarkeit** — jede Änderung muss
   protokolliert sein (§ 145 AO).
3. **Aufbewahrung** — Bücher, Aufzeichnungen, Rechnungen und Belege sind
   zehn Jahre aufzubewahren (§ 147 Abs. 3 AO).
4. **Maschinelle Auswertbarkeit** — der Datenbestand muss der Finanzverwaltung
   in einem Format zur Verfügung gestellt werden, das sie auswerten kann
   (§ 147 Abs. 6 AO).

Die folgenden Abschnitte beschreiben pro Anforderung, welcher Code in Bookie
sie konkret umsetzt, welche Tabellen betroffen sind, und wie ein
Steuerberater oder Betriebsprüfer die Umsetzung überprüfen kann.

---

## 1. Geltungsbereich

Bookie behandelt die folgenden SQLite-Tabellen als buchungsrelevant:

| Tabelle              | Zweck                                                            | Unveränderbarkeit (DAT-2) | Audit-Trail (DAT-4) | Aufbewahrungs-Guard (COMP-1.a) | Im GoBD-Export (COMP-1.b) |
| -------------------- | ---------------------------------------------------------------- | :-----------------------: | :-----------------: | :----------------------------: | :-----------------------: |
| `invoices`           | Ausgangsrechnungen (inkl. Storno-Zeilen)                         |          **ja**           |       **ja**        |            **ja**              |          **ja**           |
| `invoice_items`      | Positionen einer Ausgangsrechnung                                |        siehe Hinweis      |       **ja**        |          via `invoices`        |          **ja**           |
| `payments`           | Eingehende Zahlungen zu einer Ausgangsrechnung                   |             —             |       **ja**        |            **ja**              |          **ja**           |
| `invoice_audit`      | Änderungsprotokoll (DAT-4)                                       |         append-only       |          —          |            **ja**              |          **ja**           |
| `companies`          | Stammdaten des eigenen Unternehmens                              |             —             |          —          |               —                |     **ja** (vollständig)  |
| `customers`          | Kundenstammdaten                                                 |             —             |          —          |               —                |     **ja** (vollständig)  |
| `incoming_invoices`  | Eingangsrechnungen (Belege)                                      |             —             |          —          |     **noch nicht** (Lücke)     |       **noch nicht**      |

**Hinweis zu `invoice_items`:** Die Unveränderbarkeit wird **indirekt**
erzwungen. Es gibt keinen eigenen Trigger auf `invoice_items`; stattdessen
verhindert die Anwendungs- und Trigger-Logik auf der Eltern-`invoices`-Zeile
(siehe Abschnitt 2), dass eine festgeschriebene Rechnung erneut in den
Bearbeitungsmodus gesetzt werden kann, in dem Positionen geändert würden.
Direkte SQL-Schreibzugriffe auf `invoice_items` einer festgeschriebenen
Rechnung wären auf SQL-Ebene **nicht** geblockt — der Audit-Trail würde sie
aber lückenlos protokollieren.

**Bekannte Lücken (für die Steuerberaterprüfung):**

- `incoming_invoices` (Eingangsrechnungen) sind heute weder vom
  Aufbewahrungs-Guard erfasst (`deleteIncomingInvoice` löscht ungeprüft) noch
  Bestandteil des GoBD-Export-Archivs. Eingangsrechnungen sind aber nach
  § 147 AO ebenfalls 10 Jahre aufzubewahren. Diese Lücke ist offen und im
  Refinement-Plan erfasst.
- `invoice_items` und `payments` haben keinen eigenen
  Unveränderbarkeits-Trigger. Änderungen an diesen Tabellen werden zwar im
  `invoice_audit` festgehalten (so dass nichts unbemerkt verschwindet), eine
  Hard-Sperre auf SQL-Ebene besteht aber nur über den Eltern-Datensatz.

---

## 2. Unveränderbarkeit (DAT-2)

### Was gilt als „unveränderbar"?

Eine Ausgangsrechnung gilt ab dem Statuswechsel `draft → issued` als
festgeschrieben. Ab diesem Zeitpunkt darf der Datensatz inhaltlich nicht
mehr verändert werden. Erlaubt bleiben lediglich:

- Statusübergänge (`issued → sent → paid`), damit der Lebenszyklus der
  Rechnung weiter abgebildet werden kann;
- die rein technischen Felder `updated_at` (Zeitstempel) und `s3_key`
  (S3-Backup-Referenz).

Jede inhaltliche Änderung an einer festgeschriebenen Rechnung wird auf
SQL-Ebene mit dem Fehler `invoice_immutable` abgewiesen. Ebenso wird ein
`DELETE` auf eine festgeschriebene Rechnung abgewiesen.

### Wie wird das technisch durchgesetzt?

Zwei SQLite-Trigger in Migration `0020` (Update-Trigger zusätzlich erweitert
in Migration `0021`):

```sql
-- BEFORE UPDATE: bricht ab, wenn der Status nicht 'draft' ist und
-- mindestens eine inhaltliche Spalte verändert würde.
CREATE TRIGGER invoices_immutable_update
BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND (
       NEW.invoice_number          IS NOT OLD.invoice_number
    OR NEW.issue_date              IS NOT OLD.issue_date
    OR NEW.gross_cents             IS NOT OLD.gross_cents
    -- ... vollständige Spaltenliste in 0020/01 + 0021/01
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;

-- BEFORE DELETE: bricht jedes DELETE auf einer nicht-Entwurfs-Rechnung ab.
CREATE TRIGGER invoices_immutable_delete
BEFORE DELETE ON invoices
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'invoice_immutable');
END;
```

Zusätzlich prüft die Anwendungsschicht (`src/lib/db/invoices.ts`,
`deleteInvoice`) den Status **vor** dem `DELETE` und liefert eine
deutschsprachige Fehlermeldung an die UI, statt nur den nackten
SQL-Fehler durchzureichen. Die SQL-Trigger sind die letzte Verteidigungslinie
für den Fall, dass ein Datenbanktool den UI-Pfad umgeht.

### Korrekturen via Storno (DAT-2.b)

Eine inhaltlich falsche, bereits festgeschriebene Rechnung wird **nicht**
korrigiert, sondern **storniert**. Die Funktion `cancelInvoice(id, reason)`
in `src/lib/db/invoices.ts` legt dafür innerhalb einer SQL-Transaktion eine
spiegelnde Rechnung an:

- `invoice_number` = `<originale Nummer>-storno-N` (Suffix beginnt bei 1).
- Alle Geldbeträge (`net_*`, `tax_*`, `gross_*`, `due_surcharge`) sowie die
  Positionen (`quantity`, `line_total_net*`) werden negiert. Der
  `unit_price_net` einer Position bleibt positiv, damit die Invariante
  `line_total = quantity × unit_price` für die Storno-Zeile weiter gilt.
- Die neue Zeile setzt `references_invoice_id = original.id` und speichert
  den vom Bediener angegebenen Grund in `cancellation_reason`.
- Die Storno-Rechnung wird selbst sofort mit `status = 'issued'` angelegt
  und ist damit ihrerseits ab diesem Augenblick unveränderbar. Der
  Statuswechsel `NULL → 'issued'` wird in `invoice_status_history`
  festgehalten.
- Entwürfe (`status = 'draft'`) lassen sich nicht stornieren; der Aufruf
  liefert `invoice_immutable` mit der Empfehlung, den Entwurf zu **löschen**
  statt zu stornieren.

Der Originaldatensatz bleibt dabei bit-genau unverändert. Die spätere
Buchhaltungsdarstellung ergibt sich aus der Summe aus Original- und
Storno-Zeile.

### Verifikation für die Steuerberaterprüfung

- Die Trigger-Definitionen befinden sich vollständig in
  `src-tauri/migrations/0020/01_invoice_immutability.sql` und in der
  erweiterten Fassung in `src-tauri/migrations/0021/01_storno_columns.sql`.
  Die Spaltenliste deckt alle inhaltlichen Felder der Tabelle `invoices`
  zum Zeitpunkt von Migration `0021` ab.
- Tests, die die Trigger in beide Richtungen prüfen (Mutation wird
  abgewiesen, Storno bleibt möglich), liegen unter
  `tests/db/invoices-immutability.test.ts` und
  `tests/db/invoices-cancel.test.ts`.

---

## 3. Nachvollziehbarkeit (DAT-4)

### Tabelle `invoice_audit`

Jede Mutation auf den Tabellen `invoices`, `invoice_items` und `payments`
schreibt eine Zeile in `invoice_audit`. Das Schema (Migration `0017`):

| Spalte         | Typ       | Bedeutung                                                                                 |
| -------------- | --------- | ----------------------------------------------------------------------------------------- |
| `id`           | INTEGER   | Primärschlüssel (autoincrement)                                                           |
| `entity_type`  | TEXT      | `'invoices'`, `'invoice_items'` oder `'payments'`                                         |
| `entity_id`    | INTEGER   | Bei `'invoices'` die Rechnungs-ID; bei den Kindtabellen die ID der **Eltern-Rechnung**    |
| `op`           | TEXT      | `'insert'`, `'update'` oder `'delete'`                                                    |
| `actor`        | TEXT      | Reserviert für eine spätere Anwendungsschicht; aktuell stets `NULL` (Trigger setzen ihn nicht) |
| `ts_unix_us`   | INTEGER   | Zeitstempel in Mikrosekunden seit Unix-Epoche (UTC)                                       |
| `fields_diff`  | TEXT/JSON | JSON-Objekt `{spalte: {before, after}}` — siehe unten                                     |

Indizes sind auf `(entity_type, entity_id)` und auf `ts_unix_us` angelegt,
damit ein Prüfer die komplette Historie einer Rechnung in O(log n) lesen
kann.

### Format von `fields_diff`

Die Trigger in Migration `0019` schreiben `fields_diff` nach einem festen
Schema:

- **INSERT:** Für jede in der Tabelle definierte Spalte ein Eintrag der Form
  `{"spalte": {"before": null, "after": <NEU>}}`.
- **DELETE:** Für jede Spalte ein Eintrag der Form
  `{"spalte": {"before": <ALT>, "after": null}}`.
- **UPDATE:** Nur die Spalten, deren Wert sich tatsächlich geändert hat,
  erscheinen — jede mit `{"before": <ALT>, "after": <NEU>}`. Unveränderte
  Spalten werden weggelassen.

Beispiel — eine Statusänderung `issued → paid` auf der Rechnung mit `id=42`
würde diese Audit-Zeile erzeugen:

```json
{
  "entity_type": "invoices",
  "entity_id": 42,
  "op": "update",
  "ts_unix_us": 1717200001234567,
  "fields_diff": {
    "status":     { "before": "issued", "after": "paid" },
    "updated_at": { "before": "2024-06-01 10:00:00", "after": "2024-06-01 10:05:01" }
  }
}
```

### Wie ein Prüfer die Historie einer Rechnung liest

Die komplette Geschichte einer Rechnung — inklusive ihrer Positionen und
aller eingegangenen Zahlungen — lässt sich mit einem einzigen `SELECT`
rekonstruieren, weil die Kindtabellen-Trigger als `entity_id` die
**Eltern-Rechnungs-ID** schreiben:

```sql
SELECT ts_unix_us, entity_type, op, fields_diff
FROM invoice_audit
WHERE entity_id = 42
  AND entity_type IN ('invoices', 'invoice_items', 'payments')
ORDER BY ts_unix_us;
```

### Bekannte Einschränkungen

- Das Feld `actor` wird von den SQL-Triggern nicht gesetzt. Bookie ist eine
  lokale Single-User-Desktop-Anwendung; ein Mehrbenutzer-Audit ist konzeptionell
  vorbereitet (Spalte vorhanden, Index nicht erforderlich), wird aber erst
  mit einer späteren Anwendungs-Hook gefüllt.
- Die Storno-spezifischen Spalten `references_invoice_id` und
  `cancellation_reason` werden nicht in den `UPDATE`-Triggern aufgeführt.
  Da `cancelInvoice` diese beiden Felder bereits beim `INSERT` der
  Storno-Zeile setzt und die Zeile danach unveränderbar ist, sind sie aus
  dem `INSERT`-Audit-Eintrag rekonstruierbar (siehe Migration `0021/01`,
  Kommentar oben).

---

## 4. Aufbewahrung (COMP-1.a)

### 10-Jahres-Frist nach § 147 AO

Buchungsrelevante Datensätze sind in Deutschland zehn Jahre lang
aufzubewahren. Die Frist beginnt mit dem Ende des Kalenderjahres, in dem der
Datensatz angelegt wurde. Bookie verwendet als konservative Annäherung das
`created_at`-Datum des einzelnen Datensatzes plus 10 × 365,25 Tage. Damit
ist die effektive App-Frist **strenger** als die gesetzliche Mindestfrist
(es wird einige Monate länger geschützt) — das ist mit § 147 vereinbar.

### Was wird vor dem Löschen geprüft?

Die Funktion `assertOutsideRetention(...)` in `src/lib/db/retention.ts` ist
ein zentraler Guard, durch den jede destruktive Anwendungs-Operation auf
einem buchungsrelevanten Datensatz läuft. Aktuell aufgerufen von:

| Operation                                 | Aufrufende Funktion              |
| ----------------------------------------- | -------------------------------- |
| Rechnung löschen                          | `deleteInvoice` (`src/lib/db/invoices.ts`) |
| Zahlung löschen                           | `deletePayment` (`src/lib/db/payments.ts`) |
| Audit-Eintrag löschen                     | `deleteAuditRow` (`src/lib/db/audit.ts`)   |

Logik des Guards:

1. Land über `legal_country_code` der Rechnung ermitteln (Fallback `'DE'`,
   die strengste der ausgelieferten Profile).
2. Aus dem Profil das `retentionYears`-Feld lesen. Für **alle** in Bookie
   ausgelieferten Länder (DE, AT, CH, FR, NL, US) ist dieser Wert
   einheitlich `10`.
3. Wenn `(jetzt − created_at) < retentionYears × 365,25 Tage`, wird ein
   `RetentionViolation`-Fehler mit deutscher Meldung geworfen
   (z. B. *„Rechnung darf nicht gelöscht werden — gesetzliche
   Aufbewahrungsfrist von 10 Jahren ist noch nicht abgelaufen"*).
4. Bei einem unlesbaren `created_at` schlägt der Guard zur sicheren Seite
   um: Löschung wird abgewiesen.

### Welche destruktiven Operationen sind gesperrt?

Innerhalb der 10-Jahres-Frist können nicht gelöscht werden:

- ausgegebene Rechnungen (auch der zusätzliche `InvoiceImmutable`-Guard
  greift hier);
- alte Entwurfsrechnungen, die nie ausgestellt wurden;
- Zahlungen;
- Audit-Einträge (zusätzlich gilt die DAT-4-Konvention, dass `invoice_audit`
  append-only ist und die UI keine Löschfunktion anbietet).

Auf SQL-Ebene gibt es **keinen** zusätzlichen Trigger, der einen rohen
`DELETE` blocken würde — die Aufbewahrungsfrist wird ausschließlich in der
Anwendungsschicht durchgesetzt. Direkt auf die SQLite-Datei zugreifende
Tools (`sqlite3 bookie.db DELETE FROM ...`) würden die Frist umgehen.

### Bekannte Lücke

`deleteIncomingInvoice` (`src/lib/db/incoming-invoices.ts`) ruft den Guard
**heute nicht** auf. Eingangsrechnungen sind aber nach § 147 AO ebenso
zehn Jahre aufzubewahren. Diese Lücke ist im Refinement-Plan erfasst und
sollte vor dem produktiven Einsatz geschlossen werden.

---

## 5. Export für die Betriebsprüfung (COMP-1.b)

### Wann brauche ich diesen Export?

Im Rahmen einer Betriebsprüfung verlangt das Finanzamt typischerweise einen
Datenträgerexport („Z3-Zugriff" der GDPdU/GoBD). Bookie liefert dafür ein
ZIP-Archiv mit allen buchungsrelevanten Tabellen als CSV plus einer
Manifest-Datei mit Hash-Werten zur Integritätsprüfung.

### Wie wird der Export erzeugt?

In der App: **Einstellungen → Backup & Wiederherstellung → GoBD-Export**.
Der Bediener wählt ein Wirtschaftsjahr (oder einen Bereich aus mehreren
Jahren) und lädt das ZIP herunter.

Programmatisch ist es der Tauri-Befehl `export_gobd(from_year, to_year)` in
`src-tauri/src/lib.rs` (Implementierung in `src-tauri/src/gobd.rs`). Der
Befehl öffnet die Datenbank **read-only** (kein Konflikt mit dem laufenden
Schreib-Pool) und erzeugt das Archiv im Speicher.

### Aufbau des Archivs

Dateiname: `gobd-export-<von>-<bis>.zip`. Inhalt:

```
gobd-export-2024-2025.zip
├── companies.csv          # alle Spalten, alle Zeilen (vollständig)
├── customers.csv          # alle Spalten, alle Zeilen (vollständig)
├── invoices.csv           # gefiltert auf issue_date BETWEEN 2024-01-01 AND 2025-12-31
├── invoice_items.csv      # transitiv über invoice_id auf den o. g. Bereich gefiltert
├── payments.csv           # transitiv über invoice_id auf den o. g. Bereich gefiltert
├── invoice_audit.csv      # vollständig — der Änderungsverlauf wird ungefiltert exportiert
├── schema_version.txt     # PRAGMA user_version + Spaltenliste je Tabelle
├── manifest.json          # {format_version, generated_at, year_range, files: [{path, sha256, bytes}]}
└── export_signature.txt   # Lowercase-Hex-SHA-256 von manifest.json
```

Eigenschaften der CSV-Dateien:

- Trennzeichen `,`; Zeilenende `\r\n` (RFC 4180).
- Erste Zeile ist die Spaltenüberschrift in `PRAGMA table_info`-Reihenfolge.
- Felder mit `,`, `"`, `\n` oder `\r` werden in `"…"` eingeschlossen,
  innenliegende `"` werden verdoppelt.
- `NULL` wird als leere Zelle dargestellt.
- BLOBs werden hexadezimal kodiert.

### Integritätssicherung

- `manifest.json` enthält für jede Datei im Archiv den SHA-256 und die
  Bytegröße.
- `export_signature.txt` enthält den SHA-256 von `manifest.json` selbst.
- Verifizieren des Archivs durch den Prüfer: SHA-256 jeder Datei berechnen
  und mit dem Manifest abgleichen, dann SHA-256 des Manifests berechnen
  und mit `export_signature.txt` abgleichen. Stimmen alle Werte, ist das
  Archiv unverändert.

### Worked Example — eine Rechnung im Export

Annahme: In der Datenbank existiert die folgende Rechnung mit einer Position
und einer Zahlung; sie wurde 2024 ausgestellt und 2024 bezahlt.

**`invoices`-Zeile (auszugsweise):**

| id | invoice_number | issue_date  | status | gross_cents | customer_id |
| -- | -------------- | ----------- | ------ | ----------- | ----------- |
| 1  | R-2024-001     | 2024-06-01  | paid   | 11900       | 1           |

**`invoice_items`-Zeile:**

| id | invoice_id | description     | quantity | unit_price_net_cents | line_total_net_cents |
| -- | ---------- | --------------- | -------- | -------------------- | -------------------- |
| 1  | 1          | Beratung 2024   | 1.0      | 10000                | 10000                |

**`payments`-Zeile:**

| id | invoice_id | payment_date | amount_cents |
| -- | ---------- | ------------ | ------------ |
| 1  | 1          | 2024-07-01   | 11900        |

**`invoice_audit`-Zeilen** (gekürzt — `fields_diff` ist tatsächlich JSON):

| id | entity_type     | entity_id | op     | ts_unix_us         | fields_diff (Auszug)                               |
| -- | --------------- | --------- | ------ | ------------------ | -------------------------------------------------- |
| 1  | `invoices`      | 1         | insert | 1717200000000000   | `{ "invoice_number": {"before":null,"after":"R-2024-001"}, ... }` |
| 2  | `invoice_items` | 1         | insert | 1717200000200000   | `{ "description": {"before":null,"after":"Beratung 2024"}, ... }` |
| 3  | `invoices`      | 1         | update | 1717200001234567   | `{ "status": {"before":"draft","after":"issued"} }`               |
| 4  | `payments`      | 1         | insert | 1719820800000000   | `{ "payment_date": {"before":null,"after":"2024-07-01"}, ... }`   |
| 5  | `invoices`      | 1         | update | 1719820800500000   | `{ "status": {"before":"issued","after":"paid"} }`                |

Aufruf:

```text
GoBD-Export für 2024 → gobd-export-2024-2024.zip
```

Im Archiv finden sich genau diese Zeilen wieder:

`invoices.csv` (Header + Zeile zur Rechnung 1, alle Spalten in
PRAGMA-Reihenfolge):

```csv
id,company_id,customer_id,project_id,invoice_number,status,issue_date,due_date,...
1,1,1,,R-2024-001,paid,2024-06-01,2024-07-01,...
```

`invoice_items.csv` enthält die Position. `payments.csv` enthält die
Zahlung. `invoice_audit.csv` enthält **alle** Audit-Zeilen (das Audit-Log
wird grundsätzlich ungefiltert exportiert), darunter auch obige fünf.

`manifest.json` (gekürzt, tatsächlich pretty-printed):

```json
{
  "format_version": 1,
  "generated_at": "2025-05-10T08:00:00Z",
  "year_range": { "from": 2024, "to": 2024 },
  "files": [
    { "path": "companies.csv",      "sha256": "…", "bytes":  124 },
    { "path": "customers.csv",      "sha256": "…", "bytes":  256 },
    { "path": "invoice_audit.csv",  "sha256": "…", "bytes": 1024 },
    { "path": "invoices.csv",       "sha256": "…", "bytes":  512 },
    { "path": "invoice_items.csv",  "sha256": "…", "bytes":  256 },
    { "path": "payments.csv",       "sha256": "…", "bytes":  128 },
    { "path": "schema_version.txt", "sha256": "…", "bytes":  640 }
  ]
}
```

`export_signature.txt`:

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

(Im Beispiel ein Platzhalter — der echte Wert ist der lowercase-hex
SHA-256 der oben gezeigten `manifest.json`-Bytes.)

### Bekannte Einschränkung

`incoming_invoices` (Eingangsrechnungen) sind im Export-Archiv heute **nicht
enthalten**. Wenn das Finanzamt diese Belege im Z3-Zugriff anfordert, müssen
sie aktuell separat aus dem `<appdata>/incoming_invoices/`-Ordner bereit­
gestellt werden. Diese Lücke ist im Refinement-Plan erfasst.

---

## 6. Bedienerhinweise

### Wo liegen die Daten und Backups?

Die genauen Pfade je Betriebssystem stehen im Betriebshandbuch
([`docs/operations.md`](../operations.md), Abschnitt 1). Die SQLite-Datei
`bookie.db` ist die alleinige Quelle der Wahrheit; ein verschlüsseltes Backup
(lokale Datei oder S3) sollte zusätzlich vorgehalten werden.

### Eine Rechnung muss korrigiert werden — was tun?

1. Auf **Rechnungen → die betreffende Rechnung öffnen**.
2. Die Schaltfläche **Stornieren** öffnet einen Dialog für den Storno-Grund.
3. Nach Bestätigung wird automatisch eine Storno-Rechnung mit negierten
   Beträgen angelegt; die Originalrechnung bleibt unverändert.
4. Anschließend kann eine **neue, korrekte Rechnung** als Entwurf erstellt
   und ausgestellt werden. Die zusammenhängende Buchungswirkung ergibt sich
   aus Original + Storno + Neuausstellung.

Eine bereits ausgestellte Rechnung kann **nicht** gelöscht oder direkt
bearbeitet werden — das ist GoBD-konform und gewollt.

### Ein Betriebsprüfer fragt nach einem Datenträgerexport

1. **Einstellungen → Backup & Wiederherstellung → GoBD-Export**.
2. Wirtschaftsjahr (oder Bereich aus mehreren Jahren) auswählen.
3. **Export herunterladen** klickt das Archiv `gobd-export-<von>-<bis>.zip`
   in den Downloads-Ordner.
4. Das Archiv kann dem Prüfer auf einem Datenträger oder über einen
   sicheren Kanal übergeben werden. Es enthält eine Signaturdatei
   (`export_signature.txt`), mit der die Integrität verifizierbar ist.

Der Export ist nicht-destruktiv und beeinflusst die laufende Buchführung
nicht. Er kann beliebig oft wiederholt werden.

### Ein Datensatz lässt sich nicht löschen — was bedeutet die Meldung?

| Meldung                              | Bedeutung                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `invoice_immutable`                  | Eine festgeschriebene Rechnung soll geändert oder gelöscht werden — bitte stornieren. |
| `RetentionViolation` (deutscher Text) | Die 10-Jahres-Aufbewahrungsfrist ist noch nicht abgelaufen — Löschung verweigert. |

Beide Meldungen sind beabsichtigte GoBD-Schutzmechanismen und kein Fehler.

---

## 7. Referenz auf die Implementierung

| Garantie                       | Datei(en) auf `master`                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Unveränderbarkeits-Trigger     | `src-tauri/migrations/0020/01_invoice_immutability.sql`, `0021/01_storno_columns.sql`   |
| Storno-Spalten + Logik         | `src-tauri/migrations/0021/01_storno_columns.sql`, `src/lib/db/invoices.ts` (`cancelInvoice`) |
| Audit-Tabelle `invoice_audit`  | `src-tauri/migrations/0017/01_invoice_audit.sql`                                        |
| Audit-Trigger                  | `src-tauri/migrations/0019/01_invoice_audit_triggers.sql`                               |
| Aufbewahrungs-Guard            | `src/lib/db/retention.ts`, Aufrufer in `invoices.ts`, `payments.ts`, `audit.ts`         |
| GoBD-Export                    | `src-tauri/src/gobd.rs`, Tauri-Befehl `export_gobd` in `src-tauri/src/lib.rs`           |
| Export-UI                      | `src/routes/einstellungen/backup/+page.svelte`                                          |

Letzter referenzierter Migrationsstand zum Zeitpunkt der Erstellung:
`0024` (`src-tauri/migrations/`).
