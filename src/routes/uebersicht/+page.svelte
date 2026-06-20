<script lang="ts">
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { getDashboardData, getActionItems, type GroupBy, type PeriodRow, type ActionItems } from '$lib/db/dashboard';
	import { goto } from '$app/navigation';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { getOrganizationSettings, getS3Settings } from '$lib/db/settings';
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
	let backupFailed = $state(false);
	let backupFailedAt = $state<string | null>(null);
	let backupFailureReason = $state<string | null>(null);
	let actions = $state<ActionItems | null>(null);

	// Next statutory tax deadline. UStVA (VAT pre-return) is due on the 10th of
	// the following month; the EÜR / income-tax return on 31 July. We surface
	// whichever falls sooner as a gentle, recurring reminder.
	function nextUstvaDeadline(now: Date): Date {
		const d = new Date(now.getFullYear(), now.getMonth(), 10);
		if (now.getDate() > 10) d.setMonth(d.getMonth() + 1);
		return d;
	}
	function nextEuerDeadline(now: Date): Date {
		const d = new Date(now.getFullYear(), 6, 31);
		if (now.getTime() > d.getTime()) d.setFullYear(now.getFullYear() + 1);
		return d;
	}
	const nextDeadline = $derived.by(() => {
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		const ustva = nextUstvaDeadline(now);
		const euer = nextEuerDeadline(now);
		const [date, labelKey] =
			ustva.getTime() <= euer.getTime() ? [ustva, 'overview.ustvaDue'] : [euer, 'overview.euerDue'];
		const days = Math.round((date.getTime() - now.getTime()) / 86_400_000);
		return { date, labelKey, days };
	});

	const hasActions = $derived(
		!!actions && (actions.overdue.count > 0 || actions.drafts.count > 0 || actions.openIncoming.count > 0)
	);

	function daysOverdue(dueDate: string): number {
		const due = new Date(dueDate);
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		return Math.max(0, Math.round((now.getTime() - due.getTime()) / 86_400_000));
	}

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
		const [data, items] = await Promise.all([
			getDashboardData(companyId, year, groupBy),
			getActionItems(companyId)
		]);
		revenue = data.revenue;
		costs = data.costs;
		actions = items;
		await loadBackupStatus();
		loading = false;
	}

	async function loadBackupStatus(): Promise<void> {
		try {
			const s3 = await getS3Settings();
			if (
				s3.enabled &&
				s3.auto_backup_enabled &&
				s3.last_auto_backup_status === 'failure'
			) {
				backupFailed = true;
				backupFailedAt = s3.last_auto_backup_at;
				backupFailureReason = s3.last_auto_backup_error;
			} else {
				backupFailed = false;
				backupFailedAt = null;
				backupFailureReason = null;
			}
		} catch {
			// Settings unreachable: leave banner hidden rather than crash dashboard.
			backupFailed = false;
		}
	}

	function formatBackupTimestamp(ts: string | null): string {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleString('de-DE', {
				dateStyle: 'medium',
				timeStyle: 'short'
			});
		} catch {
			return ts;
		}
	}

	let exportingUstva = $state(false);
	let exportingEuer = $state(false);

	async function exportUstva() {
		exportingUstva = true;
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			const data = await getUstvaData(companyId, year, groupBy);
			const csv = generateUstvaCsv(data, org.name, year, org.vatin);
			const saved = await saveCsvFile(csv, `UStVA-${year}-${groupBy}.csv`);
			if (saved) toasts.success(t('overview.exportSuccess'));
		} catch (err) {
			toasts.error(`${t('overview.exportError')}: ${err}`);
		} finally {
			exportingUstva = false;
		}
	}

	async function exportEuer() {
		exportingEuer = true;
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			const data = await getEuerData(companyId, year, groupBy);
			const csv = generateEuerCsv(data, org.name, year, org.vatin);
			const saved = await saveCsvFile(csv, `EUER-${year}-${groupBy}.csv`);
			if (saved) toasts.success(t('overview.exportSuccess'));
		} catch (err) {
			toasts.error(`${t('overview.exportError')}: ${err}`);
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

	{#if backupFailed}
		<div
			class="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200"
			role="alert"
			data-testid="auto-backup-failure-banner"
		>
			<p class="font-medium">
				{backupFailedAt
					? tp('overview.autoBackupFailedAt', { date: formatBackupTimestamp(backupFailedAt) })
					: t('overview.autoBackupFailed')}
			</p>
			{#if backupFailureReason}
				<p class="mt-1 text-xs opacity-80">
					{t('overview.autoBackupFailureReason')}: {t(`overview.autoBackupReason.${backupFailureReason}`)}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Cockpit: actionable to-dos that need attention -->
	{#if actions}
		<section class="card space-y-4 @container" data-testid="dashboard-cockpit">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 class="text-lg font-semibold tracking-tight">{t('overview.cockpit')}</h2>
				<span class="badge max-w-full {nextDeadline.days <= 7 ? 'badge-amber' : 'badge-zinc'}" title={t('overview.nextDeadline')}>
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5A2.25 2.25 0 015.25 5.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
					{t(nextDeadline.labelKey)}: {nextDeadline.days <= 0 ? t('overview.dueToday') : tp('overview.dueInDays', { days: nextDeadline.days })}
				</span>
			</div>

			{#if hasActions}
				<div class="grid grid-cols-1 gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
					<button
						type="button"
						onclick={() => goto('/rechnungen')}
						class="flex items-start gap-3 rounded-lg border p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 {actions.overdue.count > 0 ? 'border-red-200 bg-red-50/60 hover:bg-red-50 dark:border-red-900/50 dark:bg-red-900/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-700/30'}"
					>
						<span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full {actions.overdue.count > 0 ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-700 dark:text-zinc-400'}">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
						</span>
						<div class="min-w-0">
							<p class="text-2xl font-semibold tabular-nums {actions.overdue.count > 0 ? 'text-red-600 dark:text-red-400' : ''}">{actions.overdue.count}</p>
							<p class="label">{t('overview.overdueInvoices')}</p>
							{#if actions.overdue.count > 0}<p class="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatCurrency(actions.overdue.totalCents / 100)}</p>{/if}
						</div>
					</button>

					<button
						type="button"
						onclick={() => goto('/rechnungen')}
						class="flex items-start gap-3 rounded-lg border p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 {actions.drafts.count > 0 ? 'border-amber-200 bg-amber-50/50 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-700/30'}"
					>
						<span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full {actions.drafts.count > 0 ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-700 dark:text-zinc-400'}">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
						</span>
						<div class="min-w-0">
							<p class="text-2xl font-semibold tabular-nums {actions.drafts.count > 0 ? 'text-amber-600 dark:text-amber-400' : ''}">{actions.drafts.count}</p>
							<p class="label">{t('overview.draftInvoices')}</p>
							{#if actions.drafts.count > 0}<p class="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatCurrency(actions.drafts.totalCents / 100)}</p>{/if}
						</div>
					</button>

					<button
						type="button"
						onclick={() => goto('/eingehende-rechnungen')}
						class="flex items-start gap-3 rounded-lg border p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 {actions.openIncoming.count > 0 ? 'border-blue-200 bg-blue-50/50 hover:bg-blue-50 dark:border-blue-900/50 dark:bg-blue-900/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-700/30'}"
					>
						<span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full {actions.openIncoming.count > 0 ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-700 dark:text-zinc-400'}">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" /></svg>
						</span>
						<div class="min-w-0">
							<p class="text-2xl font-semibold tabular-nums {actions.openIncoming.count > 0 ? 'text-blue-600 dark:text-blue-400' : ''}">{actions.openIncoming.count}</p>
							<p class="label">{t('overview.openBills')}</p>
							{#if actions.openIncoming.count > 0}<p class="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatCurrency(actions.openIncoming.totalCents / 100)}</p>{/if}
						</div>
					</button>
				</div>

				{#if actions.overdue.count > 0}
					<ul class="space-y-0.5 border-t border-zinc-100 pt-3 dark:border-zinc-700/60">
						{#each actions.overdue.items.slice(0, 4) as inv (inv.id)}
							<li>
								<a
									href="/rechnungen/{inv.id}"
									class="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-700/40"
								>
									<span class="flex min-w-0 items-center gap-2">
										<span class="badge badge-red shrink-0">{tp('overview.daysOverdue', { days: daysOverdue(inv.due_date) })}</span>
										<span class="shrink-0 font-medium">{inv.invoice_number}</span>
										<span class="truncate text-zinc-500 dark:text-zinc-400">{inv.customer_name ?? '—'}</span>
									</span>
									<span class="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">{formatCurrency(inv.gross_cents / 100)}</span>
								</a>
							</li>
						{/each}
						{#if actions.overdue.count > 4}
							<li class="px-2 pt-1 text-xs text-zinc-400">+{actions.overdue.count - 4}</li>
						{/if}
					</ul>
				{/if}
			{:else}
				<div class="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/10 dark:text-emerald-300">
					<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
					<span>{t('overview.allClear')}</span>
				</div>
			{/if}
		</section>
	{/if}

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
		</div>
	{/if}
</section>
