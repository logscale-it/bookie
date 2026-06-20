// Theme switcher: light / dark / follow-OS. Toggling `.dark` on <html> drives
// Tailwind's class-based `dark:` variant (see app.css). The choice persists in
// localStorage; "system" tracks the OS preference live.
export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "bookie-theme";

let _theme = $state<Theme>("system");

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function apply(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export const theme = {
  get value(): Theme {
    return _theme;
  },
  set(next: Theme): void {
    _theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // private mode / storage disabled — the in-memory choice still applies.
    }
    apply(next);
  },
  /** Cycle light → dark → system → light. */
  cycle(): void {
    theme.set(_theme === "light" ? "dark" : _theme === "dark" ? "system" : "light");
  },
  /** Call once on app start (client-side) to seed from storage + OS. */
  init(): void {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    _theme = stored ?? "system";
    apply(_theme);
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (_theme === "system") apply("system");
      });
  },
};
