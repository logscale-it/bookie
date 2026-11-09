// Finanzberater: what the model gets. The numbers are computed in calc.ts;
// the model explains, prioritises and answers the question against them.

import { forecast, metrics, recommendations, type Facts } from "./calc";

export const SYSTEM_PROMPT = `Du bist ein betriebswirtschaftlicher Berater für Selbstständige und kleine Unternehmen in Deutschland (Freiberufler, Agenturen, Handwerk, kleine GmbHs). Du bekommst die echten Zahlen aus der Buchhaltung des Nutzers als JSON und antwortest auf Deutsch.

Arbeitsweise:
- Rechne nicht neu, was im JSON steht; nutze die Werte und nenne sie konkret (Beträge in €, Monate).
- Methoden, die du anwendest und beim Namen nennst: Liquiditätsplanung, Kapitalwertmethode (NPV), interner Zinsfuß, Amortisationsrechnung, Rentabilität, Kostenvergleich Mieten/Leasing vs. Kauf, Deckungsbeitrag, Break-even, Forderungsmanagement (DSO, Skonto, Mahnwesen), Steuerrücklage (ESt/KSt, GewSt, USt-Zahllast), GWG-Grenze 800 € netto, lineare AfA.
- Jede Empfehlung: klare Aussage (ja/nein/unter Bedingung), dann die Begründung mit Zahlen, dann der nächste konkrete Schritt.
- Nenne Annahmen offen (z. B. Steuersatz, Zahlungsziel) und sage, welche Eingabe die Antwort am stärksten ändern würde.
- Kurz und strukturiert: Absätze oder Aufzählungen, keine Floskeln, kein Fett-Spam. Höchstens ~250 Wörter, außer der Nutzer fragt nach Details.
- Du ersetzt keine Steuerberatung; weise nur dann darauf hin, wenn eine Frage echte steuerliche Gestaltung berührt (ein Satz, nicht mehr).
- Wenn Daten für eine Aussage fehlen (z. B. Kontostand 0, keine Historie), sag das zuerst und beantworte die Frage dennoch unter der genannten Annahme.`;

const eur = (c: number) => Math.round(c / 100);

/** Compact, number-only context for the model (names of customers/suppliers included, nothing else personal). */
export function factsForModel(f: Facts): string {
  const m = metrics(f);
  const fc = forecast(f);
  const a = f.assumptions;
  const ctx = {
    stichtag: f.today,
    annahmen: {
      kontostand_eur: eur(a.cashCents),
      steuersatz: a.incomeTaxRate,
      est_vorauszahlung_quartal_eur: eur(a.taxPrepaymentCents),
      puffer_monate: a.bufferMonths,
      ust_zeitraum: a.vatPeriod,
      zahlungsziel_tage: a.paymentTermDays,
    },
    kennzahlen: {
      umsatz_pro_monat_eur: eur(m.avgRevenueGrossCents),
      kosten_pro_monat_eur: eur(m.avgCostGrossCents),
      ust_zahllast_pro_monat_eur: eur(m.avgVatPayableCents),
      gewinn_laufendes_jahr_eur: eur(f.profitYtdCents),
      steuerruecklage_noetig_eur: eur(m.taxReserveCents),
      liquiditaetspuffer_empfohlen_eur: eur(m.bufferCents),
      dso_tage: m.dsoDays,
      zahlungsverzug_tage: m.avgDelayDays,
      reichweite_monate: m.runwayMonths,
      top_kunden: m.topCustomers.map((c) => ({
        name: c.name,
        anteil: Math.round(c.shareOfRevenue * 100) / 100,
        umsatz_eur: eur(c.grossCents),
      })),
    },
    offene_forderungen: f.receivables.map((r) => ({
      nr: r.number,
      kunde: r.customer,
      eur: eur(r.grossCents),
      faellig: r.dueDate,
    })),
    offene_verbindlichkeiten: f.payables.map((p) => ({
      lieferant: p.supplier,
      eur: eur(p.grossCents),
      datum: p.invoiceDate,
    })),
    nicht_abgerechnete_leistungen_eur:
      f.unbilledCents == null ? null : eur(f.unbilledCents),
    wiederkehrend: f.recurring.map((r) => ({
      art: r.kind === "invoice" ? "einnahme" : "ausgabe",
      label: r.label,
      eur: eur(r.grossCents),
      rhythmus: `${r.intervalCount}×${r.frequency}`,
      naechster: r.nextRunDate,
    })),
    historie_12_monate: f.history.map((h) => ({
      monat: h.month,
      umsatz_eur: eur(h.revenueGrossCents),
      kosten_eur: eur(h.costGrossCents),
    })),
    liquiditaetsplan: fc.months.map((mo) => ({
      monat: mo.month,
      anfang_eur: eur(mo.openingCents),
      einzahlungen_eur: eur(
        mo.in.receivables + mo.in.recurring + mo.in.unbilled + mo.in.trend,
      ),
      auszahlungen_eur: eur(mo.out.payables + mo.out.recurring + mo.out.trend),
      steuern_eur: eur(mo.out.vat + mo.out.incomeTax),
      ende_eur: eur(mo.closingCents),
    })),
    tiefpunkt: { monat: fc.minMonth, kontostand_eur: eur(fc.minClosingCents) },
    regelbasierte_hinweise: recommendations(f, m, fc).map(
      (r) => `${r.severity}: ${r.text}`,
    ),
  };
  return JSON.stringify(ctx);
}

/** The user turn: data block + question (+ optional calculator result the user is looking at). */
export function userPrompt(
  f: Facts,
  question: string,
  calculation?: string,
): string {
  return [
    "Zahlen aus der Buchhaltung (JSON):",
    factsForModel(f),
    calculation ? `\nAktuelle Berechnung des Nutzers:\n${calculation}` : "",
    `\nFrage: ${question.trim()}`,
  ].join("\n");
}

/** One turn of the advisor chat: `text` is shown, `sent` goes to the model. */
export type Turn = {
  role: "user" | "assistant";
  text: string;
  sent: string;
  /** User turns: the calculator summary current when the question was asked. */
  calc?: string;
};

/**
 * The next user turn. The first question carries the full facts; a follow-up
 * is sent as typed, re-attaching the calculator only when it changed since
 * the last question (the facts are already in the conversation).
 */
export function userTurn(
  f: Facts,
  question: string,
  calc: string,
  thread: Turn[],
): Turn {
  const q = question.trim();
  const prev = thread.findLast((t) => t.role === "user");
  const sent = !prev
    ? userPrompt(f, q, calc)
    : calc !== prev.calc
      ? `Aktuelle Berechnung des Nutzers:\n${calc}\n\nFrage: ${q}`
      : q;
  return { role: "user", text: q, sent, calc };
}

export const toMessages = (thread: Turn[]) =>
  thread.map((t) => ({ role: t.role, content: t.sent }));
