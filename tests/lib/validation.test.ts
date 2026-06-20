import { test, expect, describe } from "bun:test";
import {
  isValidIban,
  isValidVatId,
  formatIban,
  normalizeIban,
} from "../../src/lib/validation";

describe("isValidIban", () => {
  test("accepts valid IBANs (with and without spaces)", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("FR1420041010050500013M02606")).toBe(true);
  });

  test("rejects bad checksums and malformed input", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 01")).toBe(false); // wrong check digits
    expect(isValidIban("DE00 0000")).toBe(false); // too short
    expect(isValidIban("1234567890")).toBe(false); // no country prefix
    expect(isValidIban("")).toBe(false);
  });
});

describe("isValidVatId", () => {
  test("German USt-IdNr must be DE + 9 digits", () => {
    expect(isValidVatId("DE123456789")).toBe(true);
    expect(isValidVatId("DE 123 456 789")).toBe(true);
    expect(isValidVatId("de123456789")).toBe(true);
    expect(isValidVatId("DE12345678")).toBe(false); // 8 digits
    expect(isValidVatId("DE1234567890")).toBe(false); // 10 digits
    expect(isValidVatId("AT123456789")).toBe(false); // wrong country for DE check
  });

  test("other countries get a structural check", () => {
    expect(isValidVatId("ATU12345678", "AT")).toBe(true);
    expect(isValidVatId("12345", "AT")).toBe(false);
  });
});

describe("formatIban / normalizeIban", () => {
  test("normalize strips spaces and uppercases", () => {
    expect(normalizeIban(" de89 3704 ")).toBe("DE893704");
  });
  test("format groups into blocks of four", () => {
    expect(formatIban("DE89370400440532013000")).toBe(
      "DE89 3704 0044 0532 0130 00",
    );
  });
});
