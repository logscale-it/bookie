# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); entries are grouped by date.

## [Unreleased]

## [0.1.12] - 2026-11-04

- Incoming invoices: AI receipt capture. Uploading a PDF or photo prefills supplier, number, date, net and VAT for
  review. Local mode: pick a provider under Einstellungen → KI (Anthropic, OpenAI-compatible such as Z.AI/OpenRouter,
  Gemini, Mistral or self-hosted Ollama); the API key stays in the OS keyring and the request runs in Rust. Cloud mode:
  bookie-server reads the receipt (Mistral OCR), no own key needed.
- Incoming invoices: bulk capture ("Belege per KI erfassen") creates one open invoice per receipt, prefilled by AI and
  flagged in the notes for review; receipts the AI could not read are flagged too and the error is shown.
- Cloud vacation requests (/urlaub, hidden for subcontractors): request days off with a live weekday count, delete own
  requests; the admin approves or rejects with a reason. Leave actions show in the team feed.
- Cloud features above need the matching bookie-server (`/api/incoming-invoices/extract` with `MISTRAL_API_KEY`,
  `/api/leave`).

## [0.1.11] - 2026-11-02

- Cloud time approval: members hand in a month ("Monat zur Freigabe einreichen"); a lead approves or returns only
  handed-in months (their own hours directly). An edit withdraws the submission. The dashboard approvals card lists only
  handed-in months. Needs the matching bookie-server (approving an unsubmitted month answers `not_submitted`).
- Cloud invitations: a fresh account without a company can accept an invite next to "Firma anlegen"; the settings
  overview lists Team.
- Cloud mode: Einstellungen → Backup shows only the cloud export (local backup and S3 act on the local file).

## [0.1.10] - 2026-11-01

- Time tracking: entries may cross midnight; an end at exactly 24:00 is kept when editing.
- Linux build fixed: `rfd` follows `tauri-plugin-dialog` to 0.17 with the gtk3 backend. v0.1.9 was never published
  because its Linux build failed.

## [0.1.9] - 2026-11-01

- Cloud team work: live presence avatars (one color per person), a hint when a teammate has the same record open, and a
  "Neue Änderungen im Team" pill that reloads the page once others changed data. Needs bookie-server with migration
  `0002_team_activity`.
- Team page (Team → Stunden, Freigaben, Aktivität): hours per person and month with status bar (abgerechnet /
  freigegeben / offen), approve or send back a month with a reason, open approvals of other months, online dot, and a
  shared activity feed of every team action that pages back ("Mehr"). The dashboard shows the same feed.
- Workspace shell for multi-user companies: company switcher, user menu, navigation follows the caller's rights, invite
  presets (Buchhaltung, Steuerberater, Teamleitung), admin handover, invoice audit trail (Verlauf), time entries show
  their author with a member filter.
- Projects: hour and euro budget with burn bar, staffing per project.
- Cloud: offline bar when the server is unreachable; saving a record someone else changed meanwhile shows a reload
  prompt instead of overwriting. Registration asks to confirm the password. Server URL prefilled with
  `https://bookie.logscale-it.com`.
- New design system and polished pages: bundled Geist fonts, dialogs instead of browser prompts, undo for deletes,
  skeletons and empty states, sidebar timer that survives reloads, ⌘S to save, keyboard shortcut `n` to create.
- Time tracking and timesheet: filter by customer and project; project options follow the selected customer.

## [0.1.8] - 2026-10-26

- Cloud mode (Einstellungen → Cloud): sign in to a bookie-server; account, 2FA, billing, team with roles, invitations,
  monthly approval and subcontractor overview. Invoices, payments, storno, incoming invoices, recurring entries and
  reports work against the server. Local data moves into an empty cloud company on switch, including receipt files.
  The session token is kept in the OS keyring.
- Einstellungen → Wiederkehrend: list, edit, pause and delete recurring schedules.
- XRechnung export now saves a PDF plus the XML original next to it. Validation messages say what a valid VAT ID, IBAN
  and BIC look like.
- Links to http(s) URLs (Stripe Checkout, customer websites) open again.
- `zip` bumped to 9 (RUSTSEC-2026-0367/0368/0369); English UI wording reviewed, more strings moved to `src/lib/i18n`.
- App identifier is now `com.logscale.bookie` (was `com.ranelkarimov.bookie`). On first start the old data
  directories and keyring entries (S3 credentials, cloud session) move over automatically.
