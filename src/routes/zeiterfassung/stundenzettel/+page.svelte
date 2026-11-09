<script lang="ts">
	import { t, tp } from '$lib/i18n';
	import DateInput from '../../../common/DateInput.svelte';
	import Select from '../../../common/Select.svelte';
	import EmptyState from '../../../common/EmptyState.svelte';
	import SkeletonRows from '../../../common/SkeletonRows.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listClients } from '$lib/db/customers';
	import { listProjects } from '$lib/db/projects';
	import { listTimesheetEntries } from '$lib/db/time-entries';
	import type { Customer, Project, TimeEntry } from '$lib/db/types';
	import { writeBinaryFile } from '$lib/fs';
	import { messageForUnknown } from '$lib/shared/errors';
	import { save } from '@tauri-apps/plugin-dialog';

	type GroupingMode = 'customer-date' | 'customer-week';
	type TimeSheetRow = TimeEntry & { customerName: string };
	type GroupedTimeSheet = {
		groupKey: string;
		customerName: string;
		periodLabel: string;
		totalMinutes: number;
		entries: TimeSheetRow[];
	};

	let loading = $state(true);
	let rows = $state<TimeEntry[]>([]);
	let companyId = $state<number | null>(null);
	let customers = $state<Customer[]>([]);
	let projects = $state<Project[]>([]);

	let periodStart = $state('');
	let periodEnd = $state('');
	let selectedCustomerId = $state('all');
	let selectedProjectId = $state('all');
	let grouping = $state<GroupingMode>('customer-date');

	const customerOptions = $derived.by(() => [
		{ value: 'all', label: t('timeTracking.allCustomers') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

	const projectOptions = $derived.by(() => [
		{ value: 'all', label: t('timeTracking.allProjects') },
		...projects
			.filter((project) => selectedCustomerId === 'all' || project.customer_id === Number(selectedCustomerId))
			.map((project) => ({ value: String(project.id), label: project.name }))
	]);

	$effect(() => {
		// Drop a project selection that no longer belongs to the chosen customer.
		if (!projectOptions.some((option) => option.value === selectedProjectId)) selectedProjectId = 'all';
	});

	const groupingOptions = $derived([
		{ value: 'customer-date', label: t('timeTracking.groupByDate') },
		{ value: 'customer-week', label: t('timeTracking.groupByWeek') }
	]);

	const filteredRows = $derived.by(() => {
		const customerMap = new Map(customers.map((customer) => [customer.id, customer.name]));
		return rows.map((entry) => ({
			...entry,
			customerName: entry.customer_id ? (customerMap.get(entry.customer_id) ?? '—') : '—'
		}));
	});

	const groupedRows = $derived.by(() => {
		const grouped = new Map<string, GroupedTimeSheet>();

		for (const entry of filteredRows) {
			const periodLabel =
				grouping === 'customer-week'
					? formatWeekLabel(entry.entry_date)
					: formatDate(entry.entry_date);
			const periodKey = grouping === 'customer-week' ? getIsoWeekKey(entry.entry_date) : entry.entry_date;
			const groupKey = `${entry.customer_id ?? 0}-${periodKey}`;
			const existing = grouped.get(groupKey);

			if (existing) {
				existing.entries.push(entry);
				existing.totalMinutes += entry.duration_minutes ?? 0;
				continue;
			}

			grouped.set(groupKey, {
				groupKey,
				customerName: entry.customerName,
				periodLabel,
				totalMinutes: entry.duration_minutes ?? 0,
				entries: [entry]
			});
		}

		return Array.from(grouped.values()).sort((a, b) => a.periodLabel.localeCompare(b.periodLabel));
	});

	const totalHoursLabel = $derived.by(() => {
		const totalMinutes = filteredRows.reduce((sum, entry) => sum + (entry.duration_minutes ?? 0), 0);
		return formatHours(totalMinutes);
	});

	$effect(() => {
		loadData();
	});

	$effect(() => {
		const filter = {
			from: periodStart,
			to: periodEnd,
			customerId: selectedCustomerId !== 'all' ? Number(selectedCustomerId) : null,
			projectId: selectedProjectId !== 'all' ? Number(selectedProjectId) : null
		};
		if (companyId !== null) loadEntries(companyId, filter);
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
		const id = await ensureCompanyId();
		[customers, projects] = await Promise.all([listClients(id), listProjects(id)]);
		companyId = id;
	}

	let loadSeq = 0;
	async function loadEntries(id: number, filter: Parameters<typeof listTimesheetEntries>[1]) {
		const seq = ++loadSeq;
		loading = true;
		const result = await listTimesheetEntries(id, filter);
		if (seq !== loadSeq) return; // a newer filter change superseded this load
		rows = result;
		loading = false;
	}

	function formatDate(dateString: string): string {
		const date = new Date(dateString);
		if (Number.isNaN(date.getTime())) return t('timeTracking.invalidDate');
		return date.toLocaleDateString('de-DE', { dateStyle: 'medium' });
	}

	function formatWeekLabel(dateString: string): string {
		const [year, week] = getIsoWeekKey(dateString).split('-W');
		return `${t('timeTracking.weekLabel')} ${week}/${year}`;
	}

	function getIsoWeekKey(dateString: string): string {
		const date = new Date(`${dateString}T00:00:00`);
		if (Number.isNaN(date.getTime())) return '0000-W00';

		const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
		const dayNr = (target.getUTCDay() + 6) % 7;
		target.setUTCDate(target.getUTCDate() - dayNr + 3);
		const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
		const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
		firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
		const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604800000);

		return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
	}

	let pdfLoading = $state(false);
	let pdfError = $state('');

	async function exportPdf() {
		pdfError = '';

		const filters = [
			periodStart ? `Von ${formatDate(periodStart)}` : 'Von: beliebig',
			periodEnd ? `Bis ${formatDate(periodEnd)}` : 'Bis: beliebig',
			selectedCustomerId === 'all'
				? 'Kunde: alle'
				: `Kunde: ${customers.find((customer) => customer.id === Number(selectedCustomerId))?.name ?? '—'}`,
			selectedProjectId === 'all'
				? 'Projekt: alle'
				: `Projekt: ${projects.find((project) => project.id === Number(selectedProjectId))?.name ?? '—'}`,
			grouping === 'customer-week' ? 'Gruppierung: Woche' : 'Gruppierung: Datum'
		].join(' · ');

		const filePath = await save({
			title: t('timeUi.saveTimesheet'),
			defaultPath: `Stundenzettel-${new Date().toISOString().slice(0, 10)}.pdf`,
			filters: [{ name: 'PDF', extensions: ['pdf'] }]
		});
		if (!filePath) return;

		pdfLoading = true;
		try {
			const pdfBytes = await (await import('$lib/pdf/timesheet-pdf-writer')).createTimesheetPdf({
				createdAtLabel: new Date().toLocaleString('de-DE'),
				filtersLabel: filters,
				totalHoursLabel,
				groups: groupedRows.map((group) => ({
					customerName: group.customerName,
					periodLabel: group.periodLabel,
					totalLabel: formatHours(group.totalMinutes),
					entries: group.entries.map((entry) => ({
						entryDate: formatDate(entry.entry_date),
						description: entry.description || '—',
						durationLabel: formatHours(entry.duration_minutes ?? 0)
					}))
				}))
			});
			await writeBinaryFile(filePath, pdfBytes);
		} catch (err) {
			pdfError = tp('timeUi.pdfExportFailed', { error: messageForUnknown(err) });
		} finally {
			pdfLoading = false;
		}
	}

	function formatHours(durationMinutes: number): string {
		return `${(durationMinutes / 60).toFixed(2).replace('.', ',')} h`;
	}
</script>

<section class="space-y-5">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">{t('timeTracking.timesheetTitle')}</h2>
			<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.timesheetSubtitle')}</p>
		</div>
		<button type="button" onclick={exportPdf} disabled={pdfLoading || groupedRows.length === 0} class="btn-secondary">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
			{pdfLoading ? 'Exportiere…' : t('timeTracking.printPdf')}
		</button>
	</header>

	{#if pdfError}
		<div class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-600/15 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/20">{pdfError}</div>
	{/if}

	<div class="card grid gap-3 md:grid-cols-2 xl:grid-cols-5">
		<DateInput bind:value={periodStart} label={t('timeTracking.periodFrom')} max={periodEnd || ''} />
		<DateInput bind:value={periodEnd} label={t('timeTracking.periodTo')} min={periodStart || ''} />
		<Select bind:value={selectedCustomerId} label={t('timeTracking.customer')} options={customerOptions} />
		<Select bind:value={selectedProjectId} label={t('timeTracking.project')} options={projectOptions} />
		<Select bind:value={grouping} label={t('timeTracking.grouping')} options={groupingOptions} />
	</div>

	<div class="grid gap-3 md:grid-cols-3">
		{#each [{ label: t('timeTracking.hits'), value: String(filteredRows.length) }, { label: t('timeTracking.groups'), value: String(groupedRows.length) }, { label: t('timeTracking.totalDuration'), value: totalHoursLabel }] as stat (stat.label)}
			<div class="card">
				<div class="text-xs font-medium text-zinc-500 dark:text-zinc-400">{stat.label}</div>
				<div class="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-100">{stat.value}</div>
			</div>
		{/each}
	</div>

	<div class="table-card">
		{#if loading}
			<SkeletonRows rows={5} cols={3} />
		{:else if groupedRows.length === 0}
			<EmptyState
				icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
				title={t('timeTracking.emptyTimesheet')}
			/>
		{:else}
			<div class="divide-y divide-zinc-100 dark:divide-zinc-700/70">
				{#each groupedRows as group (group.groupKey)}
					<div class="space-y-3 p-4">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<div>
								<h3 class="font-medium text-zinc-900 dark:text-zinc-100">{group.customerName}</h3>
								<p class="text-xs text-zinc-500 dark:text-zinc-400">{group.periodLabel}</p>
							</div>
							<div class="text-sm font-semibold tabular-nums">{formatHours(group.totalMinutes)}</div>
						</div>

						<div class="overflow-hidden rounded-lg ring-1 ring-zinc-900/5 dark:ring-white/10">
							<div class="grid grid-cols-[140px_1fr_90px] bg-zinc-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
								<div>{t('common.date')}</div>
								<div>{t('common.description')}</div>
								<div class="text-right">{t('timeTracking.duration')}</div>
							</div>
							{#each group.entries as entry (entry.id)}
								<div class="grid grid-cols-[140px_1fr_90px] border-t border-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700/70 dark:text-zinc-200">
									<div class="text-xs tabular-nums leading-5 text-zinc-500 dark:text-zinc-400">{formatDate(entry.entry_date)}</div>
									<div class="truncate">{entry.description || '—'}</div>
									<div class="text-right tabular-nums">{formatHours(entry.duration_minutes ?? 0)}</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
