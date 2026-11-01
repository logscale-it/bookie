// Cloud presence: who else of the active company has bookie open, and where.
// <Presence /> starts the heartbeat (POST /api/presence every 15s and on route
// change, paused while the window is hidden); the server forgets a member
// after 45s without one. Local mode: never calls out, `peers` stays empty.

import { api, cloud } from "$lib/cloud";

export type Peer = { userId: number; name: string; path: string };

export const presence = $state({ peers: [] as Peer[] });

let path = "/";

export async function beat(p = path): Promise<void> {
  path = p;
  if (!cloud() || document.hidden) return;
  try {
    presence.peers = await api<Peer[]>("/api/presence", "POST", { path });
  } catch {
    presence.peers = []; // offline / unpaid: show nobody rather than stale faces
  }
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
  };
}
