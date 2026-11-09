import { DEFAULT_ASSUMPTIONS, type Facts } from "$lib/advisor/calc";

/** Shared advisor fixture: a year of history, open items, recurring entries. */
const history = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, "0")}`,
  revenueGrossCents: 11900_00,
  revenueTaxCents: 1900_00,
  costGrossCents: 5950_00,
  costTaxCents: 950_00,
})).slice(0, 10); // Jan..Oct

export const facts: Facts = {
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
