<p align="center">
  <img src="static/bookie.svg" alt="Bookie Logo" width="160">
</p>

<p align="center">
  <a href="https://github.com/logscale-it/bookie/releases/latest"><img src="https://img.shields.io/github/v/release/logscale-it/bookie" alt="Neueste Version"></a>
  <a href="https://github.com/logscale-it/bookie/releases"><img src="https://img.shields.io/github/downloads/logscale-it/bookie/total" alt="Downloads"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/github/license/logscale-it/bookie" alt="Lizenz"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/made%20with-Tauri-24C8DB" alt="Made with Tauri"></a>
</p>

# Bookie

**Kostenloses Rechnungsprogramm und Buchhaltung für Freiberufler, Kleinunternehmer und kleine Unternehmen.**
Open Source, offline, ohne Abo, ohne Cloud-Zwang. ca. 6 MB.

[⬇ Download für Windows / macOS / Linux](https://github.com/logscale-it/bookie/releases/latest) · [🇬🇧 English](README.md)

<p align="center"><img src="docs/screenshots/dashboard-profit-loss.jpg" alt="Bookie Übersicht mit Gewinn und Verlust" width="800"></p>

Eine kostenlose Offline-Alternative zu Abo-Rechnungsprogrammen wie lexoffice oder sevDesk.

### Warum Bookie?

- 🧾 Rechnungen schreiben mit länderspezifischen Pflichtangaben (Profile für DE, AT, CH, FR, NL, US), inklusive Kleinunternehmer-Hinweis
- 🔒 100 % lokal: Ihre Buchhaltung bleibt auf Ihrem Rechner (SQLite)
- 📊 Übersicht mit Umsatz sowie Gewinn und Verlust
- ⏱ Zeiterfassung eingebaut
- 💾 Backups, optional mit S3-Synchronisierung
- 🪶 Winziger Installer (ca. 6 MB), gebaut mit Tauri + Svelte

## Download & Installation

Installer für Ihr System finden Sie unter [Releases](https://github.com/logscale-it/bookie/releases/latest):

- **Windows:** `.msi` oder `.exe`
- **macOS:** `.dmg` (Apple Silicon und Intel)
- **Linux:** `.AppImage` oder `.deb`

Bookie aktualisiert sich selbst über GitHub Releases.

### Warnung „Unbekannter Herausgeber“ / „kann nicht geöffnet werden“

Bookie ist noch nicht code-signiert, daher warnt Ihr Betriebssystem eventuell. Der Quellcode ist offen und kann geprüft oder selbst gebaut werden.

- **Windows (SmartScreen):** **Weitere Informationen** → **Trotzdem ausführen**.
- **macOS (Gatekeeper):** Rechtsklick auf die App → **Öffnen** → **Öffnen**. Oder: Systemeinstellungen → Datenschutz & Sicherheit → nach unten scrollen → **Trotzdem öffnen**.
- **Linux:** `chmod +x Bookie*.AppImage`, dann starten.

## Screenshots

| | |
|---|---|
| ![Eingehende Rechnungen](docs/screenshots/incoming-invoices.jpg) | ![Zeiterfassung und Stundenzettel](docs/screenshots/time-tracking-timesheet.jpg) |
| ![Einstellungen: Organisation](docs/screenshots/settings-organisation.jpg) | |

## Roadmap

- E-Rechnung (XRechnung / ZUGFeRD): Empfangen und Erstellen, in Arbeit, siehe [docs/e-rechnung-status.md](docs/e-rechnung-status.md)
- Englische Oberfläche und weitere Länder, siehe offene Issues mit Label `help wanted`
- _Geplant:_ eine verwaltete Cloud-Version gegen kleine Gebühr, mit denselben Funktionen wie das S3-Backup, ohne eigenen Bucket.

## Entwicklung

Voraussetzungen: [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh) und die [Tauri-Systemabhängigkeiten](https://v2.tauri.app/start/prerequisites/) Ihres Betriebssystems. Genaue Pakete stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
bun install          # Abhängigkeiten installieren
bun run tauri dev    # Entwicklungsmodus
bun run tauri build  # Produktions-Build
```

## Mitmachen

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) und die Issues mit [`good first issue`](https://github.com/logscale-it/bookie/labels/good%20first%20issue). Hilfe bei weiteren Sprachen und Ländern sowie bei Performance und Größe ist willkommen.

## Lizenz

MIT, siehe [LICENSE.txt](LICENSE.txt).
