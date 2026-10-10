# Security Policy

Bookie handles financial data, so please report vulnerabilities **privately**.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/logscale-it/bookie/security/advisories/new>.

Please do not open a public issue for security problems. Include the affected
version, steps to reproduce, and the impact you see. You can expect a first
reply within a few days.

## Scope

- The desktop app (Tauri backend and Svelte frontend)
- Local data handling: SQLite database, backups, S3 credentials in the OS keyring
- The release and auto-update pipeline

## Supported versions

Only the latest release receives security fixes.
