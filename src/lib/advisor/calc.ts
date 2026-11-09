// Finanzberater: pure betriebswirtschaftliche Rechnungen. Cents in, cents out,
// no I/O, no dates from the clock (callers pass `today`). Everything here is
// deterministic so the AI layer (prompt.ts) only has to explain numbers, never
// compute them.

import { advance } from "$lib/recurrence";
import type { Frequency } from "$lib/recurrence";
import { getLocaleFormatting, t, tp } from "$lib/i18n";

// ---------------------------------------------------------------- facts ---

export interface Receivable {
  id: number;
  number: string;
  customer: string | null;
  grossCents: number;
  issueDate: string;
  dueDate: string | null;
}
export interface Payable {
  id: number;
  supplier: string | null;
  grossCents: number;
  invoiceDate: string;
}
export interface RecurringFact {
  kind: "invoice" | "incoming";
  label: string;
  grossCents: number;
  frequency: Frequency;
  intervalCount: number;
  nextRunDate: string;
  endDate: string | null;
}
export interface MonthHistory {
  month: string; // YYYY-MM
  revenueGrossCents: number;
  revenueTaxCents: number;
  costGrossCents: number;
  costTaxCents: number;
}
export interface PaidInvoice {
  customer: string | null;
  grossCents: number;
  issueDate: string;
  dueDate: string | null;
  paidDate: string;
}

/** User-maintained assumptions (localStorage; nothing in the data knows the bank balance). */
export interface Assumptions {
  cashCents: number;
  /** Combined ESt/KSt+GewSt(+Soli) rate on profit, 0..1. */
  incomeTaxRate: number;
  /** Quarterly prepayment already fixed by the Finanzamt (Vorauszahlungsbescheid). */
  taxPrepaymentCents: number;
  /** Liquidity buffer in months of average costs. */
  bufferMonths: number;
  vatPeriod: "month" | "quarter";
  /** Default payment term when an invoice has no due date. */
  paymentTermDays: number;
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  cashCents: 0,
  incomeTaxRate: 0.3,
  taxPrepaymentCents: 0,
  bufferMonths: 2,
  vatPeriod: "quarter",
  paymentTermDays: 14,
};

export interface Facts {
  today: string;
  receivables: Receivable[]; // status 'sent'
  payables: Payable[]; // status 'offen'
  recurring: RecurringFact[]; // active schedules
  /** Billable time not yet on any invoice, priced at the project rate (gross). null = unknown (cloud). */
  unbilledCents: number | null;
  history: MonthHistory[]; // trailing 12 months, by invoice date
  paid: PaidInvoice[]; // trailing 12 months
  profitYtdCents: number; // EÜR Jan 1 .. today
  assumptions: Assumptions;
}

// ------------------------------------------------------------- helpers ---

export const monthOf = (day: string) => day.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export const monthDiff = (a: string, b: string) => {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}
const avg = (xs: number[]) =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// ------------------------------------------------------------- metrics ---

export interface Metrics {
  /** Days sales outstanding: issue → payment, trailing 12 months. */
  dsoDays: number;
  /** Average days paid after due date (0 when customers pay on time). */
  avgDelayDays: number;
  avgRevenueGrossCents: number; // per month, trailing 6
  avgCostGrossCents: number;
  avgVatPayableCents: number; // per month, trailing 6, may be negative (Erstattung)
  topCustomers: { name: string; shareOfRevenue: number; grossCents: number }[];
  overdueCents: number;
  overdueCount: number;
  /** Months until cash hits 0 at the trailing net burn; null = cash-positive. */
  runwayMonths: number | null;
  /** Profit × tax rate − prepayments already made this year. */
  taxReserveCents: number;
  bufferCents: number;
  /** Gross receivables > 120 days past due: planned at 0 % in the forecast. */
  doubtfulCents: number;
}

