// Lightweight global toast notifications. A single `<Toaster />` (mounted in
// the root layout) renders the stack; anywhere in the app calls
// `toasts.success(...)` / `.error(...)` / `.info(...)`. Rune-backed so it needs
// no legacy store. Errors stick around longer and successes auto-dismiss.
// Timers pause while the pointer is over the stack (`pause()` / `resume()`).
export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** Total lifetime in ms (0 = sticky); drives the progress bar. */
  timeoutMs: number;
}

let _items = $state<Toast[]>([]);
let _paused = $state(false);
let _seq = 0;
// Remaining lifetime per toast; timers are re-armed on resume().
const remaining = new Map<number, { left: number; started: number; timer?: ReturnType<typeof setTimeout> }>();

function arm(id: number) {
  const r = remaining.get(id);
  if (!r) return;
  r.started = Date.now();
  r.timer = setTimeout(() => toasts.dismiss(id), r.left);
}

export const toasts = {
  get items(): Toast[] {
    return _items;
  },
  get paused(): boolean {
    return _paused;
  },
  show(
    kind: ToastKind,
    message: string,
    timeoutMs = 4500,
    action?: ToastAction,
  ): number {
    const id = ++_seq;
    _items = [..._items, { id, kind, message, action, timeoutMs }];
    if (timeoutMs > 0) {
      remaining.set(id, { left: timeoutMs, started: Date.now() });
      if (!_paused) arm(id);
    }
    return id;
  },
  success(message: string, timeoutMs?: number, action?: ToastAction): number {
    return toasts.show("success", message, timeoutMs, action);
  },
  error(message: string, timeoutMs = 7000, action?: ToastAction): number {
    return toasts.show("error", message, timeoutMs, action);
  },
  info(message: string, timeoutMs?: number, action?: ToastAction): number {
    return toasts.show("info", message, timeoutMs, action);
  },
  dismiss(id: number): void {
    const r = remaining.get(id);
    if (r?.timer) clearTimeout(r.timer);
    remaining.delete(id);
    _items = _items.filter((toast) => toast.id !== id);
  },
  pause(): void {
    if (_paused) return;
    _paused = true;
    for (const r of remaining.values()) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = undefined;
      r.left = Math.max(0, r.left - (Date.now() - r.started));
    }
  },
  resume(): void {
    if (!_paused) return;
    _paused = false;
    for (const id of remaining.keys()) arm(id);
  },
};
