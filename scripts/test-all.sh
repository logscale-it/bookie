#!/usr/bin/env bash
# scripts/test-all.sh
#
# Runs the seven CI checks listed in CLAUDE.md in order.
# Exits non-zero on the first failure and prints which check failed.
#
# Usage: ./scripts/test-all.sh
#   (must be run from the repo root)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

run_check() {
    local step="$1"
    local total="$2"
    local name="$3"
    shift 3
    echo ""
    echo "▶ [${step}/${total}] ${name}"
    if ! "$@"; then
        echo ""
        echo "FAILED: [${step}/${total}] ${name}"
        exit 1
    fi
}

TOTAL=7

run_check 1 "$TOTAL" "bun run check" \
    bun run check

run_check 2 "$TOTAL" "bun test" \
    bun test

run_check 3 "$TOTAL" "cargo fmt --check" \
    cargo fmt --check --manifest-path src-tauri/Cargo.toml

run_check 4 "$TOTAL" "cargo clippy" \
    cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

run_check 5 "$TOTAL" "cargo test" \
    cargo test --manifest-path src-tauri/Cargo.toml

run_check 6 "$TOTAL" "cargo audit" \
    bash -c 'cd "$1" && cargo audit --deny warnings' -- "$REPO_ROOT/src-tauri"

run_check 7 "$TOTAL" "bun audit" \
    bun audit --audit-level=high

echo ""
echo "All ${TOTAL} checks passed."
