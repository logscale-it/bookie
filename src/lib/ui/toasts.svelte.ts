// Lightweight global toast notifications. A single `<Toaster />` (mounted in
// the root layout) renders the stack; anywhere in the app calls
// `toasts.success(...)` / `.error(...)` / `.info(...)`. Rune-backed so it needs
// no legacy store. Errors stick around longer and successes auto-dismiss.
export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let _items = $state<Toast[]>([]);
let _seq = 0;

export const toasts = {
  get items(): Toast[] {
    return _items;
  },
  show(kind: ToastKind, message: string, timeoutMs = 4500): number {
    const id = ++_seq;
    _items = [..._items, { id, kind, message }];
    if (timeoutMs > 0) {
      setTimeout(() => toasts.dismiss(id), timeoutMs);
    }
    return id;
  },
  success(message: string, timeoutMs?: number): number {
    return toasts.show("success", message, timeoutMs);
  },
  error(message: string, timeoutMs = 7000): number {
    return toasts.show("error", message, timeoutMs);
  },
  info(message: string, timeoutMs?: number): number {
    return toasts.show("info", message, timeoutMs);
  },
  dismiss(id: number): void {
    _items = _items.filter((toast) => toast.id !== id);
  },
};
