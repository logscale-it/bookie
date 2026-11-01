import { expect, test } from "bun:test";
import { spanMinutes } from "../src/lib/timespan";

test("same-day span subtracts the pause", () => {
  expect(spanMinutes(8 * 60, 17 * 60, 60)).toBe(480);
});

test("overnight span treats end as the next day", () => {
  expect(spanMinutes(23 * 60, 3 * 60, 30)).toBe(210);
});

test("ending exactly at midnight", () => {
  expect(spanMinutes(22 * 60, 0, 0)).toBe(120);
});

test("equal times are zero hours, not a 24h day", () => {
  expect(spanMinutes(22 * 60, 22 * 60, 0)).toBe(0);
});
