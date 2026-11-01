<script lang="ts">
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { getDashboardData, getActionItems, type GroupBy, type PeriodRow, type ActionItems } from '$lib/db/dashboard';
	import { onMount } from 'svelte';
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import AreaChart from '../../common/AreaChart.svelte';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { getOrganizationSettings, getS3Settings } from '$lib/db/settings';
	import { getUstvaData, getEuerData, getEuerReport } from '$lib/db/tax-reports';
	import { getDatevBookingRows } from '$lib/db/datev';
	import { generateUstvaCsv } from '$lib/csv/ustva-csv';
	import { generateEuerCsv } from '$lib/csv/euer-csv';
	import { generateDatevBuchungsstapel } from '$lib/csv/datev-csv';
	import { saveCsvFile, saveDatevFile, savePdfFile } from '$lib/csv/csv-writer';
	import { messageForUnknown } from '$lib/shared/errors';
	import { t, tp, translations } from '$lib/i18n';
	import { cloud } from '$lib/cloud';
	import { can, initials } from '$lib/session.svelte';
	import ActivityFeed from '../../common/ActivityFeed.svelte';
	import { pendingApprovals, approveMonth, unapproveMonth, type PendingRow } from '$lib/team';

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
	// The chart stops at the current period: future months would read as a crash to zero.
	const nowKey = (() => {
		const d = new Date();
		return { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, quarter: `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}` };
	})();
	let chartPoints = $derived(
		groupBy === 'year'
			? periods
			: periods.filter((_, i) => allPeriodKeys(groupBy, year)[i].key <= nowKey[groupBy as 'month' | 'quarter'])
	);
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
	// Figures glide to their new value on year/period change.
	const shown = Tween.of(() => totals, { duration: 600, easing: cubicOut });

	const eyebrow = 'text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400';
	const tone = {
		red: { fig: 'text-red-600 dark:text-red-400', icon: 'bg-red-50 text-red-600 ring-red-600/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20' },
		amber: { fig: 'text-amber-600 dark:text-amber-400', icon: 'bg-amber-50 text-amber-600 ring-amber-600/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20' },
		accent: { fig: 'text-accent-600 dark:text-accent-400', icon: 'bg-accent-50 text-accent-600 ring-accent-600/10 dark:bg-accent-500/10 dark:text-accent-300 dark:ring-accent-400/20' },
		emerald: { fig: 'text-emerald-600 dark:text-emerald-400', icon: '' },
		plain: { fig: 'text-zinc-900 dark:text-zinc-100', icon: 'bg-zinc-100 text-zinc-400 ring-zinc-900/5 dark:bg-zinc-700/60 dark:text-zinc-400 dark:ring-white/10' }
	};
	type Tone = keyof typeof tone;

	const cockpitTiles = $derived(
		actions
			? [
					{ href: '/rechnungen', label: t('overview.overdueInvoices'), item: actions.overdue, tone: 'red' as Tone, icon: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z' },
					{ href: '/rechnungen', label: t('overview.draftInvoices'), item: actions.drafts, tone: 'amber' as Tone, icon: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10' },
					{ href: '/eingehende-rechnungen', label: t('overview.openBills'), item: actions.openIncoming, tone: 'accent' as Tone, icon: 'M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z' }
				]
			: []
	);

	const plTiles = $derived([
		{ label: t('overview.revenue'), value: shown.current.revenue, hint: t('overview.revenueHint'), tone: 'emerald' as Tone },
		{ label: t('overview.expenses'), value: shown.current.costs, hint: t('overview.expensesHint'), tone: 'red' as Tone },
		{ label: t('overview.profit'), value: shown.current.profit, hint: `= ${t('overview.revenue')} − ${t('overview.expenses')}`, tone: (totals.profit >= 0 ? 'emerald' : 'red') as Tone }
	]);
	const vatTiles = $derived([
		{ label: t('overview.vatOut'), value: shown.current.vatOut, hint: t('overview.vatOutHint'), tone: 'plain' as Tone },
		{ label: t('overview.vatIn'), value: shown.current.vatIn, hint: t('overview.vatInHint'), tone: 'plain' as Tone },
		{ label: t('overview.vatPayable'), value: shown.current.vatPayable, hint: `= ${t('overview.vatOut')} − ${t('overview.vatIn')}`, tone: 'accent' as Tone }
	]);

	const periodIndex = $derived(periodOptions.findIndex((o) => o.value === groupBy));

	$effect(() => {
		// track reactive deps
		const _y = year;
		const _g = groupBy;
		loadData();
	});

	// Action items and backup status don't depend on year/grouping: load once.
	// Cloud: months with hours still waiting for the caller's approval.
	let pending = $state<PendingRow[]>([]);
	const pendingPeople = $derived.by(() => {
		const by = new Map<number, { user_id: number; name: string; minutes: number; months: string[] }>();
		for (const p of pending) {
			const e = by.get(p.user_id) ?? { user_id: p.user_id, name: p.user_name, minutes: 0, months: [] };
			e.minutes += p.minutes;
			e.months.push(p.month);
			by.set(p.user_id, e);
		}
		return [...by.values()];
	});
	let approving = $state<number | null>(null);
	async function approvePerson(p: { user_id: number; name: string; months: string[] }) {
		approving = p.user_id;
		try {
			for (const m of p.months) await approveMonth(p.user_id, m);
			const rows = pending.filter((r) => r.user_id === p.user_id);
			pending = pending.filter((r) => r.user_id !== p.user_id);
			// One click without the team page's review: offer an undo (unapprove).
			toasts.success(tp('overview.approvedPerson', { name: p.name }), 6000, {
				label: 'Rückgängig',
				run: async () => {
					try {
						for (const m of p.months) await unapproveMonth(p.user_id, m);
						pending = [...pending, ...rows];
					} catch (err) {
						toasts.error(`${t('overview.approveError')}: ${messageForUnknown(err)}`);
					}
				}
			});
		} catch (err) {
			toasts.error(`${t('overview.approveError')}: ${messageForUnknown(err)}`);
		} finally {
			approving = null;
		}
	}
	onMount(() => {
		if (cloud() && can('team_time', 'edit')) pendingApprovals().then((r) => (pending = r), () => {});
	});

	onMount(async () => {
		actions = await getActionItems(await getCompanyId());
		await loadBackupStatus();
	});

	// Shared so onMount and loadData can't race into creating two companies.
	let companyIdPromise: Promise<number> | null = null;
	function getCompanyId(): Promise<number> {
		return (companyIdPromise ??= ensureCompanyId());
	}

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

	// `loading` only covers the first load; later year/period switches keep the
	// figures on screen so they can tween. `seq` drops out-of-order responses.
	let seq = 0;
	async function loadData() {
		const mine = ++seq;
		const data = await getDashboardData(await getCompanyId(), year, groupBy);
		if (mine !== seq) return;
		revenue = data.revenue;
		costs = data.costs;
		loading = false;
	}

	async function loadBackupStatus(): Promise<void> {
		try {
			const s3 = await getS3Settings(false);
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
	let exportingDatev = $state(false);
	let exportingEuerPeriod = $state(false);
	let euerFrom = $state(`${new Date().getFullYear()}-01-01`);
	let euerTo = $state(`${new Date().getFullYear()}-12-31`);

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
			toasts.error(`${t('overview.exportError')}: ${messageForUnknown(err)}`);
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
			toasts.error(`${t('overview.exportError')}: ${messageForUnknown(err)}`);
		} finally {
			exportingEuer = false;
		}
	}

	async function exportEuerPeriod() {
		if (!euerFrom || !euerTo || euerFrom > euerTo) {
			toasts.error(t('overview.euerPeriodInvalid'));
			return;
		}
		exportingEuerPeriod = true;
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			const report = await getEuerReport(companyId, euerFrom, euerTo);
			const pdfBytes = await (await import('$lib/pdf/euer-pdf')).createEuerPdf(report, {
				companyName: org.name,
				taxNumber: org.vatin,
				createdAt: new Date()
			});
			const saved = await savePdfFile(pdfBytes, `EUER_${euerFrom}_${euerTo}.pdf`);
			if (saved) toasts.success(t('overview.exportSuccess'));
		} catch (err) {
			toasts.error(`${t('overview.exportError')}: ${messageForUnknown(err)}`);
		} finally {
			exportingEuerPeriod = false;
		}
	}

	async function exportDatev() {
		exportingDatev = true;
		try {
			const companyId = await ensureCompanyId();
			const org = await getOrganizationSettings();
			if (
				!/^\d{1,7}$/.test(org.datev_consultant_number) ||
				!/^\d{1,5}$/.test(org.datev_client_number)
			) {
				toasts.error(t('overview.datevMissingSettings'));
				return;
			}
			const bookings = await getDatevBookingRows(companyId, year);
			const csv = generateDatevBuchungsstapel(bookings, {
				consultantNumber: org.datev_consultant_number,
				clientNumber: org.datev_client_number,
				skr: org.datev_skr === '04' ? '04' : '03',
				year,
				generatedAt: new Date()
			});
			const saved = await saveDatevFile(csv, `EXTF_Buchungsstapel_${year}.csv`);
			if (saved) toasts.success(t('overview.exportSuccess'));
		} catch (err) {
			toasts.error(`${t('overview.exportError')}: ${messageForUnknown(err)}`);
		} finally {
			exportingDatev = false;
		}
	}
</script>

{#snippet figureTile(f: { label: string; value: number; hint: string; tone: Tone })}
	<div class="bezel">
		<div class="bezel-core h-full">
			<p class={eyebrow}>{f.label}</p>
			<p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums {tone[f.tone].fig}">{formatCurrency(f.value)}</p>
			<p class="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{f.hint}</p>
		</div>
	</div>
{/snippet}

<section class="space-y-6">
	<!-- Header -->
	<header class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<h1 class="page-header">{t('overview.title')}</h1>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{tp('overview.financialOverview', { year })}</p>
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<!-- Period: segmented control with a sliding thumb -->
			<div class="relative grid grid-cols-3 rounded-full bg-zinc-900/[0.04] p-0.5 ring-1 ring-zinc-900/5 dark:bg-white/[0.05] dark:ring-white/10" role="group" aria-label={t('overview.period')}>
				<span
					class="absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/3)] rounded-full bg-white shadow-soft ring-1 ring-zinc-900/5 transition-transform duration-300 ease-spring dark:bg-zinc-700 dark:ring-white/10"
					style="transform: translateX({periodIndex * 100}%)"
					aria-hidden="true"
				></span>
				{#each periodOptions as opt (opt.value)}
					<button
						type="button"
						aria-pressed={groupBy === opt.value}
						class="relative z-10 rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 {groupBy === opt.value ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}"
						onclick={() => (groupBy = opt.value)}
					>
						{opt.label}
					</button>
				{/each}
			</div>
			<!-- Year switcher -->
			<div class="inline-flex items-center rounded-full bg-zinc-900/[0.04] p-0.5 ring-1 ring-zinc-900/5 dark:bg-white/[0.05] dark:ring-white/10">
				<button aria-label={t('overview.prevYear')} onclick={() => year--} class="icon-btn h-7 w-7 rounded-full">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
				</button>
				<span class="min-w-[3.5rem] text-center text-sm font-semibold tabular-nums">{year}</span>
				<button aria-label={t('overview.nextYear')} onclick={() => year++} class="icon-btn h-7 w-7 rounded-full">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
				</button>
			</div>
		</div>
	</header>

	{#if backupFailed}
		<div
			class="flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-600/15 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-400/20"
			role="alert"
			data-testid="auto-backup-failure-banner"
		>
			<svg class="mt-0.5 h-5 w-5 shrink-0 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9.75v3.75m0 3h.008M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
			<div class="min-w-0 flex-1">
				<p class="font-medium">
					{backupFailedAt
						? tp('overview.autoBackupFailedAt', { date: formatBackupTimestamp(backupFailedAt) })
						: t('overview.autoBackupFailed')}
				</p>
				{#if backupFailureReason}
					<p class="mt-0.5 text-xs opacity-80">
						{t('overview.autoBackupFailureReason')}: {t(`overview.autoBackupReason.${backupFailureReason}`)}
					</p>
				{/if}
			</div>
			<a href="/einstellungen/backup" class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-500/15">
				{t('overview.backupSettings')} →
			</a>
		</div>
	{/if}

	{#if pending.length}
		<section class="card flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between" data-testid="dashboard-pending-approvals">
			<div class="min-w-0 space-y-3">
				<div>
					<p class={eyebrow}>{t('overview.pendingTitle')}</p>
					<p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
						{tp('overview.pendingSummary', { people: pendingPeople.length, months: pending.length })}
					</p>
				</div>
				<ul class="flex flex-wrap gap-2">
					{#each pendingPeople as p (p.user_id)}
						<li class="group flex items-center gap-2 rounded-full bg-zinc-50 py-1 pr-1 pl-1 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:ring-white/10">
							<span class="flex h-7 w-7 items-center justify-center rounded-full bg-accent-100 text-[11px] font-semibold text-accent-700 dark:bg-accent-900/50 dark:text-accent-300" aria-hidden="true">{initials(p.name)}</span>
							<span class="text-sm">{p.name}</span>
							<span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{Math.round(p.minutes / 6) / 10} h</span>
							<button
								type="button"
								class="icon-btn icon-btn-blue h-7 w-7 rounded-full"
								title={tp('overview.approvePerson', { name: p.name })}
								aria-label={tp('overview.approvePerson', { name: p.name })}
								disabled={approving !== null}
								onclick={() => approvePerson(p)}
							>
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
							</button>
						</li>
					{/each}
				</ul>
			</div>
			<a href="/team" class="group inline-flex shrink-0 items-center gap-2 self-start rounded-full bg-accent-600 py-1 pr-1 pl-4 text-sm font-medium text-white shadow-soft transition duration-200 ease-spring hover:bg-accent-700 active:scale-[0.98] sm:self-center">
				{t('overview.approve')}
				<span class="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 transition-transform duration-300 ease-spring group-hover:translate-x-0.5">
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
				</span>
			</a>
		</section>
	{/if}

	<!-- Cockpit: actionable to-dos that need attention -->
	{#if actions}
		<section class="card space-y-4 @container" data-testid="dashboard-cockpit">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 class="text-lg font-semibold tracking-tight">{t('overview.cockpit')}</h2>
				<span class="badge max-w-full {nextDeadline.days <= 7 ? 'badge-amber' : 'badge-zinc'}" title={t('overview.nextDeadline')}>
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5A2.25 2.25 0 015.25 5.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
					{t(nextDeadline.labelKey)}: {nextDeadline.days <= 0 ? t('overview.dueToday') : tp('overview.dueInDays', { days: nextDeadline.days })}
				</span>
			</div>

			{#if hasActions}
				<div class="grid grid-cols-1 gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
					{#each cockpitTiles as tile (tile.label)}
						{@const c = tile.item.count > 0 ? tone[tile.tone] : tone.plain}
						<a href={tile.href} class="bezel group block transition duration-300 ease-spring hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40">
							<div class="bezel-core flex h-full items-start justify-between gap-3">
								<div class="min-w-0">
									<p class={eyebrow}>{tile.label}</p>
									<p class="mt-2 text-3xl font-semibold tracking-tight tabular-nums {tile.item.count > 0 ? c.fig : 'text-zinc-400 dark:text-zinc-500'}">{tile.item.count}</p>
									<p class="mt-1 h-4 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{tile.item.count > 0 ? formatCurrency(tile.item.totalCents / 100) : ''}</p>
								</div>
								<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 transition-transform duration-300 ease-spring group-hover:scale-105 {c.icon}">
									<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d={tile.icon} /></svg>
								</span>
							</div>
						</a>
					{/each}
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
				<div class="flex items-center gap-3 rounded-xl bg-emerald-50/70 p-4 text-sm text-emerald-700 ring-1 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20">
					<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
					<span>{t('overview.allClear')}</span>
				</div>
			{/if}
		</section>
	{/if}

	{#if loading}
		<div class="card space-y-5" aria-busy="true" aria-label={t('overview.loadingData')}>
			<div class="skeleton h-5 w-40"></div>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				{#each [0, 1, 2] as i (i)}
					<div class="bezel"><div class="bezel-core space-y-3"><div class="skeleton h-3 w-20"></div><div class="skeleton h-7 w-32"></div><div class="skeleton h-3 w-40"></div></div></div>
				{/each}
			</div>
			<div class="skeleton h-[220px] w-full rounded-xl"></div>
		</div>
	{:else}
		<!-- Gewinn & Verlust -->
		<div class="card space-y-5">
			<h2 class="text-lg font-semibold tracking-tight">{t('overview.profitLoss')}</h2>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				{#each plTiles as f (f.label)}{@render figureTile(f)}{/each}
			</div>
			{#if periods.length > 1}
				<AreaChart
					points={chartPoints}
					format={formatCurrency}
					labels={{ revenue: t('overview.revenue'), costs: t('overview.expenses'), profit: t('overview.profit') }}
				/>
			{/if}
		</div>

		<!-- Umsatzsteuer -->
		<div class="card space-y-5">
			<h2 class="text-lg font-semibold tracking-tight">{t('overview.vat')}</h2>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				{#each vatTiles as f (f.label)}{@render figureTile(f)}{/each}
			</div>

			{#if periods.length > 1}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-xs">
						<thead>
							<tr class="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
								<th class="pb-2 font-medium">{t('overview.period')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatOut')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatIn')}</th>
								<th class="pb-2 text-right font-medium">{t('overview.vatPayable')}</th>
							</tr>
						</thead>
						<tbody class="tabular-nums">
							{#each periods as p (p.period)}
								<tr class="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-700/50 dark:hover:bg-zinc-700/20">
									<td class="py-2 font-sans text-zinc-600 dark:text-zinc-300">{p.label}</td>
									<td class="py-2 text-right">{formatCurrency(p.vatOut)}</td>
									<td class="py-2 text-right">{formatCurrency(p.vatIn)}</td>
									<td class="py-2 text-right font-medium text-accent-600 dark:text-accent-400">{formatCurrency(p.vatPayable)}</td>
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
				<button onclick={exportUstva} disabled={exportingUstva} class="btn-primary">
					{exportingUstva ? t('overview.exporting') : t('overview.exportUstva')}
				</button>
				<button onclick={exportEuer} disabled={exportingEuer} class="btn-primary">
					{exportingEuer ? t('overview.exporting') : t('overview.exportEuer')}
				</button>
				<button onclick={exportDatev} disabled={exportingDatev} class="btn-primary">
					{exportingDatev ? t('overview.exporting') : t('overview.exportDatev')}
				</button>
			</div>

			<!-- EÜR für frei wählbaren Zeitraum (§ 4 Abs. 3 EStG, Zufluss-/Abflussprinzip) -->
			<div class="flex flex-wrap items-end gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-700/50">
				<div>
					<label class="label" for="euer-period-from">{t('overview.euerPeriodFrom')}</label>
					<input id="euer-period-from" type="date" bind:value={euerFrom} class="input-base input-valid mt-1" />
				</div>
				<div>
					<label class="label" for="euer-period-to">{t('overview.euerPeriodTo')}</label>
					<input id="euer-period-to" type="date" bind:value={euerTo} class="input-base input-valid mt-1" />
				</div>
				<button onclick={exportEuerPeriod} disabled={exportingEuerPeriod} class="btn-primary">
					{exportingEuerPeriod ? t('overview.exporting') : t('overview.exportEuerPeriod')}
				</button>
				<p class="w-full text-xs text-zinc-500 dark:text-zinc-400">{t('overview.euerPeriodHint')}</p>
			</div>
		</div>
	{/if}

	<ActivityFeed />
</section>
