/// <reference types="bun" />
import { test, expect } from "bun:test";
import { advance, addDays } from "../src/lib/recurrence";

test("weekly adds 7 days per count", () => {
  expect(advance("2026-01-01", "weekly", 1)).toBe("2026-01-08");
  expect(advance("2026-01-01", "weekly", 3)).toBe("2026-01-22");
});

test("monthly / quarterly / yearly step", () => {
  expect(advance("2026-01-15", "monthly", 1)).toBe("2026-02-15");
  expect(advance("2026-01-15", "quarterly", 1)).toBe("2026-04-15");
  expect(advance("2026-01-15", "yearly", 1)).toBe("2027-01-15");
});

test("month-end clamps instead of overflowing", () => {
  // Jan 31 + 1 month → Feb 28 (2026 is not a leap year), not Mar 03.
  expect(advance("2026-01-31", "monthly", 1)).toBe("2026-02-28");
  // Leap year keeps Feb 29.
  expect(advance("2024-01-31", "monthly", 1)).toBe("2024-02-29");
});

test("monthly rolls across year boundary", () => {
  expect(advance("2026-11-30", "monthly", 2)).toBe("2027-01-30");
});

test("addDays crosses month boundary", () => {
  expect(addDays("2026-01-20", 14)).toBe("2026-02-03");
});
