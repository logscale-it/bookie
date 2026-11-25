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
	import { cloud } from '$lib/cloud';
	import { can, memberName, session } from '$lib/session.svelte';
	import Avatar from '../../../common/Avatar.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	// One card per project (entries without a project: per customer), entries oldest first.
	type ProjectGroup = {
		key: string;
		projectName: string;
		customerName: string;
		totalMinutes: number;
		entries: TimeEntry[];
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
	let selectedUserId = $state('all');

	// Cloud with the team_time grant: other members' entries are listed too (same rule as the entry list).
	const members = session.me?.active?.members ?? [];
	const teamView = !!cloud() && can('team_time') && members.length > 1;
	const userOptions = [
		{ value: 'all', label: t('timeUi.allStaff') },
		...members.map((m) => ({ value: String(m.id), label: m.name }))
	];

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

	const groups = $derived.by(() => {
		const customerName = new Map(customers.map((c) => [c.id, c.name]));
		const projectName = new Map(projects.map((p) => [p.id, p.name]));
		const grouped = new Map<string, ProjectGroup>();

		for (const entry of rows) {
			const key = entry.project_id != null ? `p${entry.project_id}` : `c${entry.customer_id ?? 0}`;
			let group = grouped.get(key);
			if (!group) {
				group = {
					key,
					projectName: (entry.project_id != null && projectName.get(entry.project_id)) || t('timeTracking.noProject'),
					customerName: (entry.customer_id != null && customerName.get(entry.customer_id)) || '—',
					totalMinutes: 0,
					entries: []
				};
				grouped.set(key, group);
			}
			group.entries.push(entry);
			group.totalMinutes += entry.duration_minutes ?? 0;
		}

		const sorted = [...grouped.values()].sort(
			(a, b) => a.customerName.localeCompare(b.customerName) || a.projectName.localeCompare(b.projectName)
		);
		for (const g of sorted)
			g.entries.sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.started_at ?? '').localeCompare(b.started_at ?? ''));
		return sorted;
	});

	const totalMinutes = $derived(rows.reduce((sum, entry) => sum + (entry.duration_minutes ?? 0), 0));
	const totalHoursLabel = $derived(formatHours(totalMinutes));

	const enter = (i: number) => ({ y: 12, duration: 520, delay: Math.min(i, 8) * 40, easing: cubicOut });

	$effect(() => {
		loadData();
	});

	$effect(() => {
		const filter = {
			from: periodStart,
			to: periodEnd,
			customerId: selectedCustomerId !== 'all' ? Number(selectedCustomerId) : null,
			projectId: selectedProjectId !== 'all' ? Number(selectedProjectId) : null,
			userId: selectedUserId !== 'all' ? Number(selectedUserId) : null
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

	/** "Mo., 03. Nov." for the entry rows. */
	function formatDay(dateString: string): string {
		const date = new Date(`${dateString}T00:00:00`);
		if (Number.isNaN(date.getTime())) return t('timeTracking.invalidDate');
		return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short' });
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
			...(selectedUserId === 'all' ? [] : [`${t('timeUi.staff')}: ${memberName(Number(selectedUserId))}`])
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
				groups: groups.map((group) => ({
					customerName: group.projectName,
					periodLabel: `${group.customerName} · ${formatDate(group.entries[0].entry_date)} – ${formatDate(group.entries.at(-1)!.entry_date)}`,
					totalLabel: formatHours(group.totalMinutes),
					entries: group.entries.map((entry) => ({
						entryDate: formatDate(entry.entry_date),
						// Team sheet over several people: say who booked the line.
						description: [teamView && selectedUserId === 'all' && memberName(entry.user_id), entry.description || '—'].filter(Boolean).join(': '),
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
		<button type="button" onclick={exportPdf} disabled={pdfLoading || groups.length === 0} class="btn-secondary">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
			{pdfLoading ? 'Exportiere…' : t('timeTracking.printPdf')}
		</button>
	</header>

	{#if pdfError}
		<div class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-600/15 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/20">{pdfError}</div>
	{/if}

	<div class="card grid gap-3 md:grid-cols-2 {teamView ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}">
		<DateInput bind:value={periodStart} label={t('timeTracking.periodFrom')} max={periodEnd || ''} />
		<DateInput bind:value={periodEnd} label={t('timeTracking.periodTo')} min={periodStart || ''} />
		<Select bind:value={selectedCustomerId} label={t('timeTracking.customer')} options={customerOptions} />
		<Select bind:value={selectedProjectId} label={t('timeTracking.project')} options={projectOptions} />
		{#if teamView}
			<Select bind:value={selectedUserId} label={t('timeUi.staff')} options={userOptions} />
		{/if}
	</div>

	<div class="grid gap-3 sm:grid-cols-3">
		{#each [{ label: t('timeTracking.totalDuration'), value: totalHoursLabel }, { label: t('nav.projects'), value: String(groups.length) }, { label: t('timeTracking.timeEntries'), value: String(rows.length) }] as stat, i (stat.label)}
			<div class="bezel" in:fly={enter(i)}>
				<div class="bezel-core">
					<p class="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">{stat.label}</p>
					<p class="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">{stat.value}</p>
				</div>
			</div>
		{/each}
	</div>

	{#if loading}
		<div class="table-card"><SkeletonRows rows={5} cols={3} /></div>
	{:else if groups.length === 0}
		<div class="table-card">
			<EmptyState icon="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" title={t('timeTracking.emptyTimesheet')} />
		</div>
	{:else}
		<div class="space-y-4">
			{#each groups as group, i (group.key)}
				{@const share = totalMinutes > 0 ? group.totalMinutes / totalMinutes : 0}
				<article class="table-card" in:fly={enter(i)}>
					<header class="flex items-end justify-between gap-4 px-5 pb-3 pt-4">
						<div class="min-w-0">
							<p class="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">{group.customerName}</p>
							<h3 class="mt-0.5 truncate text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{group.projectName}</h3>
						</div>
						<div class="shrink-0 text-right">
							<p class="text-xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">{formatHours(group.totalMinutes)}</p>
							<p class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{group.entries.length} {t('timeTracking.timeEntries')} · {Math.round(share * 100)} %</p>
						</div>
					</header>

					<!-- Share of the sheet's total -->
					<div class="mx-5 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700/60" aria-hidden="true">
						<div class="h-full origin-left rounded-full bg-accent-500 transition-transform duration-700 ease-spring" style="transform: scaleX({share})"></div>
					</div>

					<ul class="p-2">
						{#each group.entries as entry, j (entry.id)}
							{@const newDay = j === 0 || group.entries[j - 1].entry_date !== entry.entry_date}
							<li data-testid="timesheet-row" class="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 rounded-lg px-3 py-2 text-sm transition-colors duration-200 ease-spring hover:bg-zinc-50 sm:grid-cols-[7.5rem_1fr_auto] dark:hover:bg-zinc-700/30">
								<!-- The day is printed once; further entries of the same day line up under it. -->
								<span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400 {newDay ? 'max-sm:col-span-2' : 'max-sm:hidden'}">{newDay ? formatDay(entry.entry_date) : ''}</span>
								<span class="flex min-w-0 items-baseline gap-2 text-zinc-700 dark:text-zinc-200">
									{#if teamView}
										<span class="self-center"><Avatar id={entry.user_id} name={memberName(entry.user_id) || '?'} size="sm" /></span>
									{/if}
									<span class="min-w-0 break-words">{entry.description || '—'}</span>
								</span>
								<span class="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{formatHours(entry.duration_minutes ?? 0)}</span>
							</li>
						{/each}
					</ul>
				</article>
			{/each}
		</div>
	{/if}
</section>
