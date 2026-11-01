import { afterAll, expect, test } from "bun:test";
import { CloudError, resource } from "$lib/cloud";
import { net } from "$lib/net.svelte";
import { toasts } from "$lib/ui/toasts.svelte";

const saved = { localStorage: (globalThis as any).localStorage, fetch: globalThis.fetch };
afterAll(() => Object.assign(globalThis, saved));
(globalThis as any).localStorage = {
  getItem: () => JSON.stringify({ url: "http://s", token: "t", email: "e" }),
  removeItem: () => {},
};
let reply: (path: string, init: RequestInit) => Response;
const bodies: any[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (init.body) bodies.push(JSON.parse(String(init.body)));
  return reply(url.slice("http://s".length), init);
}) as any;
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("fetch failure sets net.offline and throws a friendly CloudError; a response clears it", async () => {
  reply = () => { throw new TypeError("Failed to fetch"); };
  const err = await resource("customers").list().catch((e) => e);
  expect(err).toBeInstanceOf(CloudError);
  expect(err.message).toBe("Keine Verbindung zum bookie Server");
  expect(net.offline).toBe(true);
  reply = () => ok([]);
  await resource("customers").list();
  expect(net.offline).toBe(false);
});

test("update echoes the loaded updated_at; a 409 conflict throws and toasts with reload", async () => {
  const r = resource("customers");
  reply = () => ok([{ id: 7, updated_at: "2026-11-01 10:00:00" }]);
  await r.list();
  reply = () => ok({ id: 7, updated_at: "2026-11-01T10:05:00.000Z" });
  await r.update(7, { city: "Köln" });
  expect(bodies.at(-1)).toEqual({ city: "Köln", expected_updated_at: "2026-11-01 10:00:00" });
  reply = () => ok({ error: "conflict", current: { id: 7 } }, 409);
  const err = await r.update(7, { city: "Bonn" }).catch((e) => e);
  expect(bodies.at(-1).expected_updated_at).toBe("2026-11-01T10:05:00.000Z"); // the PATCH response refreshed it
  expect([err.code, err.message]).toEqual(["conflict", "Wurde zwischenzeitlich von jemand anderem geändert"]);
  expect(toasts.items.at(-1)).toMatchObject({ kind: "error", action: { label: "Neu laden" } });
  // Never loaded: no expectation, last write wins.
  reply = () => ok({ id: 8 });
  await r.update(8, { city: "Ulm" });
  expect(bodies.at(-1)).toEqual({ city: "Ulm" });
});
