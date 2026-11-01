// Single-key page shortcuts (e.g. `n` = new) must not fire while typing or
// while a modal / the command palette is open.
export function isPlainKey(e: KeyboardEvent, key: string): boolean {
  if (e.key.toLowerCase() !== key || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, select, [contenteditable=true]")) return false;
  return !document.querySelector("dialog[open], [role=dialog]");
}

/** ⌘S / Ctrl+S. */
export const isSaveKey = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
