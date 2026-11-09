import { expect, test } from "bun:test";
import {
  DEFAULT_ASSUMPTIONS,
  affordability,
  annuity,
  forecast,
  investment,
  irr,
  metrics,
  npv,
  payback,
  recommendations,
  rentOrBuy,
  runDates,
  type Facts,
} from "$lib/advisor/calc";

const history = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, "0")}`,
  revenueGrossCents: 11900_00,
  revenueTaxCents: 1900_00,
  costGrossCents: 5950_00,
  costTaxCents: 950_00,
})).slice(0, 10); // Jan..Oct

const facts: Facts = {
  today: "2026-11-07",
  receivables: [
    {
      id: 1,
      number: "R-1",
      customer: "ACME",
      grossCents: 5000_00,
      issueDate: "2026-10-20",
      dueDate: "2026-11-03",
    }, // 4 days overdue
    {
      id: 2,
      number: "R-2",
      customer: "Beta",
      grossCents: 3000_00,
      issueDate: "2026-11-05",
      dueDate: "2026-12-05",
    },
    {
      id: 3,
      number: "R-3",
      customer: "ACME",
      grossCents: 2000_00,
      issueDate: "2026-05-01",
      dueDate: "2026-05-15",
    }, // > 120 days: 0 %
  ],
  payables: [
    {
      id: 1,
      supplier: "Hoster",
      grossCents: 800_00,
      invoiceDate: "2026-11-01",
    },
  ],
  recurring: [
    {
      kind: "incoming",
      label: "Miete",
      grossCents: 1200_00,
      frequency: "monthly",
      intervalCount: 1,
      nextRunDate: "2026-12-01",
      endDate: null,
    },
    {
      kind: "invoice",
      label: "Wartung",
      grossCents: 1190_00,
      frequency: "monthly",
      intervalCount: 1,
      nextRunDate: "2026-11-15",
      endDate: null,
    },
  ],
  unbilledCents: 1000_00,
  history,
  paid: [
    {
      customer: "ACME",
      grossCents: 10000_00,
      issueDate: "2026-09-01",
      dueDate: "2026-09-15",
      paidDate: "2026-09-25",
    },
    {
      customer: "Beta",
      grossCents: 2000_00,
      issueDate: "2026-08-01",
      dueDate: "2026-08-15",
      paidDate: "2026-08-10",
    },
  ],
  profitYtdCents: 50000_00,
  assumptions: {
    ...DEFAULT_ASSUMPTIONS,
    cashCents: 40000_00,
    taxPrepaymentCents: 2000_00,
  },
};

test("metrics: DSO, delay, concentration, tax reserve", () => {
  const m = metrics(facts);
  expect(m.dsoDays).toBe(17); // (24 + 9) / 2
  expect(m.avgDelayDays).toBe(5); // (10 + 0) / 2
  expect(m.topCustomers[0]).toMatchObject({ name: "ACME" });
  expect(m.topCustomers[0].shareOfRevenue).toBeCloseTo(17000 / 22000, 3);
  expect(m.overdueCount).toBe(2);
  expect(m.doubtfulCents).toBe(2000_00);
  // 30 % of 50 000 minus 3 elapsed quarters × 2 000
  expect(m.taxReserveCents).toBe(15000_00 - 6000_00);
  expect(m.bufferCents).toBe(2 * 5950_00);
  expect(m.runwayMonths).toBeNull();
});

test("forecast: receivables land by due date + delay, haircut applied, taxes on schedule", () => {
  const fc = forecast(facts, 6, false);
  expect(fc.months.map((m) => m.month)).toEqual([
    "2026-11",
    "2026-12",
    "2027-01",
    "2027-02",
    "2027-03",
    "2027-04",
  ]);
  // R-1 overdue → today + 14 (Nov), R-2 due 5.12. + 5 delay (Dec), R-3 at 0 %
  expect(fc.months[0].in.receivables).toBe(5000_00);
  expect(fc.months[1].in.receivables).toBe(3000_00);
  expect(fc.haircutCents).toBe(2000_00);
  expect(fc.months[0].out.payables).toBe(800_00);
  // Wartung run 15.11. paid +14 +5 → Dec; Miete from Dec
  expect(fc.months[1].in.recurring).toBe(1190_00);
  expect(fc.months[0].out.recurring).toBe(0);
  expect(fc.months[1].out.recurring).toBe(1200_00);
  // quarterly VAT in Jan/Apr (3 × 950), income tax prepayment in Dec/Mar
  expect(fc.months[2].out.vat).toBe(3 * 950_00);
  expect(fc.months[0].out.vat).toBe(0);
  expect(fc.months[1].out.incomeTax).toBe(2000_00);
  expect(fc.months[0].in.unbilled).toBe(1000_00); // today + 14 + 5 days
  expect(fc.months[0].openingCents).toBe(40000_00);
  expect(fc.months[0].closingCents).toBe(40000_00 + 5000_00 + 1000_00 - 800_00);
  // trend mode adds average revenue from month 2 and costs from month 1
  const t = forecast(facts, 6, true);
  expect(t.months[0].in.trend).toBe(0);
  expect(t.months[1].in.trend).toBe(11900_00 - 1190_00);
  expect(t.months[0].out.trend).toBe(5950_00 - 1200_00 - 800_00);
});

test("affordability verdicts move with the amount", () => {
  expect(affordability(facts, 1000_00).verdict).toBe("ja");
  expect(affordability(facts, 1_000_000_00).verdict).toBe("nein");
  const a = affordability(facts, 1000_00);
  expect(affordability(facts, a.maxAffordableCents).verdict).toBe("ja");
  expect(affordability(facts, a.maxAffordableCents + 100).verdict).toBe(
    "knapp",
  );
});

test("npv / irr / annuity / payback", () => {
  expect(npv(0.1, [-100, 110])).toBeCloseTo(0, 9);
  expect(irr([-100, 60, 60])!).toBeCloseTo(0.1307, 3);
  expect(irr([100, 10])).toBeNull();
  expect(annuity(1000, 0, 4)).toBe(250);
  expect(annuity(1000, 0.05, 2)).toBeCloseTo(537.8, 1);
  expect(payback([-100, 40, 40, 40])).toBeCloseTo(2.5, 6);
  expect(payback([-100, 10])).toBeNull();
});

test("investment: positive NPV recommends, metrics consistent", () => {
  const r = investment({
    costCents: 10000_00,
    annualGainCents: 3500_00,
    years: 5,
    residualCents: 0,
    rateAnnual: 0.06,
  });
  expect(r.recommended).toBe(true);
  expect(Math.abs(r.npvCents - 4743_27)).toBeLessThan(100); // 3 500 × 4,2124 − 10 000
  expect(r.irrAnnual!).toBeCloseTo(0.2215, 2);
  expect(r.paybackYears!).toBeCloseTo(2.857, 2);
  expect(r.roiAnnual).toBeCloseTo((3500 - 2000) / 5000, 6);
  expect(
    investment({
      costCents: 10000_00,
      annualGainCents: 1000_00,
      years: 3,
      residualCents: 0,
      rateAnnual: 0.06,
    }).recommended,
  ).toBe(false);
});

test("rentOrBuy: cheap rent for short use, buy for long use, GWG flag", () => {
  const base = {
    priceCents: 2400_00,
    usefulLifeMonths: 36,
    residualCents: 400_00,
    rentPerMonthCents: 90_00,
    rateAnnual: 0.06,
    taxRate: 0.3,
  };
  const short = rentOrBuy({ ...base, horizonMonths: 6 });
  const long = rentOrBuy({ ...base, horizonMonths: 36 });
  expect(short.recommendation).toBe("mieten");
  expect(long.recommendation).toBe("kaufen");
  expect(long.breakEvenMonths).toBeGreaterThan(6);
  expect(long.breakEvenMonths).toBeLessThanOrEqual(36);
  expect(short.gwg).toBe(false);
  expect(
    rentOrBuy({ ...base, priceCents: 700_00, horizonMonths: 12 }).gwg,
  ).toBe(true);
});

test("runDates respects end date and window", () => {
  const r = {
    kind: "incoming" as const,
    label: "",
    grossCents: 1,
    frequency: "monthly" as const,
    intervalCount: 1,
    nextRunDate: "2026-11-15",
    endDate: "2027-01-31",
  };
  expect(runDates(r, "2026-12-01", "2027-06-30")).toEqual([
    "2026-12-15",
    "2027-01-15",
  ]);
});

test("recommendations flag overdue, doubtful, unbilled, concentration", () => {
  const texts = recommendations(facts).map((r) => r.text);
  expect(texts.some((t) => t.includes("überfällige Rechnung"))).toBe(true);
  expect(texts.some((t) => t.includes("120 Tage"))).toBe(true);
  expect(texts.some((t) => t.includes("nicht abgerechnete"))).toBe(true);
  expect(texts.some((t) => t.includes("Klumpenrisiko"))).toBe(true);
});
