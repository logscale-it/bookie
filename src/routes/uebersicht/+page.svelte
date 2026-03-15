<script lang="ts">
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { getDashboardData, type GroupBy, type PeriodRow } from '$lib/db/dashboard';
	import { getOrganizationSettings } from '$lib/db/settings';
	import { getUstvaData, getEuerData } from '$lib/db/tax-reports';
	import { generateUstvaCsv } from '$lib/csv/ustva-csv';
	import { generateEuerCsv } from '$lib/csv/euer-csv';
	import { saveCsvFile } from '$lib/csv/csv-writer';
	import { t, tp, translations } from '$lib/i18n';

	let loading = $state(true);
	let year = $state(new Date().getFullYear());
	let groupBy = $state<GroupBy>('month');
	let revenue = $state<PeriodRow[]>([]);
	let costs = $state<PeriodRow[]>([]);

	const periodOptions: { value: GroupBy; label: string }[] = [
		{ value: 'year', label: t('overview.year') },
		{ value: 'quarter', label: t('overview.quarter') },
		{ value: 'month', label: t('overview.month') }
	];

	const monthNames = translations().overview.months;

	const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
	const formatCurrency = (v: number) => fmt.format(v);

	interface MergedPeriod {
		period: string;
		label: string;
		revenue: number;
		costs: number;
		profit: number;
		vatOut: number;
		vatIn: number;
		vatPayable: number;
	}

	function allPeriodKeys(g: GroupBy, y: number): { key: string; label: string }[] {
		if (g === 'year') return [{ key: String(y), label: String(y) }];
		if (g === 'quarter') return [1, 2, 3, 4].map((q) => ({ key: `${y}-Q${q}`, label: `Q${q}` }));
		return Array.from({ length: 12 }, (_, i) => ({
			key: `${y}-${String(i + 1).padStart(2, '0')}`,
			label: monthNames[i]
		}));
	}

	function mergePeriods(rev: PeriodRow[], cost: PeriodRow[], g: GroupBy, y: number): MergedPeriod[] {
		const revMap = new Map(rev.map((r) => [r.period, r]));
		const costMap = new Map(cost.map((r) => [r.period, r]));
		return allPeriodKeys(g, y).map(({ key, label }) => {
			const r = revMap.get(key);
			const c = costMap.get(key);
			const rv = r?.total_net ?? 0;
			const cv = c?.total_net ?? 0;
			const vo = r?.total_tax ?? 0;
			const vi = c?.total_tax ?? 0;
			return { period: key, label, revenue: rv, costs: cv, profit: rv - cv, vatOut: vo, vatIn: vi, vatPayable: vo - vi };
		});
	}

	let periods = $derived(mergePeriods(revenue, costs, groupBy, year));
	let totals = $derived(
		periods.reduce(
			(acc, p) => ({
				revenue: acc.revenue + p.revenue,
				costs: acc.costs + p.costs,
				profit: acc.profit + p.profit,
				vatOut: acc.vatOut + p.vatOut,
				vatIn: acc.vatIn + p.vatIn,
				vatPayable: acc.vatPayable + p.vatPayable
			}),
			{ revenue: 0, costs: 0, profit: 0, vatOut: 0, vatIn: 0, vatPayable: 0 }
		)
	);
	let maxAmount = $derived(Math.max(...periods.map((p) => Math.max(p.revenue, p.costs)), 1));

	function barWidth(value: number, max: number): number {
		return max > 0 ? (value / max) * 100 : 0;
	}

	$effect(() => {
		// track reactive deps
		const _y = year;
		const _g = groupBy;
		loadData();
	});

	async function ensureCompanyId(): Promise<number> {
		const companies = await listCompanies();
		if (companies.length > 0) return companies[0].id;
		return createCompany({
			name: 'Standardfirma',
			legal_name: null,
			street: null,
			postal_code: null,
			city: null,
			country_code: 'DE',
			tax_number: null,
			vat_id: null,
			bank_account_holder: null,
			bank_iban: null,
			bank_bic: null,
			bank_name: null
		});
	}

	async function loadData() {
		loading = true;
		const companyId = await ensureCompanyId();
		const data = await getDashboardData(companyId, year, groupBy);
		revenue = data.revenue;
		costs = data.costs;
		loading = false;
	}

	let exportingUstva = $state(false);
	let exportingEuer = $state(false);
	let exportMessage = $state('');

	async function exportUstva() {
		exportingUstva = true;
		exportMessage = '';
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			const data = await getUstvaData(companyId, year, groupBy);
			const csv = generateUstvaCsv(data, org.name, year, org.vatin);
			const saved = await saveCsvFile(csv, `UStVA-${year}-${groupBy}.csv`);
			if (saved) exportMessage = t('overview.exportSuccess');
		} catch (err) {
			exportMessage = `${t('overview.exportError')}: ${err}`;
		} finally {
			exportingUstva = false;
		}
	}

	async function exportEuer() {
		exportingEuer = true;
		exportMessage = '';
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			const data = await getEuerData(companyId, year, groupBy);
			const csv = generateEuerCsv(data, org.name, year, org.vatin);
			const saved = await saveCsvFile(csv, `EUER-${year}-${groupBy}.csv`);
			if (saved) exportMessage = t('overview.exportSuccess');
		} catch (err) {
			exportMessage = `${t('overview.exportError')}: ${err}`;
		} finally {
			exportingEuer = false;
		}
	}
