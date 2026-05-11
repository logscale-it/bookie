# Bookie — Betriebshandbuch

Dieses Handbuch richtet sich an Inhaberinnen und Inhaber kleiner Unternehmen,
die Bookie selbst betreiben. Es beschreibt die Wartungsaufgaben, die nicht in
der App selbst dokumentiert sind: wo die Daten liegen, wie Sie ein Backup auf
ein neues Gerät übertragen, wie Sie S3-Zugangsdaten austauschen, wie Sie für
eine Betriebsprüfung vorbereitet sind, und was zu tun ist, wenn die App
nicht mehr startet.

> Hinweis: Begriffe wie SQLite, S3, Bucket, Endpoint oder Schlüsselbund
> bleiben im englischen Original, weil sie in der Praxis so heißen. Alles
> andere ist auf Deutsch.

---

## 1. Wo liegen meine Daten?

Bookie speichert alle Daten lokal auf Ihrem Gerät. Es gibt drei relevante
Ordner: die Datenbank (`bookie.db`), die Log-Dateien und — falls aktiviert —
die Kopien im S3-Speicher.

### Pfad zur Datenbank `bookie.db`

| Betriebssystem | Pfad                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| Windows        | `C:\Users\<Benutzer>\AppData\Roaming\com.ranelkarimov.bookie\bookie.db` |
| macOS          | `~/Library/Application Support/com.ranelkarimov.bookie/bookie.db`       |
| Linux          | `~/.local/share/com.ranelkarimov.bookie/bookie.db`                      |

Neben `bookie.db` können temporäre SQLite-Dateien `bookie.db-wal` und
`bookie.db-shm` im selben Ordner liegen. Diese gehören zur laufenden
Datenbank und dürfen nicht einzeln kopiert oder gelöscht werden.

### Pfad zu den Log-Dateien

