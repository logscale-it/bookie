<script lang="ts">
	import Select from '../../common/Select.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import Dialog from '../../common/Dialog.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { deferDelete } from '$lib/ui/undo';
	import { isPlainKey, isSaveKey } from '$lib/ui/shortcut';
	import { timer, type StoppedEntry } from '$lib/ui/timer.svelte';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listClients } from '$lib/db/customers';
	import { listProjects } from '$lib/db/projects';
	import { createTimeEntry, deleteTimeEntry, listTimeEntries, updateTimeEntry } from '$lib/db/time-entries';
	import { spanMinutes } from '$lib/timespan';
	import type { Customer, Project, TimeEntry } from '$lib/db/types';
	import { t, tp } from '$lib/i18n';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';
	import { cloud } from '$lib/cloud';
	import { can, initials, isSub, memberName, session } from '$lib/session.svelte';

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
	// Rows hidden while their undo window runs; the real delete happens after.
	const pendingDeletes = new SvelteSet<number>();
	const visibleRows = $derived(rows.filter((row) => !pendingDeletes.has(row.id)));
	let formError = $state('');
	let showEntryDialog = $state(false);
	let editingTimeEntryId = $state<number | null>(null);
	let filterCustomerId = $state('all');
	let filterProjectId = $state('all');
	let filterUserId = $state('all');
	// Cloud with the team_time grant: other members' entries are listed too, so show and filter by author.
	const teamView = cloud() && can('team_time') && (session.me?.active?.members.length ?? 0) > 1;
	// Others' entries are view-only without team_time:edit (server scopes PATCH/DELETE to 'edit').
	const mayChange = (row: { user_id?: number | null }) => !cloud() || row.user_id == null || row.user_id === session.me?.user.id || can('team_time', 'edit');
	const filterUserOptions = [
		{ value: 'all', label: 'Alle Mitarbeiter' },
		...(session.me?.active?.members ?? []).map((m) => ({ value: String(m.id), label: m.name }))
	];

	const pager = $derived<PagerState>(parsePager(page.url.searchParams));
	const pageCount = $derived(totalPages(totalCount, pager.size));

	let description = $state('');
	let customerId = $state('');
	let projectId = $state('');
	let entryDate = $state('');
	let startTime = $state('08:00');
	let endTime = $state('17:00');
	let pauseMinutes = $state(60);

	const customerOptions = $derived.by(() => [
		{ value: '', label: t('timeTracking.noCustomer') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

	// Subcontractors must book on an assigned project (server: 400 unknown_project_id otherwise).
	const projectOptions = $derived.by(() => [
		...(isSub() ? [] : [{ value: '', label: t('timeTracking.noProject') }]),
		...projects.map((project) => ({ value: String(project.id), label: project.name }))
	]);

	const filterCustomerOptions = $derived.by(() => [
		{ value: 'all', label: t('timeTracking.allCustomers') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

	const filterProjectOptions = $derived.by(() => [
		{ value: 'all', label: t('timeTracking.allProjects') },
		...projects
			.filter((project) => filterCustomerId === 'all' || project.customer_id === Number(filterCustomerId))
			.map((project) => ({ value: String(project.id), label: project.name }))
	]);

	$effect(() => {
		// Drop a project selection that no longer belongs to the chosen customer.
		if (!filterProjectOptions.some((option) => option.value === filterProjectId)) filterProjectId = 'all';
	});

	const startMinutes = $derived.by(() => parseTimeToMinutes(startTime));
	const endMinutes = $derived.by(() => parseTimeToMinutes(endTime));

	const pause = $derived.by(() => Math.max(0, Number(pauseMinutes) || 0));

	const durationHours = $derived.by(() => {
		if (startMinutes === null || endMinutes === null) return 0;
		const diffMinutes = spanMinutes(startMinutes, endMinutes, pause);
		if (diffMinutes <= 0 || diffMinutes > 24 * 60) return 0;
		return diffMinutes / 60;
	});

	const canSaveEntry = $derived.by(() => !saving && !!entryDate && !!startTime && !!endTime && durationHours > 0 && (!isSub() || !!projectId));
	const dialogTitle = $derived.by(() => (editingTimeEntryId === null ? t('timeTracking.createEntry') : t('timeTracking.editEntry')));

	$effect(() => {
		// re-fetch when URL pager or filters change
		void filterCustomerId;
		void filterProjectId;
		void filterUserId;
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

	let loadSeq = 0;
	async function loadData(pageNum = pager.page, size = pager.size) {
		const seq = ++loadSeq;
		loading = true;
		const filter = {
			customerId: filterCustomerId !== 'all' ? Number(filterCustomerId) : null,
			projectId: filterProjectId !== 'all' ? Number(filterProjectId) : null,
			userId: filterUserId !== 'all' ? Number(filterUserId) : null
		};
		const companyId = await ensureCompanyId();
		const offset = (pageNum - 1) * size;
		const [timeEntriesResult, customerRows, projectRows] = await Promise.all([
			listTimeEntries(companyId, { limit: size, offset, ...filter }),
			listClients(companyId),
			listProjects(companyId)
		]);
		if (seq !== loadSeq) return; // a newer filter/page change superseded this load
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

	function resetToFirstPage() {
		if (pager.page > 1) gotoPage(1);
	}

	function resetForm() {
		description = '';
		// Prefill the project of the newest listed entry if still active, else the first active one.
		const active = projects.filter((project) => project.status === 'active');
		const activeProject = active.find((project) => project.id === rows[0]?.project_id) ?? active[0];
		projectId = activeProject ? String(activeProject.id) : '';
		customerId = activeProject?.customer_id ? String(activeProject.customer_id) : '';
		entryDate = todayIsoDate();
		startTime = '08:00';
		endTime = '17:00';
		pauseMinutes = 60;
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
		endTime = toLocalTimeInputValue(row.ended_at, row.entry_date) ?? '17:00';
		// Pause is not stored — derive it as gross time span minus booked duration.
		const start = parseTimeToMinutes(startTime);
		const end = parseTimeToMinutes(endTime);
		pauseMinutes =
			start !== null && end !== null && row.duration_minutes ? Math.max(0, spanMinutes(start, end, row.duration_minutes)) : 0;
		formError = '';
		showEntryDialog = true;
	}

	const COLS = 'minmax(0,1.3fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.5fr) minmax(0,0.7fr) 6rem';

	const quickDurations = [
		{ minutes: 30, label: '+30 min' },
		{ minutes: 60, label: '+1 h' },
		{ minutes: 90, label: '+1,5 h' },
		{ minutes: 120, label: '+2 h' }
	];

	// Sidebar timer stopped → open a prefilled new entry (once projects are loaded for the defaults).
	$effect(() => {
		const stopped = timer.lastStopped;
		if (!stopped || loading || !page.url.searchParams.has('fromTimer')) return;
		timer.lastStopped = null;
		openFromTimer(stopped);
		const params = new URLSearchParams(page.url.searchParams);
		params.delete('fromTimer');
		goto(`?${params.toString()}`, { replaceState: true, keepFocus: true, noScroll: true });
	});

	function onKeydown(e: KeyboardEvent) {
		if (showEntryDialog && isSaveKey(e)) {
			e.preventDefault();
			if (canSaveEntry) saveEntry();
		} else if (isPlainKey(e, 'n')) {
			e.preventDefault();
			openCreateDialog();
		}
	}

	// The stopped timer span lives only in this dialog: cancelling it offers a
	// restore so the tracked time is never silently lost.
	let timerDraft: StoppedEntry | null = null;
	function openFromTimer(stopped: StoppedEntry) {
		resetForm();
		timerDraft = stopped;
		entryDate = stopped.date;
		startTime = stopped.startTime;
		endTime = stopped.endTime;
		pauseMinutes = 0;
		description = stopped.description;
		if (stopped.projectId) projectId = stopped.projectId;
		if (stopped.customerId) customerId = stopped.customerId;
		showEntryDialog = true;
	}

	function closeDialog() {
		const draft = timerDraft;
		timerDraft = null;
		showEntryDialog = false;
		resetForm();
		if (draft)
			toasts.info('Timer-Zeit nicht gespeichert', 10000, {
				label: 'Wiederherstellen',
				run: () => openFromTimer(draft)
			});
	}

	function setQuickDuration(minutes: number) {
		if (!startTime) return;
		const start = parseTimeToMinutes(startTime);
		if (start === null) return;
		// Quick buttons mean net working time, so the pause is added on top; wrapping past 24:00 becomes a next-day end.
		const next = start + minutes + pause;
		endTime = formatMinutesToTimeValue(next % (24 * 60));
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
			const end = composeDateTime(entryDate, endMinutes < startMinutes ? endMinutes + 24 * 60 : endMinutes);
			const minutes = spanMinutes(startMinutes, endMinutes, pause);

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

			timerDraft = null;
			closeDialog();
			await loadData();
		} catch {
			formError = t('timeTracking.errorSave');
		} finally {
			saving = false;
		}
	}

	function handleDelete(row: TimeEntryRow) {
		deferDelete({
			message: t('timeTracking.deleted'),
			errorMessage: t('timeTracking.errorDelete'),
			hide: () => pendingDeletes.add(row.id),
			restore: () => pendingDeletes.delete(row.id),
			run: () => deleteTimeEntry(row.id),
			onDone: async () => {
				// If that emptied a non-first page, step back a page; else refresh counts.
				if (visibleRows.length === 0 && pager.page > 1) gotoPage(pager.page - 1);
				else await loadData();
				pendingDeletes.delete(row.id);
			}
		});
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
		let diffMinutes = Math.round((date.getTime() - base.getTime()) / (1000 * 60));
		// Overnight entries end on the next day: fold back to a clock time; the auto-detect re-adds the day on save.
		if (diffMinutes >= 24 * 60 && diffMinutes <= 48 * 60) diffMinutes -= 24 * 60;
		if (diffMinutes < 0 || diffMinutes > 24 * 60) return null;
		return formatMinutesToTimeValue(diffMinutes);
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

<svelte:window onkeydown={onKeydown} />

<section class="space-y-5">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">{t('timeTracking.entriesTitle')}</h2>
			<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.entriesSubtitle')}</p>
		</div>
		<button type="button" onclick={openCreateDialog} class="btn-primary">
			{t('timeTracking.newEntry')}
			<span class="kbd border-white/20 bg-white/10 text-current opacity-70">N</span>
		</button>
	</header>

	<Dialog bind:open={showEntryDialog} title={dialogTitle} size="lg" onclose={resetForm}>
		<div class="grid gap-3 sm:grid-cols-4">
			<div class="sm:col-span-4">
				<TextInput bind:value={description} label={t('common.description')} placeholder="Workshop Vorbereitung" />
			</div>
			<div class="sm:col-span-2"><Select bind:value={customerId} label={t('timeTracking.customer')} options={customerOptions} placeholder={t('timeTracking.customerPlaceholder')} /></div>
			<div class="sm:col-span-2"><Select bind:value={projectId} label={t('timeTracking.project')} options={projectOptions} placeholder={t('timeTracking.projectPlaceholder')} /></div>
			<div class="flex flex-col gap-1">
				<label for="entry-date" class="label">{t('common.date')}</label>
				<input id="entry-date" type="date" bind:value={entryDate} class="input-base input-valid" />
			</div>
			<div class="grid grid-cols-3 gap-3 sm:col-span-3">
				<div class="flex flex-col gap-1">
					<label for="entry-start" class="label">{t('timeTracking.startTime')}</label>
					<input id="entry-start" type="time" step="900" bind:value={startTime} class="input-base input-valid tabular-nums" />
				</div>
				<div class="flex flex-col gap-1">
					<label for="entry-end" class="label">{t('timeTracking.endTime')}</label>
					<input id="entry-end" type="time" step="900" bind:value={endTime} class="input-base tabular-nums {durationHours > 0 ? 'input-valid' : 'input-error'}" />
				</div>
				<div class="flex flex-col gap-1">
					<label for="entry-pause" class="label">{t('timeTracking.pause')}</label>
					<input id="entry-pause" type="number" min="0" step="15" bind:value={pauseMinutes} class="input-base input-valid tabular-nums" />
				</div>
			</div>
		</div>
		<div class="mt-4 flex flex-wrap items-center gap-1.5">
			<span class="mr-1 text-xs text-zinc-500 dark:text-zinc-400">{t('timeTracking.quickSelect')}</span>
			{#each quickDurations as q (q.minutes)}
				<button type="button" class="chip tabular-nums" onclick={() => setQuickDuration(q.minutes)}>{q.label}</button>
			{/each}
		</div>
		<div class="mt-4 flex items-center justify-between rounded-xl bg-accent-50/60 px-4 py-3 ring-1 ring-accent-600/10 dark:bg-accent-900/15 dark:ring-accent-400/15">
			<span class="text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.durationAuto')}</span>
			{#key durationHours}
				<span class="inline-block animate-pop text-2xl font-semibold tabular-nums tracking-tight {durationHours > 0 ? 'text-accent-700 dark:text-accent-300' : 'text-zinc-400'}">{durationHours.toFixed(2).replace('.', ',')} h</span>
			{/key}
		</div>
		{#if formError}
			<p class="mt-2 text-sm text-red-600 dark:text-red-400">{formError}</p>
		{/if}
		{#snippet footer()}
			<button type="button" onclick={closeDialog} class="btn-secondary">{t('common.cancel')}</button>
			<button type="button" onclick={saveEntry} disabled={!canSaveEntry} class="btn-primary">
				{saving ? t('common.saving') : t('common.save')}
				<span class="kbd border-white/20 bg-white/10 text-current opacity-70">⌘S</span>
			</button>
		{/snippet}
	</Dialog>

	<!-- change bubbles up from the selects, after bind:value has updated -->
	<div class="flex flex-wrap items-end gap-3 [&>*]:w-full sm:[&>*]:w-56" onchange={resetToFirstPage}>
		<Select bind:value={filterCustomerId} label={t('timeTracking.customer')} options={filterCustomerOptions} />
		<Select bind:value={filterProjectId} label={t('timeTracking.project')} options={filterProjectOptions} />
		{#if teamView}
			<Select bind:value={filterUserId} label="Mitarbeiter" options={filterUserOptions} />
		{/if}
	</div>

	<div class="table-card">
		<div class="table-scroll">
			<div class="min-w-[820px]">
				<div class="table-head" style="grid-template-columns: {COLS}">
					<div class="px-4 py-2.5">{t('common.description')}</div>
					<div class="px-4 py-2.5">{t('timeTracking.customer')}</div>
					<div class="px-4 py-2.5">{t('timeTracking.project')}</div>
					<div class="px-4 py-2.5">{t('timeTracking.timeRange')}</div>
					<div class="px-4 py-2.5 text-right">{t('timeTracking.duration')}</div>
					<div class="px-4 py-2.5"><span class="sr-only">{t('common.action')}</span></div>
				</div>

				{#if loading && rows.length === 0}
					<SkeletonRows rows={6} cols={5} />
				{:else if visibleRows.length === 0}
					<EmptyState
						icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
						title={t('timeTracking.empty')}
						hint={t('timeTracking.emptyHint')}
						actionLabel={t('timeTracking.emptyAction')}
						onaction={openCreateDialog}
					/>
				{:else}
					<div class="transition-opacity duration-200 {loading ? 'opacity-60' : ''}">
						{#each visibleRows as row (row.id)}
							<div data-testid="time-entry-row" class="data-row group min-h-11 hover:bg-zinc-50 dark:hover:bg-zinc-800/60" style="grid-template-columns: {COLS}">
								<div class="flex items-center gap-2 truncate px-4 py-2">
									{#if teamView && row.user_id}
										{@const name = memberName(row.user_id)}
										<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-900/5 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-white/10" title={name || 'ehemaliges Mitglied'}>{initials(name)}</span>
									{/if}
									<span class="truncate font-medium text-zinc-900 dark:text-zinc-100">{row.description || '—'}</span>
								</div>
								<div class="truncate px-4 py-2">{row.customerName}</div>
								<div class="truncate px-4 py-2 text-zinc-500 dark:text-zinc-400">{row.projectName}</div>
								<div class="truncate px-4 py-2 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{row.timeFrameLabel}</div>
								<div class="truncate px-4 py-2 text-right tabular-nums">{row.durationHoursLabel}</div>
								<div class="flex items-center justify-end px-3 py-1.5">
									{#if row.source_entry_id != null}
										<span class="badge badge-zinc" title="Beim Auftraggeber gebucht; ändern nur dort">vom Auftraggeber</span>
									{:else if row.approved_at}
										<span class="badge badge-green" title="Monat freigegeben; ändern erst nach Zurücknahme der Freigabe">freigegeben</span>
									{:else if mayChange(row)}
										<div class="row-actions">
											<button type="button" onclick={() => openEditDialog(row)} class="icon-btn icon-btn-blue" title={t('common.edit')} aria-label={t('common.edit')}>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
											</button>
											<button type="button" onclick={() => handleDelete(row)} class="icon-btn icon-btn-danger" title={t('common.delete')} aria-label={t('common.delete')}>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
											</button>
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if !loading && totalCount > 0 && pageCount > 1}
		<div class="flex items-center justify-end gap-1">
			<span class="mr-2 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
				{tp('common.pagerPageOf', { page: pager.page, total: pageCount })}
			</span>
			<button type="button" class="icon-btn" disabled={pager.page <= 1} onclick={() => gotoPage(pager.page - 1)} title={t('common.pagerPrev')} aria-label={t('common.pagerPrev')}>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
			</button>
			<button type="button" class="icon-btn" disabled={pager.page >= pageCount} onclick={() => gotoPage(pager.page + 1)} title={t('common.pagerNext')} aria-label={t('common.pagerNext')}>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
			</button>
		</div>
	{/if}
</section>
