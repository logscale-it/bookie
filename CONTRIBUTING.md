# Contributing

Thank you for your interest in Bookie! Here's everything you need to get started.

## Prerequisites

- **Rust** (stable) — [rustup.rs](https://rustup.rs)
- **Bun** — [bun.sh](https://bun.sh)
- **Linux:** Install system dependencies:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev
  ```
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), WebView2 (pre-installed on Windows 10/11)

## Project Setup

```bash
git clone https://github.com/logscale-it/bookie.git
cd bookie
bun install
bun run tauri dev
```

## Development

| Command | Description |
|---|---|
| `bun run tauri dev` | Start the app with hot-reload |
| `bun run check` | TypeScript / Svelte type checking |
| `bun run tauri build` | Production build of the desktop app |

## Code Style

### Frontend (TypeScript / Svelte)

- Svelte 5 runes syntax (`$state`, `$derived`, `$bindable`)
- Tailwind CSS for styling, no component library
- German UI labels, English code
- Check formatting:
  ```bash
  bunx prettier --check "src/**/*.{svelte,ts,js,css,html}"
  ```
- Apply formatting:
  ```bash
  bunx prettier --write "src/**/*.{svelte,ts,js,css,html}"
  ```

### Backend (Rust)

- Check formatting:
  ```bash
  cargo fmt --check --manifest-path src-tauri/Cargo.toml
  ```
- Apply formatting:
  ```bash
  cargo fmt --manifest-path src-tauri/Cargo.toml
  ```
- Linting:
  ```bash
  cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
  ```

## Pull Requests

1. Create a branch from `main`
2. Make small, focused commits
3. Before pushing, ensure:
   - `bun run check` passes
   - `bunx prettier --check "src/**/*.{svelte,ts,js,css,html}"` passes
   - `cargo fmt --check --manifest-path src-tauri/Cargo.toml` passes
   - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passes
4. Include a summary of changes in the PR description
5. One feature or bugfix per PR

## Database Migrations

- Create new migrations under `src-tauri/migrations/NNNN/`
- Always create a corresponding rollback migration under `NNNN_down/`
- Migrations run automatically on app startup
