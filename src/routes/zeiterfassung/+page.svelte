<script lang="ts">
	import Select from '../../common/Select.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listClients } from '$lib/db/customers';
	import { listProjects } from '$lib/db/projects';
	import { createTimeEntry, listTimeEntries, updateTimeEntry } from '$lib/db/time-entries';
	import type { Customer, Project, TimeEntry } from '$lib/db/types';
	import { t, tp } from '$lib/i18n';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';

	type TimeEntryRow = TimeEntry & {
		customerName: string;
		projectName: string;
		timeFrameLabel: string;
		durationHoursLabel: string;
	};

	let rows = $state<TimeEntryRow[]>([]);
	let totalCount = $state(0);
	let customers = $state<Customer[]>([]);
	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let formError = $state('');
	let showEntryDialog = $state(false);
	let editingTimeEntryId = $state<number | null>(null);

	const pager = $derived<PagerState>(parsePager(page.url.searchParams));
	const pageCount = $derived(totalPages(totalCount, pager.size));

	let description = $state('');
	let customerId = $state('');
	let projectId = $state('');
	let entryDate = $state('');
	let startTime = $state('08:00');
	let endTime = $state('09:00');

	const timeOptions = buildTimeOptions();

	const customerOptions = $derived.by(() => [
		{ value: '', label: t('timeTracking.noCustomer') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

	const projectOptions = $derived.by(() => [
		{ value: '', label: t('timeTracking.noProject') },
		...projects.map((project) => ({ value: String(project.id), label: project.name }))
	]);

	const startMinutes = $derived.by(() => parseTimeToMinutes(startTime));
	const endMinutes = $derived.by(() => parseTimeToMinutes(endTime));

	const durationHours = $derived.by(() => {
		if (startMinutes === null || endMinutes === null) return 0;
		const diffMinutes = endMinutes - startMinutes;
		if (diffMinutes <= 0 || diffMinutes > 24 * 60) return 0;
		return diffMinutes / 60;
	});

	const canSaveEntry = $derived.by(() => !saving && !!entryDate && !!startTime && !!endTime && durationHours > 0);
	const dialogTitle = $derived.by(() => (editingTimeEntryId === null ? t('timeTracking.createEntry') : t('timeTracking.editEntry')));

	$effect(() => {
		// re-fetch when URL pager changes
		loadData(pager.page, pager.size);
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

	async function loadData(pageNum = pager.page, size = pager.size) {
		loading = true;
		const companyId = await ensureCompanyId();
		const offset = (pageNum - 1) * size;
		const [timeEntriesResult, customerRows, projectRows] = await Promise.all([
			listTimeEntries(companyId, { limit: size, offset }),
			listClients(companyId),
			listProjects(companyId)
		]);
		customers = customerRows;
		projects = projectRows;

		const customerMap = new Map(customerRows.map((customer) => [customer.id, customer.name]));
		const projectMap = new Map(projectRows.map((project) => [project.id, project.name]));

		rows = timeEntriesResult.rows.map((entry) => ({
			...entry,
			customerName: entry.customer_id ? (customerMap.get(entry.customer_id) ?? '—') : '—',
			projectName: entry.project_id ? (projectMap.get(entry.project_id) ?? '—') : '—',
			timeFrameLabel: formatTimeFrame(entry.started_at, entry.ended_at, entry.entry_date),
			durationHoursLabel: formatHours(entry.duration_minutes)
		}));
		totalCount = timeEntriesResult.totalCount;
		loading = false;
	}

	function gotoPage(target: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(target));
		params.set('size', String(pager.size));
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	function resetForm() {
		description = '';
		customerId = '';
		projectId = '';
		entryDate = todayIsoDate();
		startTime = '08:00';
		endTime = '09:00';
		formError = '';
		editingTimeEntryId = null;
	}

	function openCreateDialog() {
		resetForm();
		showEntryDialog = true;
	}

	function openEditDialog(row: TimeEntryRow) {
		editingTimeEntryId = row.id;
		description = row.description ?? '';
		customerId = row.customer_id ? String(row.customer_id) : '';
		projectId = row.project_id ? String(row.project_id) : '';
		entryDate = row.entry_date;
		startTime = toLocalTimeInputValue(row.started_at, row.entry_date) ?? '08:00';
		endTime = toLocalTimeInputValue(row.ended_at, row.entry_date) ?? '09:00';
		formError = '';
		showEntryDialog = true;
	}

	function closeDialog() {
		showEntryDialog = false;
		resetForm();
	}

	function setQuickDuration(minutes: number) {
		if (!startTime) return;
		const start = parseTimeToMinutes(startTime);
		if (start === null) return;
		const next = Math.min(start + minutes, 24 * 60);
		endTime = formatMinutesToTimeValue(next);
	}

	async function saveEntry() {
		formError = '';
		if (!entryDate || startMinutes === null || endMinutes === null || durationHours <= 0) {
			formError = t('timeTracking.errorStartEnd');
			return;
		}

		saving = true;
		try {
			const start = composeDateTime(entryDate, startMinutes);
			const end = composeDateTime(entryDate, endMinutes);
			const minutes = endMinutes - startMinutes;

			if (editingTimeEntryId === null) {
				const companyId = await ensureCompanyId();
				await createTimeEntry({
					company_id: companyId,
					customer_id: customerId ? Number(customerId) : null,
					project_id: projectId ? Number(projectId) : null,
					entry_date: entryDate,
					started_at: start.toISOString(),
					ended_at: end.toISOString(),
					duration_minutes: minutes,
					description: description.trim(),
					billable: 1
				});
			} else {
				await updateTimeEntry(editingTimeEntryId, {
					customer_id: customerId ? Number(customerId) : null,
					project_id: projectId ? Number(projectId) : null,
					entry_date: entryDate,
					started_at: start.toISOString(),
					ended_at: end.toISOString(),
					duration_minutes: minutes,
					description: description.trim()
				});
			}

			closeDialog();
			await loadData();
		} catch {
			formError = t('timeTracking.errorSave');
		} finally {
			saving = false;
		}
	}

	function parseTimeToMinutes(time: string): number | null {
		const match = /^(\d{2}):(\d{2})$/.exec(time);
		if (!match) return null;
		const hours = Number(match[1]);
		const minutes = Number(match[2]);
		if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
		if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
		if (hours === 24 && minutes !== 0) return null;
		return hours * 60 + minutes;
	}

	function formatMinutesToTimeValue(totalMinutes: number): string {
		if (totalMinutes <= 0) return '00:00';
		if (totalMinutes >= 24 * 60) return '24:00';
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
	}

	function composeDateTime(entryDateValue: string, totalMinutes: number): Date {
		const [year, month, day] = entryDateValue.split('-').map(Number);
		const result = new Date(year, month - 1, day, 0, 0, 0, 0);
		result.setMinutes(totalMinutes);
		return result;
	}

	function toLocalTimeInputValue(input: string | null, entryDateValue: string): string | null {
		if (!input) return null;
		const date = new Date(input);
		if (Number.isNaN(date.getTime())) return null;
		const base = new Date(`${entryDateValue}T00:00:00`);
		if (Number.isNaN(base.getTime())) return null;
		const diffMinutes = Math.round((date.getTime() - base.getTime()) / (1000 * 60));
		if (diffMinutes < 0 || diffMinutes > 24 * 60) return null;
		return formatMinutesToTimeValue(diffMinutes);
	}

	function buildTimeOptions() {
		const options: { value: string; label: string }[] = [];
		for (let minutes = 0; minutes <= 24 * 60; minutes += 15) {
			const value = formatMinutesToTimeValue(minutes);
			options.push({ value, label: `${value} Uhr` });
		}
		return options;
	}

	function todayIsoDate(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function formatHours(durationMinutes: number | null): string {
		if (!durationMinutes || durationMinutes <= 0) return '0,00 h';
		return `${(durationMinutes / 60).toFixed(2).replace('.', ',')} h`;
	}

	function formatDateTime(input: string | null): string {
		if (!input) return '—';
		const date = new Date(input);
		if (Number.isNaN(date.getTime())) return '—';
		return date.toLocaleString('de-DE', {
			dateStyle: 'short',
			timeStyle: 'short'
		});
	}

	function formatTimeFrame(startedAt: string | null, endedAt: string | null, fallbackDate: string): string {
		if (startedAt || endedAt) {
			return `${formatDateTime(startedAt)} – ${formatDateTime(endedAt)}`;
		}
		return fallbackDate;
	}
</script>

<section class="space-y-6">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-xl font-semibold tracking-tight">{t('timeTracking.entriesTitle')}</h2>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('timeTracking.entriesSubtitle')}</p>
		</div>
		<button type="button" onclick={openCreateDialog} class="btn-primary">{t('timeTracking.newEntry')}</button>
	</header>

	{#if showEntryDialog}
		<button type="button" aria-label={t('common.close')} class="fixed inset-0 z-40 bg-black/45" onclick={closeDialog}></button>
		<div class="fixed inset-0 z-50 grid place-items-center p-4">
			<div class="w-full max-w-2xl rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900" role="dialog" aria-modal="true" aria-label={dialogTitle}>
				<div class="mb-3 flex items-center justify-between">
					<h3 class="text-lg font-semibold">{dialogTitle}</h3>
					<button type="button" onclick={closeDialog} class="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600">{t('common.close')}</button>
				</div>
				<div class="grid gap-3 md:grid-cols-2">
					<TextInput bind:value={description} label={t('common.description')} placeholder="Workshop Vorbereitung" />
					<Select bind:value={customerId} label={t('timeTracking.customer')} options={customerOptions} placeholder={t('timeTracking.customerPlaceholder')} />
					<Select bind:value={projectId} label={t('timeTracking.project')} options={projectOptions} placeholder={t('timeTracking.projectPlaceholder')} />
					<div class="flex flex-col gap-1">
						<label for="entry-date" class="label">{t('common.date')}</label>
						<input id="entry-date" type="date" bind:value={entryDate} class="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-700" />
					</div>
					<Select bind:value={startTime} label={t('timeTracking.startTime')} options={timeOptions} />
					<Select bind:value={endTime} label={t('timeTracking.endTime')} options={timeOptions} />
				</div>
				<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
					<span class="text-zinc-500 dark:text-zinc-400">{t('timeTracking.quickSelect')}:</span>
					<button type="button" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600" onclick={() => setQuickDuration(30)}>+30 min</button>
					<button type="button" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600" onclick={() => setQuickDuration(60)}>+1 h</button>
					<button type="button" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600" onclick={() => setQuickDuration(90)}>+1,5 h</button>
					<button type="button" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600" onclick={() => setQuickDuration(120)}>+2 h</button>
				</div>
				<div class="mt-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
					<span class="text-zinc-500 dark:text-zinc-400">{t('timeTracking.durationAuto')}:</span>
					<span class="ml-2 font-medium">{durationHours.toFixed(2).replace('.', ',')} h</span>
				</div>
				{#if formError}
					<p class="mt-2 text-sm text-red-600 dark:text-red-400">{formError}</p>
				{/if}
				<div class="mt-4 flex justify-end gap-2">
					<button type="button" onclick={closeDialog} class="btn-secondary">{t('common.cancel')}</button>
					<button type="button" onclick={saveEntry} disabled={!canSaveEntry} class="btn-primary">
						{saving ? t('common.saving') : t('common.save')}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<div class="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/40">
		<div class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" style="grid-template-columns: 1.2fr 0.9fr 0.9fr 1.5fr 0.8fr 0.8fr">
			<div class="px-4 py-3">{t('common.description')}</div>
			<div class="px-4 py-3">{t('timeTracking.customer')}</div>
			<div class="px-4 py-3">{t('timeTracking.project')}</div>
			<div class="px-4 py-3">{t('timeTracking.timeRange')}</div>
			<div class="px-4 py-3">{t('timeTracking.duration')}</div>
			<div class="px-4 py-3 text-right">{t('common.action')}</div>
		</div>

		{#if loading}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.loading')}</div>
		{:else if rows.length === 0}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.empty')}</div>
		{:else}
			<div class="max-h-[520px] overflow-y-auto">
				{#each rows as row (row.id)}
					<div class="grid items-center border-b border-zinc-100 text-sm text-zinc-700 last:border-0 dark:border-zinc-700/70 dark:text-zinc-200" style="grid-template-columns: 1.2fr 0.9fr 0.9fr 1.5fr 0.8fr 0.8fr; min-height: 44px">
						<div class="truncate px-4 py-2">{row.description || '—'}</div>
						<div class="truncate px-4 py-2">{row.customerName}</div>
						<div class="truncate px-4 py-2">{row.projectName}</div>
						<div class="truncate px-4 py-2">{row.timeFrameLabel}</div>
						<div class="truncate px-4 py-2">{row.durationHoursLabel}</div>
						<div class="px-4 py-2 text-right"><button type="button" onclick={() => openEditDialog(row)} class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium dark:border-zinc-600">{t('common.edit')}</button></div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if !loading && totalCount > 0}
		<div class="flex items-center justify-between gap-3">
			<button
				type="button"
				class="btn-secondary"
				disabled={pager.page <= 1}
				onclick={() => gotoPage(pager.page - 1)}
			>
				{t('common.pagerPrev')}
			</button>
			<span class="text-sm text-zinc-600 dark:text-zinc-300">
				{tp('common.pagerPageOf', { page: pager.page, total: pageCount })}
			</span>
			<button
				type="button"
				class="btn-secondary"
				disabled={pager.page >= pageCount}
				onclick={() => gotoPage(pager.page + 1)}
			>
				{t('common.pagerNext')}
			</button>
		</div>
	{/if}
</section>