export function metrics(f: Facts): Metrics {
  const last6 = f.history.slice(-6);
  const avgRevenueGrossCents = Math.round(
    avg(last6.map((h) => h.revenueGrossCents)),
  );
  const avgCostGrossCents = Math.round(avg(last6.map((h) => h.costGrossCents)));
  const avgVatPayableCents = Math.round(
    avg(last6.map((h) => h.revenueTaxCents - h.costTaxCents)),
  );

  const dso = f.paid
    .map((p) => daysBetween(p.issueDate, p.paidDate))
    .filter((d) => d >= 0);
  const delays = f.paid
    .filter((p) => p.dueDate)
    .map((p) => Math.max(0, daysBetween(p.dueDate!, p.paidDate)));

  const byCustomer = new Map<string, number>();
  const revenue12 =
    sum(f.paid.map((p) => p.grossCents)) +
    sum(f.receivables.map((r) => r.grossCents));
  for (const p of [...f.paid, ...f.receivables]) {
    const k = p.customer ?? "(ohne Kunde)";
    byCustomer.set(k, (byCustomer.get(k) ?? 0) + p.grossCents);
  }
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, grossCents]) => ({
      name,
      grossCents,
      shareOfRevenue: revenue12 ? grossCents / revenue12 : 0,
    }));

  const overdue = f.receivables.filter((r) => r.dueDate && r.dueDate < f.today);
  const doubtful = overdue.filter(
    (r) => daysBetween(r.dueDate!, f.today) > 120,
  );
  const burn = avgCostGrossCents - avgRevenueGrossCents;
  const a = f.assumptions;
  const quartersElapsed = Math.floor(Number(f.today.slice(5, 7)) / 3);
  return {
    dsoDays: Math.round(avg(dso)),
    avgDelayDays: Math.round(avg(delays)),
    avgRevenueGrossCents,
    avgCostGrossCents,
    avgVatPayableCents,
    topCustomers,
    overdueCents: sum(overdue.map((r) => r.grossCents)),
    overdueCount: overdue.length,
    runwayMonths:
      burn > 0 && a.cashCents > 0
        ? Math.floor(a.cashCents / burn)
        : burn > 0
          ? 0
          : null,
    taxReserveCents: Math.max(
      0,
      Math.round(f.profitYtdCents * a.incomeTaxRate) -
        quartersElapsed * a.taxPrepaymentCents,
    ),
    bufferCents: Math.round(avgCostGrossCents * a.bufferMonths),
    doubtfulCents: sum(doubtful.map((r) => r.grossCents)),
  };
}

// ------------------------------------------------------------ forecast ---

export interface ForecastMonth {
  month: string;
  openingCents: number;
  in: {
    receivables: number;
    recurring: number;
    unbilled: number;
    trend: number;
  };
  out: {
    payables: number;
    recurring: number;
    vat: number;
    incomeTax: number;
    trend: number;
  };
  closingCents: number;
}
export interface Forecast {
  months: ForecastMonth[];
  minClosingCents: number;
  minMonth: string;
  /** Receivables planned at a haircut (60–120 days overdue: 50 %, older: 0 %). */
  haircutCents: number;
}

/** Planned collection date and probability of one open invoice. */
export function expectedPayment(
  r: Receivable,
  f: Facts,
  m: Metrics,
): { day: string; weight: number } {
  const due = r.dueDate ?? addDays(r.issueDate, f.assumptions.paymentTermDays);
  const late = daysBetween(due, f.today);
  const weight = late > 120 ? 0 : late > 60 ? 0.5 : 1;
  const planned = addDays(due, m.avgDelayDays);
  return { day: planned < f.today ? addDays(f.today, 14) : planned, weight };
}

/** Run dates of a schedule inside [from, to]. */
export function runDates(r: RecurringFact, from: string, to: string): string[] {
  const out: string[] = [];
  let d = r.nextRunDate;
  for (let i = 0; i < 400 && d <= to; i++) {
    if (r.endDate && d > r.endDate) break;
    if (d >= from) out.push(d);
    d = advance(d, r.frequency, r.intervalCount);
  }
  return out;
}

/**
 * Monthly liquidity plan from today. `trend` adds the trailing-average
 * revenue/costs that are not yet on an invoice (minus recurring, which is
 * planned explicitly) so months further out do not read as zero.
 */