- Invoices now keep the seller address (migration 0033, `invoices.issuer_*` address columns) and, in local mode, the
  recipient as they were when saved. Issued invoices render PDF and e-invoice from that snapshot in local mode too, so a
  later change of company or customer address no longer alters old invoices. Older invoices fall back to the live data.
- Cloud-Export (Einstellungen → Backup & Wiederherstellung): saves all cloud company data (`bookie-export.json`) and
  every receipt into a folder, also without an active subscription. A cancelled cloud company is deleted after 90 days.
- Local mode: an invoice can be cancelled (storno) only once, and a storno itself not at all, like in cloud mode.

## [0.1.7] - 2026-10-14

- Release pipeline: builds now upload into a single draft release and the release is only published after every
  installer, signature and a complete updater manifest (`latest.json`) are verified (`scripts/release-check.sh`).
  Fixes the v0.1.6 release, which was published with Linux files only.
- Landing page and website: German page (`docs/de/`), language switch, screenshots, notice about unsigned installers.
- E-Rechnung export: with `einvoice_format = zugferd`, "PDF speichern" now creates a ZUGFeRD / Factur-X
  (EN 16931 profile) hybrid PDF/A-3 with embedded `factur-x.xml`; `xrechnung` saves an XRechnung 3.0 XML.
  A pre-flight check (`src/lib/einvoice/validate.ts`) blocks export with a list of fixable problems, and the
  generated file is read back before it is handed over. The ZUGFeRD PDF and both XML flavours pass the
  Mustangproject validator (XSD, EN 16931 + XRechnung Schematron, veraPDF PDF/A-3B); run it with
  `scripts/fetch-mustang.sh`. New dependency `@pdf-lib/fontkit`; Liberation Sans (OFL) and an sRGB ICC profile are bundled.
- E-Rechnung: new per-invoice field "Leitweg-ID / Käuferreferenz" (BT-10, migration 0032, `invoices.buyer_reference`),
  frozen once the invoice is issued. XRechnung export now works when it is filled in.

## [0.1.6] - withdrawn

- Published incomplete (Linux files only) and removed. Its changes are part of 0.1.7.

## [0.1.5]

- Reworked `README.md`, added `README.de.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
- E-Rechnung: incoming XRechnung and ZUGFeRD invoices can be read (see `docs/e-rechnung.md`).
- Removed `package-lock.json`; Bun (`bun.lock`) is the only package manager.

## 2026-05-17

- **Restored `.github/dependabot.yml`** with monthly cadence and
  `open-pull-requests-limit: 3` for `npm` and `cargo` ecosystems
  (OPS-8). The file had been removed alongside CI in commit `d6904ba`;
  Dependabot still files PRs without Actions, and a human reviews them.
  Documented the new flow in CONTRIBUTING.md § Supply-chain advisories.

## 2026-05-15

- **OPS-5.e verification (issue #220).** Ran the 5 sandbox-safe steps of
  `bun run test:all` (steps 1 `bun run check`, 2 `bun test`,
  3 `cargo fmt --check`, 6 `cargo audit`, 7 `bun audit`) on master HEAD
  (`8302806`). Steps 1, 2, 3, and 6 pass. **Step 7 (`bun audit
--audit-level=high`) fails** with one high-severity advisory
  (`GHSA-77vg-94rm-hx3p`, "Svelte devalue: DoS via sparse array
  deserialization") affecting `devalue >=5.6.3 <=5.8.0` transitively via
  `@sveltejs/kit` and `svelte`. Steps 4 (`cargo clippy`) and 5
  (`cargo test`) require GTK system libs (`libgtk-3-dev`,
  `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`,
  `libjavascriptcoregtk-4.1-dev`, `pkg-config`) and must be attested by
  a maintainer on a dev box. Full log on issue #220.

## 2026-05-14

- **CI switched to local pre-push gate.** GitHub Actions CI was disabled in
  commit `d6904ba` to save runner cost. Contributors now run
  `bun run test:all` (which invokes `scripts/test-all.sh`) before pushing —
  see `CLAUDE.md` § Pre-push checks and `CONTRIBUTING.md` § Pull Requests
  step 3.

## 2026-05-11

- Restored GitHub Actions CI by renaming `.github/workflows/ci.yml.disabled`
  back to `.github/workflows/ci.yml`; CI now runs frontend type checking,
  Rust formatting, clippy, Rust security audit, frontend security audit,
  frontend tests, and backend tests for `master` pushes and pull requests.
- Added a tag-triggered release workflow for `logscale-it/bookie` that builds
  Tauri bundles on Linux, macOS, and Windows and uploads them to a GitHub
  Release.
