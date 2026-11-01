// Undo instead of confirm(): hide the row now, run the real delete after the
// toast's lifetime unless the user clicks "Rückgängig". Works for local and
// cloud alike because nothing is deleted until the timer fires.
// ponytail: if the app quits inside the window the delete simply never
// happens (safe direction); add a beforeunload flush if that ever matters.
import { toasts } from "./toasts.svelte";

const UNDO_MS = 5000;

export function deferDelete(opts: {
  message: string;
  /** Hide the item optimistically (e.g. filter it out of the list). */
  hide: () => void;
  /** Put the item back after undo or when the delete fails. */
  restore: () => void;
  /** The real delete. */
  run: () => Promise<unknown>;
  onDone?: () => void;
  /** Error toast text when `run` fails. */
  errorMessage?: string;
}): void {
  opts.hide();
  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    try {
      await opts.run();
      opts.onDone?.();
    } catch (e) {
      opts.restore();
      toasts.error(
        `${opts.errorMessage ?? "Löschen fehlgeschlagen"}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, UNDO_MS);
  toasts.info(opts.message, UNDO_MS, {
    label: "Rückgängig",
    run: () => {
      undone = true;
      clearTimeout(timer);
      opts.restore();
    },
  });
}