| Betriebssystem | Pfad                                                              |
| -------------- | ----------------------------------------------------------------- |
| Windows        | `C:\Users\<Benutzer>\AppData\Local\com.ranelkarimov.bookie\logs\` |
| macOS          | `~/Library/Logs/com.ranelkarimov.bookie/`                         |
| Linux          | `~/.local/share/com.ranelkarimov.bookie/logs/`                    |

Die Log-Dateien heißen `bookie.<JJJJ-MM-TT>.log`. Es werden die letzten
14 Tage aufbewahrt, ältere Dateien werden automatisch gelöscht.

### Ordner schnell öffnen

- Windows: Drücken Sie `Win + R`, geben Sie `%APPDATA%\com.ranelkarimov.bookie`
  ein und bestätigen Sie.
- macOS: Im Finder `Cmd + Umschalt + G`, dann
  `~/Library/Application Support/com.ranelkarimov.bookie` einfügen.
- Linux: Im Dateimanager Strg + L, dann
  `~/.local/share/com.ranelkarimov.bookie` einfügen.

---

## 2. Backup auf neues Gerät übertragen

Es gibt zwei Wege. Wenn Sie S3 eingerichtet haben, ist Weg B robuster, weil
die Datei nach jedem manuellen oder automatischen Backup auf einen Server
kopiert wird und beim Wiederherstellen automatisch auf Korrektheit geprüft
wird.

### Weg A — manueller Export per Datei

Auf dem alten Gerät:

1. Öffnen Sie Bookie.
2. Navigieren Sie zu **Einstellungen → Backup & Wiederherstellung**.
3. Klicken Sie auf **Datenbank herunterladen**. Die Datei `bookie.db` wird
   in Ihren Downloads-Ordner gespeichert.
4. Übertragen Sie die Datei auf das neue Gerät (USB-Stick, verschlüsselter
   Cloud-Speicher Ihrer Wahl, E-Mail an sich selbst).

Auf dem neuen Gerät:

1. Installieren Sie Bookie aus den Releases auf
   <https://github.com/logscale-it/bookie/releases/latest>.
2. Starten Sie die App einmal, damit der Datenordner angelegt wird, und
   schließen Sie sie wieder.
3. Öffnen Sie Bookie erneut und gehen Sie zu
   **Einstellungen → Backup & Wiederherstellung**.
4. Wählen Sie unter **Backup-Datei hochladen** die mitgebrachte
   `bookie.db`.
5. Klicken Sie auf **Wiederherstellen** und bestätigen Sie die Rückfrage
   („Die aktuelle Datenbank wird überschrieben. Fortfahren?“).
6. Schließen Sie die App und starten Sie sie neu, sobald die Meldung
   „Backup wurde wiederhergestellt. App bitte neu laden.“ erscheint.

Vor dem Überschreiben legt Bookie automatisch eine Sicherheitskopie der
bisherigen Datenbank als `bookie.db.pre-restore-backup` im Datenordner
(siehe Abschnitt 1) ab. Damit können Sie die alte Datenbank
zurückspielen, falls beim Wiederherstellen etwas schiefgeht.

### Weg B — Wiederherstellung aus S3 (empfohlen, falls eingerichtet)

Voraussetzung: Sie haben auf dem alten Gerät unter
**Einstellungen → S3-Speicher** Ihren Bucket aktiviert und mindestens
ein Backup hochgeladen. Bookie speichert zusammen mit jedem Backup eine
SHA-256-Prüfsumme in einer `…sha256`-Begleitdatei, sodass das neue Gerät
die Integrität prüfen kann, bevor es die Datenbank ersetzt.

Auf dem neuen Gerät:

1. Installieren und starten Sie Bookie wie in Weg A.
2. Tragen Sie unter **Einstellungen → S3-Speicher** dieselben Werte ein
   wie auf dem alten Gerät: Endpoint URL, Region, Bucket-Name,
   Access Key ID, Secret Access Key und Pfad-Präfix. Aktivieren Sie
   **S3-Speicher aktivieren** und speichern Sie.
3. Klicken Sie auf **Verbindung testen**. Bei Erfolg erscheint
   „Verbindung erfolgreich hergestellt.“
4. Spielen Sie das jüngste Backup zurück (siehe S3-Wiederherstellungs-
   ablauf in der App). Bookie lädt die Datei herunter, prüft die
   SHA-256-Prüfsumme gegen die hinterlegte Begleitdatei, prüft die
   SQLite-Signatur und ersetzt die Datenbank atomar.
5. Starten Sie die App neu.

> Hinweis: Falls die Begleitdatei `…sha256` fehlt (z. B. weil das Backup
> mit einer sehr alten Bookie-Version erzeugt wurde), bricht die
> Wiederherstellung ab. Das ist Absicht — überspielen Sie zuerst ein
> aktuelles Backup vom alten Gerät und wiederholen Sie den Vorgang.

### Integritätsprüfung nach dem Restore

Öffnen Sie nach dem Neustart **Übersicht** und vergleichen Sie Umsatz
und Anzahl der Rechnungen mit dem letzten Stand auf dem alten Gerät.
Stichprobenartig eine Rechnung öffnen, PDF erzeugen und mit dem Original
vergleichen.

---

## 3. S3-Zugangsdaten rotieren

S3-Access-Keys sollten regelmäßig (z. B. jährlich) und sofort bei
Verdacht auf Kompromittierung erneuert werden. Bookie speichert die
Zugangsdaten im OS-Schlüsselbund (Windows Credential Manager,
macOS Keychain, Linux Secret Service / GNOME Keyring).

1. Erstellen Sie im Backend Ihres S3-Anbieters (AWS IAM, MinIO,
   Hetzner, …) ein neues Schlüsselpaar. Schreiben Sie sich
   Access Key ID und Secret Access Key auf.
2. Öffnen Sie Bookie und gehen Sie zu **Einstellungen → S3-Speicher**.
3. Tragen Sie unter **Access Key** und **Secret Key** die neuen Werte
   ein. Endpoint URL, Region, Bucket-Name und Pfad-Präfix bleiben
   unverändert.
4. Klicken Sie auf **Änderungen speichern**. Bookie schreibt das neue
   Schlüsselpaar in den Schlüsselbund und überschreibt den alten
   Eintrag (Service `com.ranelkarimov.bookie`, Account
   `s3_credentials`).
5. Klicken Sie auf **Verbindung testen**. Wenn dort
   „Verbindung erfolgreich hergestellt.“ erscheint, ist die Rotation
   abgeschlossen.
6. Lösen Sie ein manuelles Backup über
   **Einstellungen → Backup & Wiederherstellung → Jetzt sichern** aus,
   um zu prüfen, dass der Upload mit den neuen Schlüsseln funktioniert.
7. Deaktivieren Sie erst danach die alten Schlüssel im Backend Ihres
   S3-Anbieters. So bleibt im Fehlerfall ein Rückfallpfad übrig.

> Hinweis: Sollte Bookie beim Start die Meldung „Zugangsdaten konnten
> nicht aus dem Schlüsselbund geladen werden. Bitte erneut eingeben.“
> anzeigen, ist der Schlüsselbund-Eintrag verloren oder unzugänglich.
> Geben Sie Access Key und Secret Key erneut ein und speichern Sie.
> Siehe Abschnitt 5.

---

## 4. Audit-Export für die Betriebsprüfung

Für eine steuerliche Außenprüfung in Deutschland (§ 147 AO, GoBD)
müssen alle Buchungsbelege, die Datenbank und nachvollziehbare
Änderungen für zehn Jahre aufbewahrt und auf Anforderung übergeben
werden. Bookie hält die Datenbestände bereits in einem maschinell
auswertbaren Format vor; ein einziger Knopf „GoBD-Export“ ist noch
nicht implementiert.

### Aktuelle, manuelle Vorgehensweise

Stellen Sie der Prüferin oder dem Prüfer ein Verzeichnis mit folgenden
Bestandteilen zur Verfügung (USB-Stick, verschlüsseltes Archiv,
Datenraum — wie vereinbart):

1. **Datenbank-Snapshot.** Erzeugen Sie ein frisches Backup über
   **Einstellungen → Backup & Wiederherstellung → Datenbank
   herunterladen** und legen Sie die `bookie.db` ins Auszugs-
   verzeichnis. Diese Datei enthält alle Rechnungen, Rechnungspositionen,
   Zahlungen, eingehenden Rechnungen, Kunden, Projekte, Zeiterfassung
   und das Audit-Log (`invoice_audit`-Tabelle) mit allen seit der
   Ersterfassung vorgenommenen Änderungen.
2. **Auswertungen als CSV.** Öffnen Sie **Übersicht**, wählen Sie das
   gewünschte Geschäftsjahr und exportieren Sie:
   - **UStVA-CSV** — Umsatzsteuer-Voranmeldungen je Periode.
   - **EÜR-CSV** — Einnahmen-Überschuss-Rechnung je Periode.
3. **Ausgangsrechnungen als PDF.** Erzeugen Sie für jede Rechnung des
   Prüfungszeitraums über **Rechnungen → \[Rechnung öffnen\] → PDF
   speichern** das PDF und legen Sie alle Dateien in einen Unterordner
   `rechnungen-ausgang/`. Die PDFs werden nicht automatisch in einem
   Bookie-Ordner gesammelt, sondern an dem Speicherort abgelegt, den
   Sie im Speichern-Dialog wählen — sammeln Sie sie konsequent an einer
   Stelle.
4. **Eingangsrechnungen.** Wenn Sie S3 nutzen, liegen die hochgeladenen
   Belege im Bucket unter dem Präfix `eingehende-rechnungen/`. Laden
   Sie diese herunter (z. B. über die S3-Konsole Ihres Anbieters oder
   ein Werkzeug wie `aws s3 sync`) und legen Sie sie in einen
   Unterordner `rechnungen-eingang/`. Ohne S3 liegen die
   Original-Belegdateien nur dort, wo Sie sie selbst abgespeichert
   haben — ihre Metadaten sind aber in der `bookie.db` enthalten.

Das Audit-Log (`invoice_audit`-Tabelle in `bookie.db`) protokolliert
jede Anlage, Änderung und Stornierung von Rechnungen, Positionen und
Zahlungen mit Zeitstempel und Diff der geänderten Felder. Eine
Änderung im Nachhinein ohne Spur ist nicht möglich; ausgestellte
Rechnungen können nur per Stornorechnung neutralisiert werden.

> Hinweis: Ein Ein-Klick-„GoBD-Komplettexport“, der die obigen
> Schritte in einem ZIP zusammenfasst, ist als Ticket COMP-1.b in der
> Roadmap eingeplant. Bis dahin ist die manuelle Sammlung der oben
> genannten Bestandteile der dokumentierte Weg.

### DSGVO-Auskunft für eine einzelne Person

Unabhängig von der Betriebsprüfung können Sie für einen einzelnen
Kunden eine DSGVO-Auskunft (Art. 15 DSGVO) als ZIP exportieren —
inklusive aller Rechnungen, Zahlungen, Audit-Ereignisse und einer
deutschsprachigen PDF-Zusammenfassung. Der Auslöser dafür ist die
Kunden-Detailansicht.

---

## 5. Wenn die App nicht startet

Erste Diagnose-Schritte, in dieser Reihenfolge:

### 5.1 Logs ansehen

Öffnen Sie den Log-Ordner (Pfade siehe Abschnitt 1) und schauen Sie
in die Datei `bookie.<heutiges-Datum>.log`. Suchen Sie nach
`ERROR`-Einträgen am Ende der Datei. Diese benennen die Ursache
meistens unmittelbar (z. B. „Failed to read backup“,
„The file is not a valid SQLite database“, „OS keyring is
unavailable“).

### 5.2 Schlüsselbund-Eintrag defekt

Symptom: Beim Start meldet Bookie sinngemäß
„Zugangsdaten konnten nicht aus dem Schlüsselbund geladen werden.“
oder S3-Aktionen schlagen mit „OS keyring is unavailable“ fehl.

Lösung:

1. Öffnen Sie den Schlüsselbund-Manager Ihres Betriebssystems
   (Windows: Anmeldeinformationsverwaltung; macOS:
   Schlüsselbundverwaltung; Linux: Seahorse / Passwörter und
   Schlüssel).
2. Suchen Sie den Eintrag mit dem Service-Namen
   `com.ranelkarimov.bookie` und dem Account `s3_credentials`.
3. Löschen Sie den Eintrag.
4. Starten Sie Bookie neu, gehen Sie zu **Einstellungen → S3-Speicher**
   und geben Sie Access Key und Secret Key erneut ein.

Auf Linux setzt Bookie den Secret Service voraus (in der Regel über
GNOME Keyring oder KWallet). Wenn beim Headless-Betrieb kein
Secret-Service-Daemon läuft, schlägt jede S3-Aktion fehl — ein
dauerhafter Fix ist hier nicht in Bookie, sondern in der
Desktopumgebung zu suchen.

### 5.3 Datenbank gesperrt

Symptom: Die App startet, zeigt aber keine Daten oder meldet
„database is locked“.

Mögliche Ursachen und Lösungen:

1. Bookie verhindert zweite gleichzeitige Starts und fokussiert stattdessen
   das bereits geöffnete Fenster; dieser Fall sollte nicht mehr zu
   Datenbanksperren führen.
2. Im Datenordner (siehe Abschnitt 1) liegen `bookie.db-wal` oder
   `bookie.db-shm` aus einer abgestürzten Sitzung. Solange keine
   Bookie-Instanz läuft, dürfen Sie diese beiden Dateien löschen
   (nicht `bookie.db`!) und die App neu starten.

### 5.4 Migration fehlgeschlagen

Symptom: Nach einem Update startet Bookie nicht mehr; im Log steht
ein Fehler aus dem Bereich „migration“ oder Verweise auf fehlende
Tabellen / Spalten.

Lösung:

1. Schließen Sie die App.
2. Sichern Sie den gesamten Datenordner per Datei-Manager als ZIP
   (für den Fall der Fälle).
3. Spielen Sie das letzte funktionierende Backup zurück:
   - Liegt es lokal vor: per Weg A (Abschnitt 2).
   - Liegt es in S3 vor: per Weg B (Abschnitt 2).
4. Wenn auch das fehlschlägt: Öffnen Sie ein Issue auf
   <https://github.com/logscale-it/bookie/issues> und hängen Sie die
   Log-Datei an (keine `bookie.db`! — diese enthält Geschäftsdaten).

### 5.5 Datenbank korrupt

Symptom: Beim Wiederherstellen erscheint die Meldung
„The file is not a valid SQLite database.“ oder beim Start meldet
SQLite „file is not a database“.

Lösung: Die Datei ist beschädigt (Übertragungsfehler, abgebrochener
Schreibvorgang, fehlerhaftes Speichermedium). Spielen Sie ein älteres
Backup ein. Bookie validiert beim Wiederherstellen die
SQLite-Signatur, sodass eine kaputte Datei nie unbemerkt die laufende
Datenbank ersetzt.

---

## Notfall-Checkliste

- Datenordner per Dateimanager regelmäßig auf einen externen
  Datenträger kopieren — zusätzlich zum S3-Backup.
- Nach jedem Bookie-Update einmal **Datenbank herunterladen** klicken
  und die `bookie.db` extern ablegen.
- Access-Key-Rotation jährlich kalendarisieren (Abschnitt 3).
- Den Pfad zum Datenordner für Ihr Betriebssystem ausgedruckt im
  Ordner mit den Geschäftsunterlagen ablegen — falls die App nicht
  startet und Sie schnell an die Datei müssen.
