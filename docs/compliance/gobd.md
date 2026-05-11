# Bookie — GoBD-Konformität

> Adressat: Steuerberaterinnen, Wirtschaftsprüfer und Betriebsprüferinnen, die
> nachvollziehen wollen, **wie** Bookie die Anforderungen der GoBD (BMF-Schreiben
> vom 28.11.2019, „Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung
> von Büchern, Aufzeichnungen und Unterlagen in elektronischer Form sowie
> zum Datenzugriff", Az. IV A 4 - S 0316/19/10003 :001) und § 147 AO im
> Quellcode umsetzt. Operative Schritte für Inhaberinnen und Inhaber stehen
> in [`docs/operations.md`](../operations.md), Abschnitt 4.

> Hinweis zum Stand: Dieses Dokument beschreibt den Soll-Stand der
> COMP-1-Maßnahmen und kennzeichnet bei jeder Garantie ausdrücklich, ob sie
> bereits **umgesetzt** ist (auf `master` gemerged), sich **in Review** in
> einem offenen Pull Request befindet, oder **geplant** ist. Stand:
> 2026-05-11. Vor jedem Stichtags-Release ist dieses Dokument zu
> aktualisieren.

---

## 1. Geltungsbereich und Rechtsgrundlage

### 1.1 Welche Vorschriften adressiert Bookie?

| Norm                                     | Anforderung an Bookie                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| § 146 AO                                 | Vollständigkeit, Richtigkeit, Zeitgerechtigkeit, Ordnung der Buchführung                       |
| § 147 AO                                 | 10-jährige Aufbewahrungsfrist für Buchungsbelege, Bücher und Aufzeichnungen                    |
| § 14 UStG                                | Pflichtangaben einer Rechnung; § 14b UStG: 10-jährige Aufbewahrung beim leistenden Unternehmer |
| GoBD Rz. 58 ff. (Unveränderbarkeit)      | Datensätze dürfen nach Festschreibung nicht ohne Spur überschrieben oder gelöscht werden       |
| GoBD Rz. 100 ff. (Datenzugriff Z1/Z2/Z3) | Daten müssen maschinell auswertbar bereitgestellt werden können                                |
| GoBD Rz. 164 (Verfahrensdokumentation)   | Das vorliegende Dokument dient als Verfahrensdokumentation der Buchhaltungs-Software           |

### 1.2 Welche Tabellen sind buchungsrelevant?

GoBD-relevant im Sinne von „aufbewahrungspflichtig und unveränderbar nach
Festschreibung" sind:

| Tabelle         | Inhalt                                                  | Festschreibung erfolgt …                                                              |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `invoices`      | Rechnungsköpfe (Ausgangs- und Stornorechnungen)         | beim Statuswechsel `draft` → `issued` (oder direkt bei Storno-Insert)                 |
| `invoice_items` | Rechnungspositionen                                     | implizit, sobald die zugehörige Rechnung in `issued` gewechselt ist (FK `invoice_id`) |
| `payments`      | Zahlungseingänge                                        | bei Insert; Updates werden im Audit-Log protokolliert                                 |
| `invoice_audit` | Lückenloses Änderungsprotokoll der drei oberen Tabellen | bei jedem Insert/Update/Delete der drei oberen Tabellen automatisch (Trigger)         |
| `customers`     | Stammdaten Rechnungsempfänger                           | nicht festgeschrieben (Adressänderungen sind erlaubt), siehe Abschnitt 2.4            |
| `companies`     | Stammdaten der Rechnungsstellerin (eigene Firma)        | nicht festgeschrieben, siehe Abschnitt 2.4                                            |

Nicht GoBD-relevant (rein operative Hilfsdaten, ohne Buchungswirkung):
`projects`, `time_entries`, `incoming_invoices` (siehe aber § 147 AO für die
Eingangsbelege selbst — diese liegen außerhalb der DB im S3-Bucket bzw. im
Dateisystem der Anwenderin).

### 1.3 Was ist explizit nicht abgedeckt?

- **Eingehende Rechnungen.** Originalbelege werden in S3 oder lokal abgelegt;
  Bookie speichert nur Metadaten (`incoming_invoices`). Die GoBD-konforme
  Aufbewahrung der Originaldateien obliegt der Anwenderin (Abschnitt 4.2 in
  `docs/operations.md`).
- **Bilanzielle Buchführung.** Bookie ist eine Rechnungs- und EÜR-Software;
  doppelte Buchführung, Anlagenbuchhaltung und Lohnkonten sind nicht
  Bestandteil.
- **Externe E-Invoice-Validierung.** ZUGFeRD-/XRechnung-Erzeugung ist Teil
  von COMP-3 und wird hier nicht beschrieben.

---

## 2. Garantien und ihre Quelltext-Umsetzung

Jede Unteranforderung aus GoBD wird genau einer Code-Stelle zugeordnet, damit
die Prüferin den Pfad „Anforderung → Implementierung → Test" 1:1 nachvollziehen
kann.

### 2.1 Unveränderbarkeit (DAT-2.a) — **umgesetzt**

**Anforderung (GoBD Rz. 58 ff.):** Festgeschriebene Buchungen sind ohne
Spur weder änderbar noch löschbar. Korrekturen erfolgen ausschließlich durch
zusätzliche, ihrerseits festgeschriebene Buchungen.

**Umsetzung:**

- Datei: `src-tauri/migrations/0020/01_invoice_immutability.sql`
- SQLite-Trigger `invoices_immutable_update` (BEFORE UPDATE) und
  `invoices_immutable_delete` (BEFORE DELETE) werfen `RAISE(ABORT,
'invoice_immutable')`, sobald `OLD.status <> 'draft'` und ein
  geschäftsrelevantes Feld geändert oder die Zeile gelöscht werden soll.
- Erlaubte Updates auf bereits ausgestellten Rechnungen sind ausschließlich:
  - Statusübergänge (z. B. `sent` → `paid`),
  - der technische `updated_at`-Zeitstempel,
  - der Backup-Schlüssel `s3_key` (rein technisches Feld zum
    Wiederfinden des PDF-Backups, ohne buchhalterischen Inhalt).
- Migration `0021/01_storno_columns.sql` erweitert den Trigger um die
  Spalten `references_invoice_id` und `cancellation_reason`, sodass auch
  diese auf festgeschriebenen Zeilen unveränderbar sind.

**Anwendungsschicht (Defense-in-Depth):**
`src/lib/db/invoices.ts` wirft einen typisierten `InvoiceImmutable`-Fehler
(`err.name = "InvoiceImmutable"`), bevor die Mutation überhaupt an SQLite
geht. Der SQL-Trigger bleibt der letzte, nicht umgehbare Wall.

**Verifikation:** Versuch eines `UPDATE invoices SET net_cents = … WHERE
status = 'issued'` schlägt mit SQLite-Fehler `invoice_immutable` fehl;
`DELETE FROM invoices WHERE status = 'issued'` ebenso. Auf Drafts (`status =
'draft'`) sind beide Operationen erlaubt.

### 2.2 Korrektur durch Storno (DAT-2.b) — **umgesetzt**

**Anforderung (GoBD Rz. 58, § 14 Abs. 6 UStG):** Eine fehlerhafte Rechnung
darf nicht überschrieben werden. Korrektur erfolgt durch eine **eigenständige
Stornorechnung** mit negierten Beträgen und Verweis auf das Original.

**Umsetzung:**

- Funktion `cancelInvoice(id, reason)` in `src/lib/db/invoices.ts`.
- Schreibt eine neue Rechnung mit `status = 'issued'`, `invoice_number =
"<orig>-storno-<N>"`, allen monetären Spalten (`net_amount`,
  `tax_amount`, `gross_amount`, `net_cents`, `tax_cents`, `gross_cents`)
  als negative Spiegel der Originalwerte, `references_invoice_id` als
  Fremdschlüssel auf die Originalrechnung und `cancellation_reason` als
  vom Operator angegebener Grund.
- Kopiert Aussteller-, Empfänger-, Bank- und Leistungszeitraum-Felder
  verbatim, sodass der Storno als selbständige, beim Empfänger ablegbare
  Rechnung steht.
- Läuft in einer einzigen SQL-Transaktion; bei Fehlern wird sowohl der
  Storno-Header als auch alle Storno-Positionen zurückgerollt.
- Drafts können nicht storniert, sondern nur gelöscht werden — `cancelInvoice`
  wirft `InvoiceImmutable` mit der Begründung „Entwurfsrechnungen können
  nicht storniert werden — bitte löschen statt stornieren".

**Verifikation:** Aufruf `cancelInvoice(<issued_id>, "Falsche Adresse")`
liefert eine neue Rechnungs-ID; in der DB steht eine Zeile mit negierten
Beträgen, `status = 'issued'`, `references_invoice_id = <issued_id>`,
`cancellation_reason = "Falsche Adresse"`. Die Originalrechnung bleibt
unverändert.

### 2.3 Lückenloses Änderungsprotokoll (DAT-4) — **umgesetzt**

**Anforderung (GoBD Rz. 107 ff., Nachvollziehbarkeit/Nachprüfbarkeit):**
Jede Änderung an einem buchungsrelevanten Datensatz muss mit Zeitstempel,
Vorher-/Nachher-Stand und (sofern vorhanden) Verursacher protokolliert
werden.

**Umsetzung:**

- Tabelle `invoice_audit` (Migration `0017/01_invoice_audit.sql`):

  ```
  invoice_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT    NOT NULL,        -- 'invoices' | 'invoice_items' | 'payments'
    entity_id   INTEGER NOT NULL,        -- bei items/payments = invoice_id des Parents
    op          TEXT    NOT NULL,        -- 'insert' | 'update' | 'delete'
    actor       TEXT,                    -- für künftige Mehrbenutzer-Erweiterung; aktuell NULL
    ts_unix_us  INTEGER NOT NULL,        -- Unix-Mikrosekunden UTC
    fields_diff TEXT    NOT NULL         -- JSON: {"col": {"before": <alt>, "after": <neu>}}
  )
  ```

- AFTER-INSERT/UPDATE/DELETE-Trigger (Migration
  `0019/01_invoice_audit_triggers.sql`) auf `invoices`, `invoice_items` und
  `payments` schreiben pro Mutation eine Zeile in `invoice_audit`.
- INSERT-Diffs enthalten alle Spalten mit `before = NULL`; DELETE-Diffs
  alle Spalten mit `after = NULL`; UPDATE-Diffs **ausschließlich** die
  tatsächlich veränderten Spalten (NULL-sichere Vergleichsoperator-Logik
  via `OLD.x IS NEW.x`).
- Bei `invoice_items` und `payments` ist `entity_id` bewusst die Parent-
  `invoice_id`, sodass die vollständige Historie einer Rechnung mit einer
  einzigen Abfrage `WHERE entity_id = <id> AND entity_type IN ('invoices',
'invoice_items', 'payments')` rekonstruierbar ist.
- Audit-Zeilen sind ihrerseits append-only: die Anwendung ruft niemals
  `UPDATE`/`DELETE` auf `invoice_audit` auf. Die SQL-seitige Sperre dieser
  Tabelle gegen direkte Manipulation ist mit **Migration 0026**
  (`src-tauri/migrations/0026/01_invoice_audit_immutable.sql`, DAT-6.a)
  **umgesetzt**: Die BEFORE-Trigger `invoice_audit_immutable_update` und
  `invoice_audit_immutable_delete` werfen `RAISE(ABORT,
'audit_immutable')` bei jedem Versuch eines `UPDATE` oder `DELETE` auf
  `invoice_audit`. Inserts durch die Trigger aus Migration 0019 bleiben
  erlaubt.

**Indizes für Auditierbarkeit:**

- `invoice_audit_entity_idx (entity_type, entity_id)` — Historie einer
  Rechnung
- `invoice_audit_ts_idx (ts_unix_us)` — chronologische Auswertung

**Verifikation:** Insert einer Rechnung erzeugt genau eine
`invoice_audit`-Zeile mit `op = 'insert'` und allen Spalten in `fields_diff`.
Statuswechsel `sent` → `paid` erzeugt eine Update-Zeile, in der
`fields_diff` ausschließlich `{"status": {"before": "sent", "after":
"paid"}, "updated_at": …}` enthält.

### 2.4 Stammdatenänderungen — bewusst nicht festgeschrieben

`customers` und `companies` sind Stammdaten und **nicht** durch DAT-2-Trigger
geschützt. Adressen, Bankverbindungen und Steuernummern können sich legitim
ändern, ohne dass dies eine vergangene Rechnung berührt.

GoBD-Konformität bleibt gewahrt, weil die Rechnung beim Festschreiben **alle
relevanten Empfänger- und Aussteller-Felder denormalisiert** als eigene
Spalten der `invoices`-Zeile speichert (`recipient_name`, `recipient_street`,
`recipient_postal_code`, `recipient_city`, `recipient_country_code`,
`issuer_name`, `issuer_tax_number`, `issuer_vat_id`, `issuer_bank_*`). Eine
spätere Adressänderung im Kundenstamm ändert die archivierte Rechnung nicht.

### 2.5 10-jährige Aufbewahrungsfrist (COMP-1.a) — **umgesetzt**

**Anforderung (§ 147 Abs. 3 AO, § 14b UStG):** Buchungsbelege, Bücher und
Aufzeichnungen sind **zehn Jahre** aufzubewahren. Die Frist beginnt mit
dem Schluss des Kalenderjahres, in dem der Beleg entstanden ist (§ 147
Abs. 4 AO).

**Umsetzung:**

- `src/lib/db/retention.ts` enthält die zentrale Retention-Prüfung
  `assertOutsideRetention(entityLabel, countryCode, createdAt)`.
- Die Frist wird aus dem jeweiligen Legal Profile gelesen
  (`retentionYears`; für `DE` = 10 Jahre). Kann ein Land nicht sicher
  aufgelöst werden, fällt die Prüfung bewusst auf `DE` zurück.
- Die Delete-Pfade für `invoices` (`deleteInvoice`), `payments`
  (`deletePayment`) und künftige Wartungspfade für `invoice_audit`
  (`deleteAuditRow`) rufen die Prüfung vor der destruktiven Operation auf.
- Innerhalb der Frist wird ein typisierter TS-Fehler mit
  `err.name = "RetentionViolation"` geworfen. Die UI kann dadurch ohne
  String-Matching auf den fachlichen Fehler reagieren.
- Festgeschriebene Rechnungen bleiben zusätzlich durch die SQL-Trigger aus
  Abschnitt 2.1 geschützt. `invoice_audit` bleibt zusätzlich durch Migration
  `0026` append-only; der Retention-Wrapper verhindert, dass künftige
  Wartungstools diese fachliche Schranke umgehen.

**Verifikation:** Ein Delete eines bestehenden Payments oder einer
Draft-Rechnung innerhalb der Retention-Frist schlägt vor dem SQLite-Statement
mit `RetentionViolation` fehl. Für `invoice_audit` schlagen direkte
`UPDATE`/`DELETE`-Versuche mit `audit_immutable` fehl (DAT-6.a, Migration
`0026`).

### 2.6 Datenexport für die Außenprüfung (COMP-1.b) — **umgesetzt**

**Anforderung (GoBD Rz. 158 ff., § 147 Abs. 6 AO, „Datenträgerüberlassung"
Z3):** Die Steuerpflichtige muss der Finanzverwaltung auf Verlangen die
gespeicherten Unterlagen auf einem maschinell auswertbaren Datenträger
zur Verfügung stellen.

**Umsetzung:**

- Tauri-Befehl `export_gobd(from_year, to_year)` in `src-tauri/src/lib.rs`;
  die Archiv-Erzeugung liegt in `src-tauri/src/gobd.rs`.
- Erzeugt ein ZIP-Archiv namens `gobd-export-<from>-<to>.zip` mit
  folgendem Aufbau:

  ```
  gobd-export-<from>-<to>.zip
  ├── companies.csv          (vollständig)
  ├── customers.csv          (vollständig)
  ├── invoices.csv           (gefiltert: issue_date ∈ [from, to])
  ├── invoice_items.csv      (transitiv über invoice_id gefiltert)
  ├── payments.csv           (transitiv über invoice_id gefiltert)
  ├── invoice_audit.csv      (vollständig — der Trail muss erhalten bleiben)
  ├── schema_version.txt     (PRAGMA user_version + Spaltenliste je Tabelle)
  ├── manifest.json          (SHA-256 + Bytezahl je Datei)
  └── export_signature.txt   (SHA-256 von manifest.json)
  ```

- CSV-Header werden **dynamisch** aus `PRAGMA table_info(<tabelle>)`
  abgeleitet, sodass die Spaltenreihenfolge mit dem auf der Festplatte
  vorgefundenen Schema übereinstimmt.
- Die DB wird **read-only** geöffnet (kein Konflikt mit dem
  `tauri-plugin-sql`-Writer-Pool).
- Per-File-Hash und Top-Level-Signatur erlauben der Prüferin, die
  Integrität des Archivs nachträglich zu verifizieren.

#### 2.6.1 Worked Sample — Auszug aus `manifest.json`

```json
{
  "format_version": 1,
  "generated_at": "2026-05-11T09:14:27Z",
  "year_range": {
    "from": 2024,
    "to": 2024
  },
  "files": [
    { "path": "companies.csv", "sha256": "f3a1…", "bytes": 1842 },
    { "path": "customers.csv", "sha256": "8c2e…", "bytes": 12489 },
    { "path": "invoices.csv", "sha256": "0a77…", "bytes": 84231 },
    { "path": "invoice_items.csv", "sha256": "d4b9…", "bytes": 213004 },
    { "path": "payments.csv", "sha256": "2e17…", "bytes": 19233 },
    { "path": "invoice_audit.csv", "sha256": "97ce…", "bytes": 552884 },
    { "path": "schema_version.txt", "sha256": "1b40…", "bytes": 3217 }
  ]
}
```

`schema_version.txt` enthält den aktuellen SQLite-Stand
`user_version=26` sowie die Spaltenliste je exportierter Tabelle.

`export_signature.txt` enthält genau einen SHA-256-Hex-String — die
Prüfsumme von `manifest.json`. Verifikation auf Linux/macOS:

```sh
sha256sum manifest.json
cat export_signature.txt
# Beide Werte müssen identisch sein.
```

#### 2.6.2 Worked Sample — Auszug aus `invoice_audit.csv`

```csv
id,entity_type,entity_id,op,actor,ts_unix_us,fields_diff
1,invoices,42,insert,,1714915200000000,"{""invoice_number"":{""before"":null,""after"":""2024-0042""},""status"":{""before"":null,""after"":""draft""}, …}"
2,invoices,42,update,,1714915800123456,"{""status"":{""before"":""draft"",""after"":""issued""},""updated_at"":{""before"":""2024-05-05T12:00:00Z"",""after"":""2024-05-05T12:10:00Z""}}"
3,payments,42,insert,,1715001234000000,"{""payment_date"":{""before"":null,""after"":""2024-05-15""},""amount_cents"":{""before"":null,""after"":119000}, …}"
```

Lesart: Rechnung 42 wurde am 05.05.2024 12:00 UTC angelegt, 10 Minuten
später festgeschrieben (`status: draft → issued`), Zahlungseingang am
15.05.2024 verbucht — alles aus dem Audit-Log allein rekonstruierbar.

#### 2.6.3 UI-Einstieg

Der Export ist unter **Einstellungen → Backup & Wiederherstellung →
GoBD-Export** verfügbar; Operatorin wählt Geschäftsjahre `from`–`to` und
bekommt das ZIP über den Speichern-Dialog des Betriebssystems.

---

## 3. Pfade pro GoBD-Grundsatz

| GoBD-Grundsatz                  | Implementierung in Bookie                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nachvollziehbarkeit             | Audit-Log `invoice_audit` (Abschnitt 2.3); Storno mit `references_invoice_id` (Abschnitt 2.2)                                                     |
| Vollständigkeit                 | Trigger schreiben pro Insert/Update/Delete mindestens eine Audit-Zeile; CSV-Export enthält alle aufbewahrungspflichtigen Tabellen (Abschnitt 2.6) |
| Richtigkeit                     | Monetäre Spalten in Cent-Integern (DAT-1, Migration 0014–0016); CHECK-Constraints auf `invoice_items`                                             |
| Zeitgerechtigkeit               | `created_at`/`updated_at` werden DB-seitig per `DEFAULT CURRENT_TIMESTAMP` gesetzt; Audit-Zeitstempel in Mikrosekunden                            |
| Ordnung                         | Eindeutige `invoice_number` pro `company_id`; Storno-Suffix `<orig>-storno-<N>` zählt monoton                                                     |
| Unveränderbarkeit               | Trigger `invoices_immutable_update` und `invoices_immutable_delete` (Abschnitt 2.1); Audit-Tabelle append-only                                    |
| Aufbewahrung 10 Jahre           | Retention-Guard auf destruktiven Pfaden, parametrisiert über Legal Profiles (`retentionYears`; DE = 10), plus SQL-Immutability (Abschnitt 2.5)       |
| Maschinelle Auswertbarkeit (Z3) | CSV-Export nach RFC 4180; Audit-Diffs als JSON-Strings im Diff-Feld (Abschnitt 2.6)                                                               |

---

## 4. Verfahrensdokumentation für die Steuerberatung

Eine Verfahrensdokumentation nach GoBD Rz. 151 ff. besteht typischerweise
aus vier Teilen. Bookie deckt diese wie folgt ab:

| Teil                           | Quelle                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Allgemeine Beschreibung        | Dieses Dokument, Abschnitt 1                                                                    |
| Anwenderdokumentation          | `docs/operations.md` (Betriebshandbuch für die Inhaberin)                                       |
| Technische Systemdokumentation | Migrationen unter `src-tauri/migrations/`, kommentierter Quelltext, dieses Dokument             |
| Betriebsdokumentation          | `docs/operations.md`, Abschnitte 1 (Datenort), 2 (Backup), 3 (Schlüssel-Rotation), 5 (Diagnose) |

Für eine konkrete Außenprüfung legt die Inhaberin folgendes vor (vgl.
`docs/operations.md`, Abschnitt 4):

1. Datenbank-Snapshot `bookie.db` als technischer Vollexport.
2. GoBD-Export-ZIP (Abschnitt 2.6) für den Prüfungszeitraum.
3. PDFs aller Ausgangsrechnungen des Prüfungszeitraums.
4. Eingangsrechnungen aus dem S3-Bucket bzw. dem lokalen Belegordner.
5. Dieses Dokument als Verfahrensdokumentation.

---

## 5. Änderungs- und Versionshinweise

| Datum      | Änderung                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2026-05-10 | Erstfassung (Issue #92, COMP-1.c)                                                             |
| 2026-05-11 | Append-only-Enforcement für `invoice_audit` via SQL-Trigger umgesetzt (Migration 0026, DAT-6) |
| 2026-05-11 | COMP-1.a Retention-Guard und COMP-1.b GoBD-Export als auf `master` umgesetzt nachgezogen      |

Wenn sich an einer der referenzierten Stellen (`invoice_audit`-Schema,
Immutabilitäts-Trigger, Export-Format, Retention-Wrapper) etwas ändert, ist
dieses Dokument im selben PR nachzuziehen.

---

## 6. Hinweis an die Reviewerin

Dieses Dokument ist **rechtlich sensibel** und sollte vor einem Merge auf
`master` durch eine Person mit GoBD-Expertise (Steuerberatung oder
juristisches Lektorat) geprüft werden. Insbesondere die Zuordnungen
„Anforderung → Code-Stelle" in Abschnitt 2 müssen 1:1 stimmen — das ist
der Kern dessen, was die Prüferin im Ernstfall erwartet.
