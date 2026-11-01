// Cloud connectivity as seen by the app. `request()` in cloud.ts sets
// `offline` when fetch itself fails (no network / server unreachable) and
// clears it on the next successful response; the shell renders one global
// bar instead of a toast per failed call. Local mode never touches it.
export const net = $state({
  offline: typeof navigator !== "undefined" ? !navigator.onLine : false,
});

if (typeof window !== "undefined") {
  window.addEventListener("online", () => (net.offline = false));
  window.addEventListener("offline", () => (net.offline = true));
}
