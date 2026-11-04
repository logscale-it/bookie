// Bun runs .svelte.ts modules uncompiled: give module-level runes a plain-value
// stand-in so lib code that imports net/toasts state loads in tests.
const g = globalThis as Record<string, unknown>;
g.$state ??= (v?: unknown) => v;
