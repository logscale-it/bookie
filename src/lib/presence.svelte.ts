// Cloud presence: who else of the active company has bookie open, and where,
// plus a revision of what the others changed (`rev`, server-side per grant).
// <Presence /> starts the heartbeat (POST /api/presence every 15s and on route
// change, paused while the window is hidden); the server forgets a member
// after 45s without one. Local mode: never calls out, `peers` stays empty.

import { api, cloud } from "$lib/cloud";

export type Peer = { userId: number; name: string; path: string };

export const presence = $state({
  peers: [] as Peer[],
  /** Latest revision of others' changes; `seen` is what the open page shows. */
  rev: "",
  seen: "",
  /** Bumped by refresh(); the layout keys the page on it so it reloads its data. */
  reload: 0,
});

/** Someone else changed something since this page loaded. */
export const hasChanges = () => presence.seen !== "" && presence.rev !== presence.seen;

let path = "/";

export async function beat(p = path): Promise<void> {
  if (p !== path) presence.seen = presence.rev; // a new page loads fresh data
  path = p;
  if (!cloud() || document.hidden) return;
  try {
    const r = await api<{ peers: Peer[]; rev: string }>("/api/presence", "POST", { path });
    presence.peers = r.peers;
    presence.rev = r.rev;
    if (presence.seen === "") presence.seen = r.rev;
  } catch {
    presence.peers = []; // offline / unpaid: show nobody rather than stale faces
  }
}

/** Remount the open page so it loads the others' changes. */
export function refresh(): void {
  presence.seen = presence.rev;
  presence.reload++;
}

/** Starts the 15s heartbeat; returns the stop function (an $effect cleanup). */
export function startPresence(): () => void {
  const timer = setInterval(() => void beat(), 15_000);
  const onVisible = () => {
    if (!document.hidden) void beat();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    presence.peers = [];
    presence.rev = presence.seen = "";
  };
}
