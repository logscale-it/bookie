#!/usr/bin/env bash
# Symlinks .git/hooks/pre-push to scripts/test-all.sh. Idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_DIR="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"

if [[ -z "$GIT_DIR" ]]; then
  echo "✗ Not inside a git repository — skipping hook install."
  exit 0
fi

HOOKS_DIR="$GIT_DIR/hooks"
mkdir -p "$HOOKS_DIR"

HOOK="$HOOKS_DIR/pre-push"
TARGET="../../scripts/test-all.sh"

# Make the test script itself executable.
chmod +x "$ROOT/scripts/test-all.sh"

if [[ -L "$HOOK" ]] && [[ "$(readlink "$HOOK")" == "$TARGET" ]]; then
  echo "✓ pre-push hook already linked to scripts/test-all.sh"
  exit 0
fi

if [[ -e "$HOOK" ]]; then
  BACKUP="$HOOK.backup.$(date +%s)"
  echo "→ existing pre-push hook backed up to $BACKUP"
  mv "$HOOK" "$BACKUP"
fi

ln -s "$TARGET" "$HOOK"
chmod +x "$HOOK"
echo "✓ pre-push hook installed → scripts/test-all.sh"
