import { expect, test } from "bun:test";
import { toMessages, userTurn, type Turn } from "$lib/chat/prompt";

const ctx = (revenue: number) => ({
  page: "uebersicht",
  title: "Übersicht 2026",
  facts: { revenueEur: revenue },
});

test("first question carries the page data", () => {
  const t = userTurn(ctx(100), " Why? ", []);
  expect(t.text).toBe("Why?");
  expect(t.sent).toContain('"revenueEur":100');
  expect(t.sent).toContain("Question: Why?");
});

test("follow-up with unchanged data is sent as typed", () => {
  const first = userTurn(ctx(100), "a", []);
  const thread: Turn[] = [first, { role: "assistant", text: "x", sent: "x" }];
  expect(userTurn(ctx(100), "b", thread).sent).toBe("b");
});

test("changed data is re-attached", () => {
  const first = userTurn(ctx(100), "a", []);
  const t = userTurn(ctx(250), "b", [first]);
  expect(t.sent).toContain('"revenueEur":250');
});

test("no page data on the first question says so; later it stays quiet", () => {
  const first = userTurn(null, "a", []);
  expect(first.sent).toContain("No page data");
  expect(userTurn(null, "b", [first]).sent).toBe("b");
});

test("toMessages sends `sent`, not `text`", () => {
  const t = userTurn(ctx(1), "q", []);
  expect(toMessages([t])).toEqual([{ role: "user", content: t.sent }]);
});

test("valueCount counts leaves through nested objects and arrays", async () => {
  const { valueCount } = await import("$lib/chat/prompt");
  expect(valueCount({ a: 1, b: { c: 2, d: [3, 4] }, e: null })).toBe(5);
  expect(valueCount({})).toBe(0);
});