export function forecast(f: Facts, horizon = 6, trend = true): Forecast {
  const m = metrics(f);
  const a = f.assumptions;
  const start = monthOf(f.today);
  const end = addDays(`${addMonths(start, horizon)}-01`, -1);
  const months: ForecastMonth[] = Array.from({ length: horizon }, (_, i) => ({
    month: addMonths(start, i),
    openingCents: 0,
    in: { receivables: 0, recurring: 0, unbilled: 0, trend: 0 },
    out: { payables: 0, recurring: 0, vat: 0, incomeTax: 0, trend: 0 },
    closingCents: 0,
  }));
  const at = (day: string) =>
    months[Math.min(horizon - 1, Math.max(0, monthDiff(start, monthOf(day))))];

  let haircut = 0;
  for (const r of f.receivables) {
    const { day, weight } = expectedPayment(r, f, m);
    at(day).in.receivables += Math.round(r.grossCents * weight);
    haircut += r.grossCents - Math.round(r.grossCents * weight);
  }
  for (const p of f.payables) months[0].out.payables += p.grossCents;
  if (f.unbilledCents)
    at(addDays(f.today, a.paymentTermDays + m.avgDelayDays)).in.unbilled +=
      f.unbilledCents;

  let recurringInMonthly = 0;
  let recurringOutMonthly = 0;
  for (const r of f.recurring) {
    const dates = runDates(r, f.today, end);
    const perMonth = r.grossCents / (MONTHS[r.frequency] * r.intervalCount);
    if (r.kind === "invoice") {
      recurringInMonthly += perMonth;
      for (const d of dates)
        at(addDays(d, a.paymentTermDays + m.avgDelayDays)).in.recurring +=
          r.grossCents;
    } else {
      recurringOutMonthly += perMonth;
      for (const d of dates) at(d).out.recurring += r.grossCents;
    }
  }

  // Taxes: USt-Zahllast on the 10th after the period, ESt/KSt prepayments 10.3/6/9/12.
  for (const mo of months) {
    const mm = Number(mo.month.slice(5, 7));
    const vatDue = a.vatPeriod === "month" || mm % 3 === 1;
    if (vatDue && m.avgVatPayableCents > 0)
      mo.out.vat += m.avgVatPayableCents * (a.vatPeriod === "month" ? 1 : 3);
    if (mm % 3 === 0) mo.out.incomeTax += a.taxPrepaymentCents;
  }

  if (trend) {
    const trendIn = Math.max(0, m.avgRevenueGrossCents - recurringInMonthly);
    const trendOut = Math.max(0, m.avgCostGrossCents - recurringOutMonthly);
    months.forEach((mo, i) => {
      // Revenue not yet invoiced arrives with a lag; current-month costs are mostly already booked.
      if (i >= 1) mo.in.trend += Math.round(trendIn);
      mo.out.trend += Math.round(
        i === 0 ? Math.max(0, trendOut - mo.out.payables) : trendOut,
      );
    });
  }

  let cash = a.cashCents;
  let minClosing = Infinity;
  let minMonth = start;
  for (const mo of months) {
    mo.openingCents = cash;
    const inflow = sum(Object.values(mo.in));
    const outflow = sum(Object.values(mo.out));
    cash = Math.round(cash + inflow - outflow);
    mo.closingCents = cash;
    if (cash < minClosing) {
      minClosing = cash;
      minMonth = mo.month;
    }
  }
  return {
    months,
    minClosingCents: minClosing,
    minMonth,
    haircutCents: haircut,
  };
}

