// Shared open-state for the global command palette (⌘K). Lives in a
// `.svelte.ts` module so the palette component and any trigger button (e.g.
// the sidebar search affordance) read and toggle the same rune-backed state
// without prop-drilling or legacy stores.
let _open = $state(false);

export const commandPalette = {
  get open(): boolean {
    return _open;
  },
  set open(value: boolean) {
    _open = value;
  },
  toggle(): void {
    _open = !_open;
  },
};
