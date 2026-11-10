<script lang="ts">
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import Select from '../../common/Select.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import SubcontractorLinks from '../../common/SubcontractorLinks.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import { isPlainKey } from '$lib/ui/shortcut';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listCustomers } from '$lib/db/customers';
	import { createProject, hourlyRatePatch, listProjects, updateProject } from '$lib/db/projects';
	import { sumMinutesByProject } from '$lib/db/time-entries';
	import type { Customer, Project } from '$lib/db/types';
	import { t } from '$lib/i18n';
	import { publishContext } from '$lib/chat/context.svelte';
	import { cloud, CloudError } from '$lib/cloud';
	import { can, initials, isSub, session } from '$lib/session.svelte';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { messageForUnknown } from '$lib/shared/errors';
	import { formatCents } from '$lib/shared/money';
	import * as team from '$lib/team';

	type ProjectRow = Project & { customerName: string };

	let projects = $state<ProjectRow[]>([]);
	let customers = $state<Customer[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let showAddProjectForm = $state(false);
	let editingProjectId = $state<number | null>(null);
	let editingName = $state('');
	let editingCustomerId = $state('');
	let editingStartDate = $state('');
	let editingEndDate = $state('');
	let editingRate = $state('');
	let editingBudgetHours = $state('');
	let editingBudgetEur = $state('');
	// Cloud: all-time hours per project (team_time or reports) and, for the admin, who is staffed where.
	let progress = $state(new Map<number, team.ProjectProgress>());
	let members = $state<team.TeamMember[]>([]);
	// Local: minutes per project from time entries (cloud uses `progress` instead).
	let minutesByProject = $state(new Map<number, number>());
	const isCloud = cloud();
	const isAdmin = $derived(session.company?.role === 'admin');
	// Subcontractors only read assigned projects (server data.ts subScope: writes 403).
	const canWrite = $derived(!isSub());
	const gridCols = $derived(isCloud ? 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.5fr) minmax(0,0.7fr) minmax(0,1fr) minmax(0,0.8fr)' : 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.5fr) minmax(0,0.7fr) minmax(0,0.8fr)');

	let name = $state('');
	let customerId = $state('');
	let startDate = $state('');
	let endDate = $state('');
	let rate = $state('');
	let budgetHours = $state('');
	let budgetEur = $state('');
	const minutesOf = (h: string) => (h.trim() ? Math.round((Number(h.replace(',', '.')) || 0) * 60) : null);
	const centsOf = (eur: string) => (eur.trim() ? Math.round((Number(eur.replace(',', '.')) || 0) * 100) : null);
	const plain = (n: number | null | undefined, div: number) => (n == null ? '' : String(n / div).replace('.', ','));
	const hoursLabel = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 1 });
	// Cloud members without team_time/reports grants see no team-wide totals, so the column shows a dash.
	const hoursAvailable = $derived(!isCloud || can('team_time') || can('reports'));
	const hoursOf = (p: Project) => (isCloud ? progress.get(p.id)?.minutes : minutesByProject.get(p.id)) ?? 0;

	// Burn against the hour budget, else the euro budget (hours × rate). null = no budget or no data.
	function burn(p: Project): { pct: number; label: string } | null {
		const done = progress.get(p.id)?.minutes ?? 0;
		if (p.budget_minutes) return { pct: (done / p.budget_minutes) * 100, label: `${hoursLabel(done)} / ${hoursLabel(p.budget_minutes)} h` };
		if (p.budget_cents && p.hourly_rate != null) {
			const spent = Math.round((done / 60) * p.hourly_rate * 100);
			return { pct: (spent / p.budget_cents) * 100, label: `${formatCents(spent)} / ${formatCents(p.budget_cents)}` };
		}
		return null;
	}
	const budgetPatch = (p: Pick<Project, 'budget_cents'> | null, hours: string, eur: string) =>
		isCloud ? { budget_minutes: minutesOf(hours), ...(p && p.budget_cents === undefined ? {} : { budget_cents: centsOf(eur) }) } : {};

	async function toggleMember(projectId: number, userId: number, on: boolean) {
		await (on ? team.assign(projectId, userId) : team.unassign(projectId, userId));
		members = await team.listMembers();
	}
	// Cloud: members without invoices/reports grant get rates omitted, so a hidden one on any row means hidden for all.
	// Finance fields need invoices or reports view (server data.ts); derive from grants, not rows, so an empty list doesn't offer the field.
	const ratesHidden = $derived(isCloud ? !(can('invoices') || can('reports')) : projects.some((p) => p.hourly_rate_hidden));
	const parseRate = (v: string) => (v.trim() ? Number(v.replace(',', '.')) || 0 : null);
	const formatRate = (p: Project) =>
		p.hourly_rate_hidden ? 'verborgen' : p.hourly_rate == null ? '—' : `${p.hourly_rate.toFixed(2).replace('.', ',')} €/h`;

	$effect(() => {
		if (loading) return;
		const h = (min: number) => Math.round((min / 60) * 100) / 100;
		return publishContext({
			page: 'projekte',
			title: t('nav.projects'),
			facts: {
				totalRows: projects.length,
				shownRows: Math.min(projects.length, 15),
				projects: projects.slice(0, 15).map((p) => ({
					name: p.name,
					number: p.project_number,
					customer: p.customerName,
					status: p.status,
					...(hoursAvailable && { trackedHours: h(hoursOf(p)) }),
					...(!ratesHidden && { hourlyRateEur: p.hourly_rate })
				}))
			}
		});
	});

	const customerOptions = $derived.by(() => [
		{ value: '', label: t('projects.noCustomer') },
		...customers.map((customer) => ({ value: String(customer.id), label: customer.name }))
	]);

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
		const [projectRows, customerRows, minutes] = await Promise.all([
			listProjects(companyId),
			listCustomers(companyId),
			isCloud ? Promise.resolve(new Map<number, number>()) : sumMinutesByProject(companyId)
		]);
		minutesByProject = minutes;
		customers = customerRows;
		const byId = new Map(customerRows.map((customer) => [customer.id, customer.name]));
		projects = projectRows.map((project) => ({
			...project,
			customerName: project.customer_id ? (byId.get(project.customer_id) ?? '—') : '—'
		}));
		loading = false;
		if (isCloud && (can('team_time') || can('reports')))
			progress = new Map((await team.projectProgress().catch(() => [])).map((r) => [r.project_id, r]));
		if (isCloud && isAdmin) members = await team.listMembers().catch(() => []);
	}

	// A 409 conflict already raised its own toast (cloud.ts); anything else gets one here.
	const saveFailed = (e: unknown) => {
		if (!(e instanceof CloudError && e.code === 'conflict')) toasts.error(messageForUnknown(e));
	};

	async function addProject() {
		if (!name.trim()) return;
		saving = true;
		try {
			const companyId = await ensureCompanyId();
			await createProject({
				company_id: companyId,
				customer_id: customerId ? Number(customerId) : null,
				project_number: null,
				name: name.trim(),
				description: null,
				status: 'active',
				hourly_rate: ratesHidden ? null : parseRate(rate),
				starts_on: startDate || null,
				ends_on: endDate || null,
				...budgetPatch(ratesHidden ? { budget_cents: undefined } : null, budgetHours, budgetEur)
			});
			name = '';
			customerId = '';
			startDate = '';
			endDate = '';
			rate = budgetHours = budgetEur = '';
			showAddProjectForm = false;
			await loadData();
		} catch (e) {
			saveFailed(e);
		} finally {
			saving = false;
		}
	}

	function startEdit(project: ProjectRow) {
		editingProjectId = project.id;
		editingName = project.name;
		editingCustomerId = project.customer_id ? String(project.customer_id) : '';
		editingStartDate = project.starts_on ?? '';
		editingEndDate = project.ends_on ?? '';
		editingRate = project.hourly_rate == null ? '' : String(project.hourly_rate).replace('.', ',');
		editingBudgetHours = plain(project.budget_minutes, 60);
		editingBudgetEur = plain(project.budget_cents, 100);
	}

	function cancelEdit() {
		editingProjectId = null;
		editingName = '';
		editingCustomerId = '';
		editingStartDate = '';
		editingEndDate = '';
	}

	async function saveEdit() {
		const project = projects.find((p) => p.id === editingProjectId);
		if (!project || !editingName.trim()) return;
		saving = true;
		try {
			await updateProject(project.id, {
				name: editingName.trim(),
				customer_id: editingCustomerId ? Number(editingCustomerId) : null,
				starts_on: editingStartDate || null,
				ends_on: editingEndDate || null,
				...hourlyRatePatch(project, parseRate(editingRate)),
				...budgetPatch(project, editingBudgetHours, editingBudgetEur)
			});
			cancelEdit();
			await loadData();
		} catch (e) {
			saveFailed(e);
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (isPlainKey(e, 'n') && !showAddProjectForm && canWrite) {
			e.preventDefault();
			showAddProjectForm = true;
		}
	}

	function formatTimeframe(project: ProjectRow): string {
		if (!project.starts_on && !project.ends_on) return '—';
		if (project.starts_on && project.ends_on) return `${project.starts_on} ${t('projects.until')} ${project.ends_on}`;
		return project.starts_on ? `${t('projects.from')} ${project.starts_on}` : `${t('projects.until')} ${project.ends_on}`;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<section class="space-y-6">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="page-header">{t('projects.title')}</h1>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('projects.subtitle')}</p>
		</div>
		{#if canWrite}
			<button type="button" class="btn-primary shrink-0" onclick={() => (showAddProjectForm = true)}>
				<svg class="-ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
				{t('projects.addButton')}
				<kbd class="kbd !border-white/25 !bg-white/15 !text-white/80">N</kbd>
			</button>
		{/if}
	</header>

	<SubcontractorLinks {projects} />

	<AddEntryFormSection
		title={t('projects.newTitle')}
		buttonLabel={t('projects.addButton')}
		bind:open={showAddProjectForm}
	>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={name} label={t('projects.projectName')} placeholder={t('projectsUi.namePlaceholder')} />
			<Select bind:value={customerId} label={t('projects.customer')} options={customerOptions} placeholder={t('projects.customerPlaceholder')} />
			<DateInput bind:value={startDate} label={t('projects.startDate')} />
			<DateInput bind:value={endDate} label={t('projects.endDate')} />
			{#if !ratesHidden}
				<TextInput bind:value={rate} label={t('projectsUi.rateLabel')} placeholder="85,00" />
			{/if}
			{#if isCloud}
				<TextInput bind:value={budgetHours} label={t('projectsUi.budgetHoursLabel')} placeholder={t('projectsUi.budgetHoursPlaceholder')} />
				{#if !ratesHidden}
					<TextInput bind:value={budgetEur} label={t('projectsUi.budgetEurLabel')} placeholder={t('projectsUi.budgetEurPlaceholder')} />
				{/if}
			{/if}
		</div>
		<div class="flex justify-end">
			<button
				type="button"
				onclick={addProject}
				disabled={saving || !name.trim()}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('projects.saveProject')}
			</button>
		</div>
	</AddEntryFormSection>

	<div class="table-card">
		<div class="table-scroll">
		<div class="min-w-[880px]">
		<div class="table-head" style="grid-template-columns: {gridCols}">
			<div class="px-4 py-3">{t('common.name')}</div>
			<div class="px-4 py-3">{t('projects.customer')}</div>
			<div class="px-4 py-3">{t('projects.timeframe')}</div>
			<div class="px-4 py-3 text-right">{t('projects.hours')}</div>
			<div class="px-4 py-3 text-right">{t('projectsUi.rate')}</div>
			{#if isCloud}<div class="px-4 py-3">{t('projectsUi.budget')}</div>{/if}
			<div class="px-4 py-3 text-right">{t('common.action')}</div>
		</div>

		{#if loading}
			<SkeletonRows rows={5} cols={isCloud ? 7 : 6} />
		{:else if projects.length === 0}
			<EmptyState
				icon="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
				title={t('projects.empty')}
				hint={t('projectsUi.emptyHint')}
				actionLabel={canWrite ? t('projects.addButton') : undefined}
				onaction={canWrite ? () => (showAddProjectForm = true) : undefined}
			/>
		{:else}
			<div>
				{#each projects as project (project.id)}
					<div
						data-testid="project-row"
						class="data-row group {editingProjectId === project.id ? 'bg-accent-50/40 dark:bg-accent-900/10' : ''}"
						style="grid-template-columns: {gridCols}; min-height: 48px"
					>
						{#if editingProjectId === project.id}
							<div class="px-4 py-2">
								<input bind:value={editingName} aria-label={t('projects.projectName')} class="input-base input-valid rounded-lg px-2 py-1" />
							</div>
							<div class="px-4 py-2">
								<select bind:value={editingCustomerId} aria-label={t('projects.customer')} class="input-base input-valid rounded-lg px-2 py-1">
									{#each customerOptions as option}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
							</div>
							<div class="grid gap-2 px-4 py-2">
								<input type="date" bind:value={editingStartDate} aria-label={t('projects.startDate')} class="input-base input-valid rounded-lg px-2 py-1" />
								<input type="date" bind:value={editingEndDate} aria-label={t('projects.endDate')} class="input-base input-valid rounded-lg px-2 py-1" />
							</div>
							<div class="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{hoursAvailable ? `${hoursLabel(hoursOf(project))} h` : '—'}</div>
							<div class="px-4 py-2">
								{#if project.hourly_rate_hidden}
									<div class="text-right text-zinc-400" title={t('projectsUi.rateHiddenTitle')}>{t('projectsUi.hidden')}</div>
								{:else}
									<input bind:value={editingRate} inputmode="decimal" placeholder="€/h" aria-label={t('projectsUi.rate')} class="input-base input-valid rounded-lg px-2 py-1 text-right tabular-nums" />
								{/if}
							</div>
							{#if isCloud}
								<div class="grid gap-2 px-4 py-2">
									<input bind:value={editingBudgetHours} inputmode="decimal" placeholder={t('projectsUi.hoursPlaceholder')} aria-label={t('projectsUi.budgetHoursAria')} class="input-base input-valid rounded-lg px-2 py-1" />
									{#if project.budget_cents !== undefined}
										<input bind:value={editingBudgetEur} inputmode="decimal" placeholder="€" aria-label={t('projectsUi.budgetEurAria')} class="input-base input-valid rounded-lg px-2 py-1" />
									{/if}
								</div>
							{/if}
							<div class="flex items-center justify-end gap-2 px-4 py-2 text-xs">
								<button type="button" onclick={saveEdit} class="btn-primary px-2.5 py-1 text-xs" disabled={saving || !editingName.trim()}>{t('common.save')}</button>
								<button type="button" onclick={cancelEdit} class="btn-secondary px-2.5 py-1 text-xs">{t('common.cancel')}</button>
							</div>
						{:else}
							<div class="truncate px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">{project.name}</div>
							<div class="truncate px-4 py-2">{project.customerName}</div>
							<div class="truncate px-4 py-2">{formatTimeframe(project)}</div>
							<div class="truncate px-4 py-2 text-right tabular-nums">{hoursAvailable ? `${hoursLabel(hoursOf(project))} h` : '—'}</div>
							<div class="truncate px-4 py-2 text-right tabular-nums {project.hourly_rate_hidden ? 'text-zinc-400' : ''}">{formatRate(project)}</div>
							{#if isCloud}
								{@const b = burn(project)}
								<div class="px-4 py-2" data-testid="project-burn">
									{#if b}
										<div class="h-1.5 overflow-hidden rounded-full bg-zinc-200/80 dark:bg-zinc-700">
											<div class="h-full origin-left rounded-full transition-[width] duration-500 ease-out-expo {b.pct > 100 ? 'bg-red-500' : b.pct >= 80 ? 'bg-amber-500' : 'bg-accent-500'}" style="width: {Math.min(100, b.pct)}%"></div>
										</div>
										<div class="mt-1 text-xs tabular-nums {b.pct > 100 ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}">{b.label}</div>
									{:else}
										<span class="text-zinc-400">—</span>
									{/if}
								</div>
							{/if}
							<div class="row-actions px-4 py-2">
								{#if canWrite}
								<button type="button" onclick={() => startEdit(project)} class="icon-btn icon-btn-blue" title={t('common.edit')} aria-label={t('common.edit')}>
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
								</button>
								{/if}
							</div>
						{/if}
					</div>
					{#if isCloud && isAdmin && members.length > 1}
						{@const staffed = members.filter((m) => m.project_ids.includes(project.id))}
						<div class="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 pb-2 text-xs text-zinc-500 dark:border-zinc-700/70">
							<span>{t('projectsUi.teamLabel')}</span>
							{#if editingProjectId === project.id}
								{#each members.filter((m) => m.role !== 'admin') as m (m.user_id)}
									<label class="flex items-center gap-1">
										<input type="checkbox" checked={m.project_ids.includes(project.id)} onchange={(e) => toggleMember(project.id, m.user_id, e.currentTarget.checked)} />
										{m.name}{m.role === 'subcontractor' ? ' (Sub)' : ''}
									</label>
								{/each}
							{:else if staffed.length}
								{#each staffed as m (m.user_id)}
									<span class="badge badge-zinc" title={m.name}>{initials(m.name)}</span>
								{/each}
							{:else}
								<span>{t('projectsUi.nobodyAssigned')}</span>
							{/if}
						</div>
					{/if}
				{/each}
			</div>
		{/if}
		</div>
		</div>
	</div>
</section>