const MONTHS: Record<Frequency, number> = {
  weekly: 0.25,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

// ------------------------------------------------------- affordability ---

export type Verdict = "ja" | "knapp" | "nein";
export interface Affordability {
  verdict: Verdict;
  /** Cash left in the tightest month after the purchase, buffer and tax reserve. */
  headroomCents: number;
  tightestMonth: string;
  /** Largest one-off amount that still keeps buffer + reserve intact. */
  maxAffordableCents: number;
}

/** One-off purchase in month `atIndex`, or `installmentCents` per month from there on. */
export function affordability(
  f: Facts,
  amountCents: number,
  opts: { atIndex?: number; installmentCents?: number; horizon?: number } = {},
): Affordability {
  const m = metrics(f);
  const fc = forecast(f, opts.horizon ?? 6);
  const from = opts.atIndex ?? 0;
  const reserve = m.taxReserveCents + m.bufferCents;
  let worst = Infinity;
  let tightest = fc.months[from]?.month ?? fc.months[0].month;
  let base = Infinity;
  fc.months.forEach((mo, i) => {
    if (i < from) return;
    const spent = amountCents + (opts.installmentCents ?? 0) * (i - from + 1);
    const left = mo.closingCents - spent - reserve;
    base = Math.min(base, mo.closingCents - reserve);
    if (left < worst) {
      worst = left;
      tightest = mo.month;
    }
  });
  const verdict: Verdict =
    worst >= 0 ? "ja" : worst + m.bufferCents >= 0 ? "knapp" : "nein";
  return {
    verdict,
    headroomCents: worst,
    tightestMonth: tightest,
    maxAffordableCents: Math.max(0, base),
  };
}

// --------------------------------------------- Investitionsrechnung ---

/** Net present value; cashflows[0] is t=0 (usually negative), rate per period. */
export function npv(rate: number, cashflows: number[]): number {
  return cashflows.reduce((s, c, t) => s + c / Math.pow(1 + rate, t), 0);
}

/** Internal rate of return per period via bisection; null when no sign change. */
export function irr(cashflows: number[]): number | null {
  if (!cashflows.some((c) => c < 0) || !cashflows.some((c) => c > 0))
    return null;
  let lo = -0.99;
  let hi = 10;
  if (npv(lo, cashflows) * npv(hi, cashflows) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo, cashflows) * npv(mid, cashflows) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Constant payment that repays `principal` over `n` periods at `rate` per period. */
export function annuity(principal: number, rate: number, n: number): number {
  if (n <= 0) return 0;
  if (rate === 0) return principal / n;
  const q = Math.pow(1 + rate, n);
  return (principal * rate * q) / (q - 1);
}

/** Periods until cumulative cashflow turns ≥ 0; null if never. */
export function payback(cashflows: number[]): number | null {
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const before = cum;
    cum += cashflows[t];
    if (cum >= 0 && t > 0)
      return t - 1 + (cashflows[t] ? -before / cashflows[t] : 0);
  }
  return cum >= 0 ? 0 : null;
}

export interface InvestmentInput {
  costCents: number;
  /** Additional cash per year the investment brings (savings or revenue, after running costs). */
  annualGainCents: number;
  years: number;
  residualCents: number;
  /** Kalkulationszins, e.g. 0.06. */
  rateAnnual: number;
}
export interface InvestmentResult {
  npvCents: number;
  irrAnnual: number | null;
  paybackYears: number | null;
  /** Average annual profit (after linear depreciation) / average capital employed. */
  roiAnnual: number;
  annuityCents: number;
  cashflows: number[];
  recommended: boolean;
}

/** Kapitalwert, interner Zinsfuß, Amortisation, Rentabilität, Annuität in one go. */
export function investment(i: InvestmentInput): InvestmentResult {
  const n = Math.max(1, Math.round(i.years));
  const cashflows = [
    -i.costCents,
    ...Array.from(
      { length: n },
      (_, t) => i.annualGainCents + (t === n - 1 ? i.residualCents : 0),
    ),
  ];
  const npvCents = Math.round(npv(i.rateAnnual, cashflows));
  const depreciation = (i.costCents - i.residualCents) / n;
  const avgCapital = (i.costCents + i.residualCents) / 2;
  return {
    npvCents,
    irrAnnual: irr(cashflows),
    paybackYears: payback(cashflows),
    roiAnnual: avgCapital ? (i.annualGainCents - depreciation) / avgCapital : 0,
    annuityCents: Math.round(annuity(npvCents, i.rateAnnual, n)),
    cashflows,
    recommended: npvCents > 0,
  };
}

// ----------------------------------------------------- Mieten oder kaufen ---

export interface RentOrBuyInput {
  priceCents: number; // net purchase price
  usefulLifeMonths: number; // AfA period
  residualCents: number; // resale value at the end of the horizon
  rentPerMonthCents: number; // net
  horizonMonths: number; // how long it will be used
  rateAnnual: number; // Kalkulationszins / loan rate
  taxRate: number; // marginal income tax rate for the deduction effect
  /** Running costs the owner carries that the rent already includes (service, insurance). */
  ownerCostPerMonthCents?: number;
}
export interface RentOrBuyResult {
  buyNpvCents: number; // present value of all costs when buying (positive = cost)
  rentNpvCents: number;
  savingCents: number; // rentNpv − buyNpv; > 0 favours buying
  breakEvenMonths: number | null; // usage duration from which buying is cheaper
  gwg: boolean; // ≤ 800 € net: Sofortabschreibung
  recommendation: "kaufen" | "mieten" | "egal";
}

export const GWG_LIMIT_CENTS = 800_00;

/** Kapitalwertvergleich der Kosten incl. Steuereffekt (AfA linear bzw. GWG sofort; Miete sofort abziehbar). */
export function rentOrBuy(i: RentOrBuyInput): RentOrBuyResult {
  const r = Math.pow(1 + i.rateAnnual, 1 / 12) - 1; // monthly rate
  const H = Math.max(1, Math.round(i.horizonMonths));
  const gwg = i.priceCents <= GWG_LIMIT_CENTS;
  const costAt = (horizon: number) => {
    const pv = (c: number, t: number) => c / Math.pow(1 + r, t);
    // Buy: price now, running costs monthly, residual back, tax shield from depreciation.
    let buy = i.priceCents - pv(i.residualCents, horizon);
    for (let t = 1; t <= horizon; t++)
      buy += pv(i.ownerCostPerMonthCents ?? 0, t) * (1 - i.taxRate);
    if (gwg) buy -= i.priceCents * i.taxRate;
    else {
      const monthly = i.priceCents / Math.max(1, i.usefulLifeMonths);
      for (let t = 1; t <= Math.min(horizon, i.usefulLifeMonths); t++)
        buy -= pv(monthly * i.taxRate, t);
      // Book value not yet depreciated is deducted on sale (Restbuchwert − Erlös); gain taxed.
      const book = Math.max(
        0,
        i.priceCents - monthly * Math.min(horizon, i.usefulLifeMonths),
      );
      buy -= pv((book - i.residualCents) * i.taxRate, horizon);
    }
    let rent = 0;
    for (let t = 1; t <= horizon; t++)
      rent += pv(i.rentPerMonthCents * (1 - i.taxRate), t);
    return { buy, rent };
  };
  const { buy, rent } = costAt(H);
  let breakEvenMonths: number | null = null;
  for (let h = 1; h <= Math.max(H, i.usefulLifeMonths) * 2; h++) {
    const c = costAt(h);
    if (c.buy <= c.rent) {
      breakEvenMonths = h;
      break;
    }
  }
  const saving = Math.round(rent - buy);
  const tol = 0.03 * Math.max(buy, rent, 1);
  return {
    buyNpvCents: Math.round(buy),
    rentNpvCents: Math.round(rent),
    savingCents: saving,
    breakEvenMonths,
    gwg,
    recommendation:
      Math.abs(saving) <= tol ? "egal" : saving > 0 ? "kaufen" : "mieten",
  };
}

// ------------------------------------------------------ Empfehlungen ---

export interface Recommendation {
  severity: "bad" | "warn" | "info";
  text: string;
}

const eur = (c: number) =>
  (c / 100).toLocaleString(getLocaleFormatting(), {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

/** Rule-based Handlungsempfehlungen from the numbers; the AI gets these as context too. */
export function recommendations(
  f: Facts,
  m = metrics(f),
  fc = forecast(f),
): Recommendation[] {
  const out: Recommendation[] = [];
  const a = f.assumptions;
  if (fc.minClosingCents < 0)
    out.push({
      severity: "bad",
      text: tp("advisorCalc.liquidityGap", { month: fc.minMonth, amount: eur(fc.minClosingCents) }),
    });
  else if (fc.minClosingCents < m.bufferCents + m.taxReserveCents)
    out.push({
      severity: "warn",
      text: tp("advisorCalc.bufferShort", { month: fc.minMonth, amount: eur(fc.minClosingCents), buffer: eur(m.bufferCents), months: a.bufferMonths, reserve: eur(m.taxReserveCents) }),
    });
  if (m.taxReserveCents > a.cashCents)
    out.push({
      severity: "bad",
      text: tp("advisorCalc.taxReserveMissing", { profit: eur(f.profitYtdCents), reserve: eur(m.taxReserveCents), cash: eur(a.cashCents) }),
    });
  if (m.overdueCount)
    out.push({
      severity: m.overdueCents > m.avgCostGrossCents ? "bad" : "warn",
      text: tp("advisorCalc.overdue", { count: m.overdueCount, amount: eur(m.overdueCents) }),
    });
  if (m.doubtfulCents)
    out.push({
      severity: "warn",
      text: tp("advisorCalc.doubtful", { amount: eur(m.doubtfulCents) }),
    });
  if (f.unbilledCents)
    out.push({
      severity: "info",
      text: tp("advisorCalc.unbilled", { amount: eur(f.unbilledCents) }),
    });
  const top = m.topCustomers[0];
  if (top && top.shareOfRevenue > 0.5)
    out.push({
      severity: "warn",
      text: tp("advisorCalc.concentration", { name: top.name, share: Math.round(top.shareOfRevenue * 100), amount: eur(top.grossCents) }),
    });
  if (m.dsoDays > 45)
    out.push({
      severity: "info",
      text: tp("advisorCalc.slowPayers", { dso: m.dsoDays, delay: m.avgDelayDays }),
    });
  if (m.runwayMonths !== null)
    out.push({
      severity: m.runwayMonths < 6 ? "bad" : "warn",
      text: tp("advisorCalc.burn", { cost: eur(m.avgCostGrossCents), revenue: eur(m.avgRevenueGrossCents), months: m.runwayMonths }),
    });
  if (!out.length)
    out.push({
      severity: "info",
      text: t("advisorCalc.allGood"),
    });
  return out;
}