</script>

<section class="space-y-6">
	<!-- Header -->
	<header class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<h1 class="page-header">{t('overview.title')}</h1>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{tp('overview.financialOverview', { year })}</p>
		</div>
		<div class="flex items-center gap-3">
			<button aria-label={t('overview.prevYear')} onclick={() => year--} class="rounded-md border border-zinc-200 p-1.5 text-zinc-500 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700">
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
			</button>
			<span class="min-w-[3.5rem] text-center text-sm font-semibold tabular-nums">{year}</span>
			<button aria-label={t('overview.nextYear')} onclick={() => year++} class="rounded-md border border-zinc-200 p-1.5 text-zinc-500 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700">
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
			</button>
		</div>
	</header>

	<!-- Period toggle -->
	<nav class="flex gap-2">
		{#each periodOptions as opt}
			<button
				class={`nav-pill ${groupBy === opt.value ? 'nav-pill-active' : 'nav-pill-inactive'}`}
				onclick={() => (groupBy = opt.value)}
			>
				{opt.label}
			</button>
		{/each}
	</nav>

	{#if loading}
		<div class="flex items-center justify-center py-20">
			<p class="text-sm text-zinc-400">{t('overview.loadingData')}</p>
		</div>
	{:else}
		<!-- Gewinn & Verlust -->
		<div class="card space-y-5">
			<h2 class="text-lg font-semibold tracking-tight">{t('overview.profitLoss')}</h2>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<div>
					<p class="label">{t('overview.revenue')}</p>
					<p class="mt-1 text-xl font-semibold text-emerald-600 dark:text-emerald-400">{formatCurrency(totals.revenue)}</p>
				</div>
				<div>
					<p class="label">{t('overview.expenses')}</p>
					<p class="mt-1 text-xl font-semibold text-red-500 dark:text-red-400">{formatCurrency(totals.costs)}</p>
				</div>
				<div>
					<p class="label">{t('overview.profit')}</p>
					<p class="mt-1 text-xl font-semibold {totals.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}">{formatCurrency(totals.profit)}</p>
				</div>
			</div>

			{#if periods.length > 1}
				<div class="space-y-2.5 pt-2">
					{#each periods as p}
						<div class="flex items-center gap-3 text-sm">
							<span class="w-20 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{p.label}</span>
							<div class="flex-1 space-y-1">
								<div class="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-700/50">
									<div class="h-1.5 rounded-full bg-emerald-500 transition-all" style="width: {barWidth(p.revenue, maxAmount)}%"></div>
								</div>
								<div class="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-700/50">
									<div class="h-1.5 rounded-full bg-red-400 transition-all" style="width: {barWidth(p.costs, maxAmount)}%"></div>
								</div>
							</div>
							<span class="w-24 shrink-0 text-right text-xs tabular-nums {p.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}">{formatCurrency(p.profit)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Umsatzsteuer -->
		<div class="card space-y-5">
			<h2 class="text-lg font-semibold tracking-tight">{t('overview.vat')}</h2>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<div>
					<p class="label">{t('overview.vatOut')}</p>
					<p class="mt-1 text-xl font-semibold">{formatCurrency(totals.vatOut)}</p>
				</div>
				<div>
					<p class="label">{t('overview.vatIn')}</p>
					<p class="mt-1 text-xl font-semibold">{formatCurrency(totals.vatIn)}</p>
				</div>
				<div>
					<p class="label">{t('overview.vatPayable')}</p>
					<p class="mt-1 text-xl font-semibold text-blue-600 dark:text-blue-400">{formatCurrency(totals.vatPayable)}</p>
				</div>
			</div>

			{#if periods.length > 1}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-xs">
						<thead>
							<tr class="border-b border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
								<th class="pb-2 font-medium">{t('overview.period')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatOut')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatIn')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatPayable')}</th>
							</tr>
						</thead>
						<tbody>
							{#each periods as p}
								<tr class="border-b border-zinc-100 dark:border-zinc-700/50">
									<td class="py-2 text-zinc-600 dark:text-zinc-300">{p.label}</td>
									<td class="py-2 text-right tabular-nums">{formatCurrency(p.vatOut)}</td>
									<td class="py-2 text-right tabular-nums">{formatCurrency(p.vatIn)}</td>
									<td class="py-2 text-right tabular-nums font-medium text-blue-600 dark:text-blue-400">{formatCurrency(p.vatPayable)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Exporte -->
		<div class="card space-y-4">
			<h2 class="text-lg font-semibold tracking-tight">{t('overview.exports')}</h2>

			<div class="flex flex-wrap gap-3">
				<button
					onclick={exportUstva}
					disabled={exportingUstva}
					class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
				>
					{exportingUstva ? t('overview.exporting') : t('overview.exportUstva')}
				</button>
				<button
					onclick={exportEuer}
					disabled={exportingEuer}
					class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
				>
					{exportingEuer ? t('overview.exporting') : t('overview.exportEuer')}
				</button>
			</div>

			{#if exportMessage}
				<p class="text-sm text-zinc-600 dark:text-zinc-400">{exportMessage}</p>
			{/if}
		</div>
	{/if}
</section>
