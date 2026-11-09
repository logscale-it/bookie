<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { listCompanies } from '$lib/db/companies';
	import { gatherFacts, loadAssumptions, saveAssumptions } from '$lib/advisor/facts';
	import {
		affordability,
		forecast,
		investment,
		metrics,
		recommendations,
		rentOrBuy,
		type Facts
	} from '$lib/advisor/calc';
	import { SYSTEM_PROMPT, toMessages, userTurn, type Turn } from '$lib/advisor/prompt';
	import { aiConfig, complete } from '$lib/ai';
	import { messageForUnknown } from '$lib/shared/errors';
	import EmptyState from '../../common/EmptyState.svelte';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';

	// ---- data -----------------------------------------------------------
	let loading = $state(true);
	let error = $state('');
	let companyId = $state<number | null>(null);
	let facts = $state<Facts | null>(null);
	const saved = loadAssumptions();
	let assumptions = $state(saved);
	let trend = $state(true);

	const m = $derived(facts ? metrics(facts) : null);
	const fc = $derived(facts ? forecast(facts, 6, trend) : null);
	const recs = $derived(facts && m && fc ? recommendations(facts, m, fc) : []);

	const fmt = new Intl.NumberFormat(getLocaleFormatting(), { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
	const eur = (c: number) => fmt.format(c / 100);
	const pct = (x: number) => `${Math.round(x * 100)} %`;
	const monthLabel = (ym: string) => new Date(`${ym}-01`).toLocaleDateString(getLocaleFormatting(), { month: 'short', year: '2-digit' });
	const toCents = (euros: number) => Math.round((Number(euros) || 0) * 100);

	async function load() {
		loading = true;
		error = '';
		try {
			if (companyId === null) companyId = (await listCompanies())[0]?.id ?? null;
			if (companyId === null) return;
			facts = await gatherFacts(companyId, assumptions);
		} catch (e) {
			error = messageForUnknown(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	// Assumptions edited in euros / percent; stored in cents / fractions.
	let cashEur = $state(saved.cashCents / 100);
	let taxRatePct = $state(Math.round(saved.incomeTaxRate * 100));
	let prepayEur = $state(saved.taxPrepaymentCents / 100);
	function applyAssumptions() {
		assumptions = {
			...assumptions,
			cashCents: toCents(cashEur),
			incomeTaxRate: Math.min(0.6, Math.max(0, Number(taxRatePct) || 0) / 100),
			taxPrepaymentCents: toCents(prepayEur)
		};
		saveAssumptions(assumptions);
		if (facts) facts = { ...facts, assumptions };
	}

	// ---- calculators ----------------------------------------------------
	type Tool = 'afford' | 'rentbuy' | 'invest';
	let tool = $state<Tool>('afford');

	let affordEur = $state(5000);
	let affordMonth = $state(0);
	let affordRateEur = $state(0);
	const afford = $derived(
		facts ? affordability(facts, toCents(affordEur), { atIndex: affordMonth, installmentCents: toCents(affordRateEur) || undefined }) : null
	);

	let rbPrice = $state(2400);
	let rbLife = $state(36);
	let rbResidual = $state(400);
	let rbRent = $state(90);
	let rbHorizon = $state(24);
	let rbRate = $state(6);
	let rbOwnerCost = $state(0);
	const rb = $derived(
		rentOrBuy({
			priceCents: toCents(rbPrice),
			usefulLifeMonths: Number(rbLife) || 1,
			residualCents: toCents(rbResidual),
			rentPerMonthCents: toCents(rbRent),
			horizonMonths: Number(rbHorizon) || 1,
			rateAnnual: (Number(rbRate) || 0) / 100,
			taxRate: assumptions.incomeTaxRate,
			ownerCostPerMonthCents: toCents(rbOwnerCost)
		})
	);
	const rbAfford = $derived(facts ? affordability(facts, toCents(rbPrice)) : null);

	let invCost = $state(10000);
	let invGain = $state(3500);
	let invYears = $state(5);
	let invResidual = $state(0);
	let invRate = $state(6);
	const inv = $derived(
		investment({
			costCents: toCents(invCost),
			annualGainCents: toCents(invGain),
			years: Number(invYears) || 1,
			residualCents: toCents(invResidual),
			rateAnnual: (Number(invRate) || 0) / 100
		})
	);

	/** What the user currently sees in the calculator, handed to the AI with the question. */
	function calculationSummary(): string {
		if (tool === 'afford' && afford)
			return `Anschaffung ${eur(toCents(affordEur))}${affordRateEur ? ` plus ${eur(toCents(affordRateEur))}/Monat` : ''} ab Monat ${fc?.months[affordMonth]?.month}: Urteil ${afford.verdict}, Spielraum im engsten Monat (${afford.tightestMonth}) ${eur(afford.headroomCents)}, maximal tragbar ${eur(afford.maxAffordableCents)}.`;
		if (tool === 'rentbuy')
			return `Mieten oder kaufen: Preis ${eur(toCents(rbPrice))}, Nutzungsdauer AfA ${rbLife} Monate, Restwert ${eur(toCents(rbResidual))}, Miete ${eur(toCents(rbRent))}/Monat, Nutzung ${rbHorizon} Monate, Zins ${rbRate} %. Barwert Kauf ${eur(rb.buyNpvCents)}, Barwert Miete ${eur(rb.rentNpvCents)}, Break-even ab ${rb.breakEvenMonths ?? '–'} Monaten, Empfehlung ${rb.recommendation}${rb.gwg ? ' (GWG, Sofortabschreibung)' : ''}. Liquidität bei Kauf: ${rbAfford?.verdict}.`;
		return `Investition ${eur(toCents(invCost))}, Mehrertrag ${eur(toCents(invGain))}/Jahr über ${invYears} Jahre, Restwert ${eur(toCents(invResidual))}, Kalkulationszins ${invRate} %: Kapitalwert ${eur(inv.npvCents)}, interner Zinsfuß ${inv.irrAnnual == null ? '–' : pct(inv.irrAnnual)}, Amortisation ${inv.paybackYears == null ? 'nie' : inv.paybackYears.toFixed(1) + ' Jahre'}, Rentabilität ${pct(inv.roiAnnual)}.`;
	}

	// ---- AI chat ----------------------------------------------------------
	// ponytail: the conversation lives in page state; leaving the page ends it.
	const ai = aiConfig();
	let question = $state('');
	let thread = $state<Turn[]>([]);
	let asking = $state(false);
	let aiError = $state('');
	let composerEl = $state<HTMLFormElement>();

	/** The page scrolls (no inner scroll box: it clips answers on a phone); keep the composer in view. */
	async function scrollToEnd() {
		await tick();
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		composerEl?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
	}

	async function ask(q = question) {
		if (!facts || !ai || !q.trim() || asking) return;
		const turn = userTurn(facts, q, calculationSummary(), thread);
		thread = [...thread, turn];
		question = '';
		asking = true;
		aiError = '';
		void scrollToEnd();
		try {
			const text = await complete(SYSTEM_PROMPT, toMessages(thread), ai);
			thread = [...thread, { role: 'assistant', text, sent: text }];
		} catch (e) {
			// Drop the unanswered question and hand it back, so sending again retries it.
			thread = thread.slice(0, -1);
			question = turn.text;
			aiError = messageForUnknown(e);
		} finally {
			asking = false;
			void scrollToEnd();
		}
	}

	function newChat() {
		thread = [];
		aiError = '';
		question = '';
	}

	function onComposerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void ask();
		}
	}

	const tone = { bad: 'border-red-500/40 bg-red-500/5', warn: 'border-amber-500/40 bg-amber-500/5', info: 'border-zinc-900/10 dark:border-white/10' } as const;
	const verdictTone = { ja: 'text-emerald-600 dark:text-emerald-400', knapp: 'text-amber-600 dark:text-amber-400', nein: 'text-red-600 dark:text-red-400' } as const;
	const eyebrow = 'text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400';
	const num = 'input-base w-full';
</script>

<div class="page-header">
	<h1 class="text-2xl font-semibold">{t('advisor.title')}</h1>
	<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('advisor.subtitle')}</p>
</div>

{#if loading}
	<p class="text-sm text-zinc-500">{t('advisor.loading')}</p>
{:else if error}
	<p class="text-sm text-red-600">{error}</p>
{:else if !facts || !m || !fc}
	<EmptyState title={t('advisor.emptyTitle')} hint={t('advisor.emptyHint')} />
{:else}
	<div class="grid gap-4 lg:grid-cols-3">
		<!-- Assumptions -->
		<section class="card space-y-3">
			<h2 class={eyebrow}>{t('advisor.assumptions')}</h2>
			<div>
				<label class="label" for="adv-cash">{t('advisor.cash')}</label>
				<input id="adv-cash" type="number" step="100" class={num} bind:value={cashEur} onchange={applyAssumptions} />
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="adv-tax">{t('advisor.taxRate')}</label>
					<input id="adv-tax" type="number" min="0" max="60" class={num} bind:value={taxRatePct} onchange={applyAssumptions} />
				</div>
				<div>
					<label class="label" for="adv-prepay">{t('advisor.prepay')}</label>
					<input id="adv-prepay" type="number" step="100" class={num} bind:value={prepayEur} onchange={applyAssumptions} />
				</div>
				<div>
					<label class="label" for="adv-buffer">{t('advisor.buffer')}</label>
					<input id="adv-buffer" type="number" min="0" max="12" class={num} bind:value={assumptions.bufferMonths} onchange={applyAssumptions} />
				</div>
				<div>
					<label class="label" for="adv-vat">{t('advisor.vatPeriod')}</label>
					<select id="adv-vat" class={num} bind:value={assumptions.vatPeriod} onchange={applyAssumptions}>
						<option value="month">{t('advisor.monthly')}</option>
						<option value="quarter">{t('advisor.quarterly')}</option>
					</select>
				</div>
			</div>
			<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={trend} /> {t('advisor.trend')}</label>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">{t('advisor.cashNote')}</p>
		</section>

		<!-- Key figures -->
		<section class="card lg:col-span-2">
			<h2 class={eyebrow}>{t('advisor.keyFigures')}</h2>
			<dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
				<div><dt class="text-zinc-500">{t('advisor.revenuePerMonth')}</dt><dd class="text-lg font-semibold">{eur(m.avgRevenueGrossCents)}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.costPerMonth')}</dt><dd class="text-lg font-semibold">{eur(m.avgCostGrossCents)}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.taxReserveNeeded')}</dt><dd class="text-lg font-semibold {m.taxReserveCents > assumptions.cashCents ? 'text-red-600' : ''}">{eur(m.taxReserveCents)}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.recommendedBuffer')}</dt><dd class="text-lg font-semibold">{eur(m.bufferCents)}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.openReceivables')}</dt><dd class="font-medium">{eur(facts.receivables.reduce((s, r) => s + r.grossCents, 0))} <span class="text-xs text-zinc-500">({facts.receivables.length})</span></dd></div>
				<div><dt class="text-zinc-500">{t('advisor.overdueOfIt')}</dt><dd class="font-medium {m.overdueCents ? 'text-amber-600' : ''}">{eur(m.overdueCents)} <span class="text-xs text-zinc-500">({m.overdueCount})</span></dd></div>
				<div><dt class="text-zinc-500">{t('advisor.openPayables')}</dt><dd class="font-medium">{eur(facts.payables.reduce((s, p) => s + p.grossCents, 0))}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.dso')}</dt><dd class="font-medium">{tp('advisor.days', { n: m.dsoDays })}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.profitYtd')}</dt><dd class="font-medium">{eur(facts.profitYtdCents)}</dd></div>
				<div><dt class="text-zinc-500">{t('advisor.unbilled')}</dt><dd class="font-medium">{facts.unbilledCents == null ? '–' : eur(facts.unbilledCents)}</dd></div>
				<div class="col-span-2"><dt class="text-zinc-500">{t('advisor.topCustomers')}</dt><dd class="font-medium">{m.topCustomers.map((c) => `${c.name} ${pct(c.shareOfRevenue)}`).join(' · ') || '–'}</dd></div>
			</dl>
		</section>

		<!-- Recommendations -->
		<section class="card lg:col-span-3">
			<h2 class={eyebrow}>{t('advisor.recommendations')}</h2>
			<ul class="mt-3 grid gap-2 md:grid-cols-2">
				{#each recs as r}
					<li class="rounded-lg border p-3 text-sm {tone[r.severity]}" data-testid="advisor-row">{r.text}</li>
				{/each}
			</ul>
		</section>

		<!-- Liquidity plan -->
		<section class="card overflow-x-auto lg:col-span-3">
			<div class="flex items-baseline justify-between">
				<h2 class={eyebrow}>{t('advisor.liquidityPlan')}</h2>
				<p class="text-xs text-zinc-500">{tp('advisor.lowPoint', { month: monthLabel(fc.minMonth) })} <span class="font-medium {fc.minClosingCents < 0 ? 'text-red-600' : ''}">{eur(fc.minClosingCents)}</span>{#if fc.haircutCents} · {tp('advisor.haircut', { amount: eur(fc.haircutCents) })}{/if}</p>
			</div>
			<table class="mt-3 w-full text-right text-sm tabular-nums">
				<thead class="text-xs text-zinc-500">
					<tr><th class="py-1 text-left">{t('advisor.colMonth')}</th><th>{t('advisor.colOpening')}</th><th>{t('advisor.colReceivables')}</th><th>{t('advisor.colRecurringIn')}</th><th>{t('advisor.colTrendIn')}</th><th>{t('advisor.colPayables')}</th><th>{t('advisor.colRecurringOut')}</th><th>{t('advisor.colTrendOut')}</th><th>{t('advisor.colTaxes')}</th><th>{t('advisor.colClosing')}</th></tr>
				</thead>
				<tbody>
					{#each fc.months as mo}
						<tr class="border-t border-zinc-900/5 dark:border-white/5">
							<td class="py-1.5 text-left font-medium">{monthLabel(mo.month)}</td>
							<td>{eur(mo.openingCents)}</td>
							<td class="text-emerald-700 dark:text-emerald-400">{eur(mo.in.receivables + mo.in.unbilled)}</td>
							<td class="text-emerald-700 dark:text-emerald-400">{eur(mo.in.recurring)}</td>
							<td class="text-zinc-500">{eur(mo.in.trend)}</td>
							<td class="text-red-700 dark:text-red-400">{eur(mo.out.payables)}</td>
							<td class="text-red-700 dark:text-red-400">{eur(mo.out.recurring)}</td>
							<td class="text-zinc-500">{eur(mo.out.trend)}</td>
							<td class="text-red-700 dark:text-red-400">{eur(mo.out.vat + mo.out.incomeTax)}</td>
							<td class="font-semibold {mo.closingCents < 0 ? 'text-red-600' : ''}">{eur(mo.closingCents)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{tp('advisor.planNote', { days: m.avgDelayDays })}</p>
		</section>

		<!-- Calculators -->
		<section class="card lg:col-span-3">
			<div class="flex flex-wrap gap-2">
				<button class="nav-pill {tool === 'afford' ? 'nav-pill-active' : 'nav-pill-inactive'}" onclick={() => (tool = 'afford')}>{t('advisor.toolAfford')}</button>
				<button class="nav-pill {tool === 'rentbuy' ? 'nav-pill-active' : 'nav-pill-inactive'}" onclick={() => (tool = 'rentbuy')}>{t('advisor.toolRentBuy')}</button>
				<button class="nav-pill {tool === 'invest' ? 'nav-pill-active' : 'nav-pill-inactive'}" onclick={() => (tool = 'invest')}>{t('advisor.toolInvest')}</button>
			</div>

			{#if tool === 'afford' && afford}
				<div class="mt-4 grid gap-4 md:grid-cols-3">
					<div><label class="label" for="af-amount">{t('advisor.oneOff')}</label><input id="af-amount" type="number" step="100" class={num} bind:value={affordEur} /></div>
					<div><label class="label" for="af-rate">{t('advisor.extraPerMonth')}</label><input id="af-rate" type="number" step="10" class={num} bind:value={affordRateEur} /></div>
					<div>
						<label class="label" for="af-month">{t('advisor.fromMonth')}</label>
						<select id="af-month" class={num} bind:value={affordMonth}>
							{#each fc.months as mo, i}<option value={i}>{monthLabel(mo.month)}</option>{/each}
						</select>
					</div>
				</div>
				<div class="mt-4 rounded-lg border border-zinc-900/10 p-4 dark:border-white/10">
					<p class="text-2xl font-semibold {verdictTone[afford.verdict]}">
						{t(afford.verdict === 'ja' ? 'advisor.verdictYes' : afford.verdict === 'knapp' ? 'advisor.verdictTight' : 'advisor.verdictNo')}
					</p>
					<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
						{tp('advisor.affordLead', { month: monthLabel(afford.tightestMonth), reserve: eur(m.taxReserveCents), buffer: eur(m.bufferCents) })} <strong>{eur(afford.headroomCents)}</strong>.
						{t('advisor.affordMaxLead')} <strong>{eur(afford.maxAffordableCents)}</strong> {t('advisor.affordMaxRest')}
					</p>
				</div>
			{:else if tool === 'rentbuy'}
				<div class="mt-4 grid gap-4 md:grid-cols-4">
					<div><label class="label" for="rb-price">{t('advisor.price')}</label><input id="rb-price" type="number" step="50" class={num} bind:value={rbPrice} /></div>
					<div><label class="label" for="rb-rent">{t('advisor.rent')}</label><input id="rb-rent" type="number" step="5" class={num} bind:value={rbRent} /></div>
					<div><label class="label" for="rb-horizon">{t('advisor.horizon')}</label><input id="rb-horizon" type="number" min="1" class={num} bind:value={rbHorizon} /></div>
					<div><label class="label" for="rb-life">{t('advisor.life')}</label><input id="rb-life" type="number" min="1" class={num} bind:value={rbLife} /></div>
					<div><label class="label" for="rb-residual">{t('advisor.residualAfterUse')}</label><input id="rb-residual" type="number" step="50" class={num} bind:value={rbResidual} /></div>
					<div><label class="label" for="rb-owner">{t('advisor.ownerCost')}</label><input id="rb-owner" type="number" step="5" class={num} bind:value={rbOwnerCost} /></div>
					<div><label class="label" for="rb-rate">{t('advisor.rate')}</label><input id="rb-rate" type="number" step="0.5" class={num} bind:value={rbRate} /></div>
				</div>
				<div class="mt-4 grid gap-4 md:grid-cols-3">
					<div class="rounded-lg border border-zinc-900/10 p-4 dark:border-white/10">
						<p class={eyebrow}>{t('advisor.npvCosts')}</p>
						<p class="mt-1 text-sm">{t('advisor.buy')} <strong>{eur(rb.buyNpvCents)}</strong></p>
						<p class="text-sm">{t('advisor.rentLabel')} <strong>{eur(rb.rentNpvCents)}</strong></p>
						<p class="mt-1 text-xs text-zinc-500">{rb.gwg ? tp('advisor.afterTaxGwg', { rate: taxRatePct }) : tp('advisor.afterTaxAfa', { rate: taxRatePct, months: rbLife })}</p>
					</div>
					<div class="rounded-lg border border-zinc-900/10 p-4 dark:border-white/10">
						<p class={eyebrow}>{t('advisor.recommendation')}</p>
						<p class="mt-1 text-2xl font-semibold capitalize">{t(`advisor.choices.${rb.recommendation}`)}</p>
						<p class="text-sm text-zinc-600 dark:text-zinc-300">{tp(rb.savingCents >= 0 ? 'advisor.buySaves' : 'advisor.rentSaves', { amount: eur(Math.abs(rb.savingCents)) })}{rb.breakEvenMonths ? tp('advisor.breakEven', { months: rb.breakEvenMonths }) : t('advisor.neverBreakEven')}</p>
					</div>
					{#if rbAfford}
						<div class="rounded-lg border border-zinc-900/10 p-4 dark:border-white/10">
							<p class={eyebrow}>{t('advisor.liquidityOnBuy')}</p>
							<p class="mt-1 text-2xl font-semibold {verdictTone[rbAfford.verdict]}">{t(`advisor.verdicts.${rbAfford.verdict}`)}</p>
							<p class="text-sm text-zinc-600 dark:text-zinc-300">{tp('advisor.headroom', { amount: eur(rbAfford.headroomCents) })}{rbAfford.verdict !== 'ja' ? t('advisor.headroomTight') : '.'}</p>
						</div>
					{/if}
				</div>
			{:else if tool === 'invest'}
				<div class="mt-4 grid gap-4 md:grid-cols-5">
					<div><label class="label" for="in-cost">{t('advisor.cost')}</label><input id="in-cost" type="number" step="100" class={num} bind:value={invCost} /></div>
					<div><label class="label" for="in-gain">{t('advisor.gain')}</label><input id="in-gain" type="number" step="100" class={num} bind:value={invGain} /></div>
					<div><label class="label" for="in-years">{t('advisor.years')}</label><input id="in-years" type="number" min="1" class={num} bind:value={invYears} /></div>
					<div><label class="label" for="in-residual">{t('advisor.residual')}</label><input id="in-residual" type="number" step="100" class={num} bind:value={invResidual} /></div>
					<div><label class="label" for="in-rate">{t('advisor.rate')}</label><input id="in-rate" type="number" step="0.5" class={num} bind:value={invRate} /></div>
				</div>
				<dl class="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
					<div><dt class="text-zinc-500">{t('advisor.npv')}</dt><dd class="text-lg font-semibold {inv.npvCents >= 0 ? 'text-emerald-600' : 'text-red-600'}">{eur(inv.npvCents)}</dd></div>
					<div><dt class="text-zinc-500">{t('advisor.irr')}</dt><dd class="text-lg font-semibold">{inv.irrAnnual == null ? '–' : pct(inv.irrAnnual)}</dd></div>
					<div><dt class="text-zinc-500">{t('advisor.payback')}</dt><dd class="text-lg font-semibold">{inv.paybackYears == null ? t('advisor.never') : tp('advisor.yearsShort', { n: inv.paybackYears.toFixed(1) })}</dd></div>
					<div><dt class="text-zinc-500">{t('advisor.roi')}</dt><dd class="text-lg font-semibold">{pct(inv.roiAnnual)}</dd></div>
					<div><dt class="text-zinc-500">{t('advisor.annuity')}</dt><dd class="text-lg font-semibold">{tp('advisor.perYearShort', { amount: eur(inv.annuityCents) })}</dd></div>
				</dl>
				<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
					{t(inv.recommended ? 'advisor.investYes' : 'advisor.investNo')}
				</p>
			{/if}
		</section>

		<!-- AI chat -->
		<section class="card lg:col-span-3" aria-labelledby="adv-chat-title">
			<div class="flex items-baseline justify-between gap-3">
				<h2 id="adv-chat-title" class={eyebrow}>{t('advisor.aiTitle')}</h2>
				{#if ai && thread.length}
					<button class="rounded text-xs text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:focus-visible:text-zinc-100" onclick={newChat} disabled={asking} data-testid="advisor-new-chat">{t('advisor.newChat')}</button>
				{/if}
			</div>
			{#if !ai}
				<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
					{t('advisor.aiSetupLead')} <a class="underline" href="/einstellungen/ki">{t('advisor.aiSetupLink')}</a> {t('advisor.aiSetupRest')}
				</p>
			{:else}
				{#if thread.length}
					<ol class="mt-4 space-y-5" aria-live="polite" aria-busy={asking}>
						{#each thread as turn, i (i)}
							<li class="chat-turn flex flex-col {turn.role === 'user' ? 'items-end' : 'items-start'}" data-testid="advisor-chat-row" data-role={turn.role}>
								<span class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{turn.role === 'user' ? t('advisor.you') : t('advisor.advisorName')}</span>
								{#if turn.role === 'user'}
									<p class="max-w-[min(75%,36rem)] whitespace-pre-wrap rounded-lg bg-zinc-900/[0.06] px-3.5 py-2 text-sm leading-relaxed text-zinc-900 dark:bg-white/10 dark:text-zinc-100">{turn.text}</p>
								{:else}
									<div class="max-w-[68ch] whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">{turn.text}</div>
								{/if}
							</li>
						{/each}
						{#if asking}
							<li class="chat-turn flex flex-col items-start" data-testid="advisor-chat-pending">
								<span class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{t('advisor.advisorName')}</span>
								<span class="chat-pending text-sm text-zinc-500 dark:text-zinc-400">{t('advisor.thinking')}</span>
							</li>
						{/if}
					</ol>
				{:else}
					<div class="mt-3 flex flex-wrap gap-2">
						{#each ['q1', 'q2', 'q3', 'q4'].map((k) => t(`advisorQuick.${k}`)) as q}
							<button class="btn-secondary text-xs" onclick={() => ask(q)} disabled={asking}>{q}</button>
						{/each}
					</div>
				{/if}

				<form bind:this={composerEl} class="mt-5 scroll-mb-24" onsubmit={(e) => { e.preventDefault(); void ask(); }}>
					<label class="label" for="adv-q">{thread.length ? t('advisor.followUp') : t('advisor.question')}</label>
					<textarea
						id="adv-q"
						class="input-base w-full resize-y"
						rows="2"
						bind:value={question}
						onkeydown={onComposerKey}
						placeholder={thread.length ? t('advisor.followUpPlaceholder') : t('advisor.questionPlaceholder')}
						aria-describedby="adv-q-note"
					></textarea>
					<div class="mt-2 flex flex-wrap items-center gap-3">
						<button type="submit" class="btn-primary" disabled={asking || !question.trim()} data-testid="advisor-send">{asking ? t('advisor.thinking') : t('advisor.ask')}</button>
						<span id="adv-q-note" class="text-xs text-zinc-500 dark:text-zinc-400">{t('advisor.aiSent')}</span>
					</div>
				</form>
				{#if aiError}
					<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert" data-testid="advisor-chat-error">{t('advisor.chatFailed')} <span class="text-zinc-500">({aiError})</span></p>
				{/if}
			{/if}
		</section>
	</div>
{/if}

<style>
	/* New turns rise in once; the pending line breathes. Transform/opacity only. */
	.chat-turn {
		animation: chat-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}
	.chat-pending {
		animation: chat-breathe 1.4s ease-in-out infinite;
	}
	@keyframes chat-in {
		from { opacity: 0; transform: translateY(8px); }
	}
	@keyframes chat-breathe {
		50% { opacity: 0.45; }
	}
	@media (prefers-reduced-motion: reduce) {
		.chat-turn, .chat-pending { animation: none; }
	}
</style>
