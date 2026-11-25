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
  expect(t.sent).toContain("revenueEur: 100");
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
  expect(t.sent).toContain("revenueEur: 250");
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

test("encode: lines, nesting, tables, quoting", async () => {
  const { encode } = await import("$lib/chat/prompt");
  expect(
    encode({
      page: "Übersicht 2026",
      total: 12.5,
      filter: { customer: null, project: "A, B" },
      tags: ["x", "y"],
      skip: undefined,
      rows: [
        { name: "ACME GmbH", hours: 3, billable: true },
        { name: "Foo: Bar", hours: 1.5, billable: false },
      ],
      odd: [{ a: 1 }, { b: [2] }],
      none: [],
    }),
  ).toBe(
    [
      "page: Übersicht 2026",
      "total: 12.5",
      "filter:",
      "  customer: null",
      '  project: "A, B"',
      "tags[2]: x,y",
      "rows[2]{name,hours,billable}:",
      "  ACME GmbH,3,true",
      '  "Foo: Bar",1.5,false',
      "odd[2]:",
      '  - {"a":1}',
      '  - {"b":[2]}',
      "none[0]: ",
    ].join("\n"),
  );
});
