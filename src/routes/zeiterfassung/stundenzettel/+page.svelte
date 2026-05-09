<script lang="ts">
	import { t } from '$lib/i18n';
	import DateInput from '../../../common/DateInput.svelte';
	import Select from '../../../common/Select.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listClients } from '$lib/db/customers';
	import { listTimeEntries } from '$lib/db/time-entries';
	import type { Customer, TimeEntry } from '$lib/db/types';
	import { createTimesheetPdf } from '$lib/pdf/timesheet-pdf-writer';
	import { invoke } from '@tauri-apps/api/core';
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
	let rows = $state<TimeSheetRow[]>([]);
	let customers = $state<Customer[]>([]);

	let periodStart = $state('');
	let periodEnd = $state('');
	let selectedCustomerId = $state('all');
	let grouping = $state<GroupingMode>('customer-date');

	const customerOptions = $derived.by(() => [
		{ value: 'all', label: t('timeTracking.allCustomers') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

	const groupingOptions = $derived([
		{ value: 'customer-date', label: t('timeTracking.groupByDate') },
		{ value: 'customer-week', label: t('timeTracking.groupByWeek') }
	]);

	const filteredRows = $derived.by(() => {
		const start = periodStart ? new Date(`${periodStart}T00:00:00`) : null;
		const end = periodEnd ? new Date(`${periodEnd}T23:59:59`) : null;
		const selectedId = selectedCustomerId !== 'all' ? Number(selectedCustomerId) : null;

		return rows.filter((entry) => {
			const date = new Date(entry.entry_date);
			if (Number.isNaN(date.getTime())) return false;
			if (start && date < start) return false;
			if (end && date > end) return false;
			if (selectedId && entry.customer_id !== selectedId) return false;
			return true;
		});
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
		const [entriesResult, customerRows] = await Promise.all([listTimeEntries(companyId), listClients(companyId)]);

		customers = customerRows;
		const customerMap = new Map(customerRows.map((customer) => [customer.id, customer.name]));

		rows = entriesResult.rows.map((entry) => ({
			...entry,
			customerName: entry.customer_id ? (customerMap.get(entry.customer_id) ?? '—') : '—'
		}));
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
			grouping === 'customer-week' ? 'Gruppierung: Woche' : 'Gruppierung: Datum'
		].join(' · ');

		const filePath = await save({
			title: 'Stundenzettel speichern',
			defaultPath: `Stundenzettel-${new Date().toISOString().slice(0, 10)}.pdf`,
			filters: [{ name: 'PDF', extensions: ['pdf'] }]
		});
		if (!filePath) return;

		pdfLoading = true;
		try {
			const pdfBytes = await createTimesheetPdf({
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
			await invoke('write_binary_file', { path: filePath, data: Array.from(pdfBytes) });
		} catch (err) {
			pdfError = `PDF-Export fehlgeschlagen: ${err}`;
		} finally {
			pdfLoading = false;
		}
	}

	function formatHours(durationMinutes: number): string {
		return `${(durationMinutes / 60).toFixed(2).replace('.', ',')} h`;
	}
</script>

<section class="space-y-6">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-xl font-semibold tracking-tight">{t('timeTracking.timesheetTitle')}</h2>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('timeTracking.timesheetSubtitle')}</p>
		</div>
		<button type="button" onclick={exportPdf} disabled={pdfLoading} class="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-600">
			{pdfLoading ? 'Exportiere…' : t('timeTracking.printPdf')}
		</button>
	</header>

	{#if pdfError}
		<div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{pdfError}</div>
	{/if}

	<div class="grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-4 dark:border-zinc-700 dark:bg-zinc-800/40">
		<DateInput bind:value={periodStart} label={t('timeTracking.periodFrom')} max={periodEnd || ''} />
		<DateInput bind:value={periodEnd} label={t('timeTracking.periodTo')} min={periodStart || ''} />
		<Select bind:value={selectedCustomerId} label={t('timeTracking.customer')} options={customerOptions} />
		<Select bind:value={grouping} label={t('timeTracking.grouping')} options={groupingOptions} />
	</div>

	<div class="grid gap-3 md:grid-cols-3">
		<div class="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
			<div class="text-xs text-zinc-500 dark:text-zinc-400">{t('timeTracking.hits')}</div>
			<div class="mt-1 text-lg font-semibold">{filteredRows.length} {t('timeTracking.timeEntries')}</div>
		</div>
		<div class="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
			<div class="text-xs text-zinc-500 dark:text-zinc-400">{t('timeTracking.groups')}</div>
			<div class="mt-1 text-lg font-semibold">{groupedRows.length}</div>
		</div>
		<div class="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
			<div class="text-xs text-zinc-500 dark:text-zinc-400">{t('timeTracking.totalDuration')}</div>
			<div class="mt-1 text-lg font-semibold">{totalHoursLabel}</div>
		</div>
	</div>

	<div class="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/40">
		{#if loading}
			<div class="px-4 py-8 text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.loadingTimesheet')}</div>
		{:else if groupedRows.length === 0}
			<div class="px-4 py-8 text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.emptyTimesheet')}</div>
		{:else}
			<div class="divide-y divide-zinc-200 dark:divide-zinc-700">
				{#each groupedRows as group (group.groupKey)}
					<div class="space-y-2 p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div>
								<h3 class="font-medium">{group.customerName}</h3>
								<p class="text-xs text-zinc-500 dark:text-zinc-400">{group.periodLabel}</p>
							</div>
							<div class="text-sm font-semibold">{formatHours(group.totalMinutes)}</div>
						</div>

						<div class="overflow-hidden rounded-md border border-zinc-100 dark:border-zinc-700">
							<div class="grid grid-cols-[140px,1fr,90px] bg-zinc-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
								<div>{t('common.date')}</div>
								<div>{t('common.description')}</div>
								<div>{t('timeTracking.duration')}</div>
							</div>
							{#each group.entries as entry (entry.id)}
								<div class="grid grid-cols-[140px,1fr,90px] border-t border-zinc-100 px-3 py-2 text-sm dark:border-zinc-700">
									<div>{formatDate(entry.entry_date)}</div>
									<div class="truncate">{entry.description || '—'}</div>
									<div>{formatHours(entry.duration_minutes ?? 0)}</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
