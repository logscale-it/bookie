<script lang="ts">
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import Select from '../../common/Select.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import SubcontractorLinks from '../../common/SubcontractorLinks.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listCustomers } from '$lib/db/customers';
	import { createProject, hourlyRatePatch, listProjects, updateProject } from '$lib/db/projects';
	import type { Customer, Project } from '$lib/db/types';
	import { t } from '$lib/i18n';
	import { cloud } from '$lib/cloud';
	import { can, initials, session } from '$lib/session.svelte';
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
	const isCloud = cloud();
	const isAdmin = $derived(session.company?.role === 'admin');
	const gridCols = $derived(isCloud ? '1.2fr 1fr 1fr 0.7fr 1fr 0.8fr' : '1.2fr 1fr 1fr 0.7fr 0.8fr');

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
	const ratesHidden = $derived(projects.some((p) => p.hourly_rate_hidden));
	const parseRate = (v: string) => (v.trim() ? Number(v.replace(',', '.')) || 0 : null);
	const formatRate = (p: Project) =>
		p.hourly_rate_hidden ? 'verborgen' : p.hourly_rate == null ? '—' : `${p.hourly_rate.toFixed(2).replace('.', ',')} €/h`;

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
		const [projectRows, customerRows] = await Promise.all([
			listProjects(companyId),
			listCustomers(companyId)
		]);
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

	async function addProject() {
		if (!name.trim()) return;
		saving = true;
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
		saving = false;
		await loadData();
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
		await updateProject(project.id, {
			name: editingName.trim(),
			customer_id: editingCustomerId ? Number(editingCustomerId) : null,
			starts_on: editingStartDate || null,
			ends_on: editingEndDate || null,
			...hourlyRatePatch(project, parseRate(editingRate)),
			...budgetPatch(project, editingBudgetHours, editingBudgetEur)
		});
		cancelEdit();
		saving = false;
		await loadData();
	}

	function formatTimeframe(project: ProjectRow): string {
		if (!project.starts_on && !project.ends_on) return '—';
		if (project.starts_on && project.ends_on) return `${project.starts_on} ${t('projects.until')} ${project.ends_on}`;
		return project.starts_on ? `${t('projects.from')} ${project.starts_on}` : `${t('projects.until')} ${project.ends_on}`;
	}
</script>

<section class="space-y-6">
	<header>
		<h1 class="page-header">{t('projects.title')}</h1>
		<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('projects.subtitle')}</p>
	</header>

	<SubcontractorLinks {projects} />

	<AddEntryFormSection
		title={t('projects.newTitle')}
		buttonLabel={t('projects.addButton')}
		bind:open={showAddProjectForm}
	>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={name} label={t('projects.projectName')} placeholder="Website Relaunch" />
			<Select bind:value={customerId} label={t('projects.customer')} options={customerOptions} placeholder={t('projects.customerPlaceholder')} />
			<DateInput bind:value={startDate} label={t('projects.startDate')} />
			<DateInput bind:value={endDate} label={t('projects.endDate')} />
			{#if !ratesHidden}
				<TextInput bind:value={rate} label="Stundensatz (€, netto)" placeholder="85,00" />
			{/if}
			{#if isCloud}
				<TextInput bind:value={budgetHours} label="Budget (Stunden)" placeholder="z. B. 40" />
				{#if !ratesHidden}
					<TextInput bind:value={budgetEur} label="Budget (€, netto)" placeholder="z. B. 5.000" />
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
		<div class="min-w-[760px]">
		<div
			class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
			style="grid-template-columns: {gridCols}"
		>
			<div class="px-4 py-3">{t('common.name')}</div>
			<div class="px-4 py-3">{t('projects.customer')}</div>
			<div class="px-4 py-3">{t('projects.timeframe')}</div>
			<div class="px-4 py-3 text-right">Stundensatz</div>
			{#if isCloud}<div class="px-4 py-3">Budget</div>{/if}
			<div class="px-4 py-3 text-right">{t('common.action')}</div>
		</div>

		{#if loading}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('projects.loading')}</div>
		{:else if projects.length === 0}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('projects.empty')}</div>
		{:else}
			<div class="max-h-[520px] overflow-y-auto">
				{#each projects as project (project.id)}
					<div
						class="grid items-center border-b border-zinc-100 text-sm text-zinc-700 last:border-0 dark:border-zinc-700/70 dark:text-zinc-200"
					style="grid-template-columns: {gridCols}; min-height: 44px"
				>
						{#if editingProjectId === project.id}
							<div class="px-4 py-2">
								<input bind:value={editingName} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
							</div>
							<div class="px-4 py-2">
								<select bind:value={editingCustomerId} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900">
									{#each customerOptions as option}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
							</div>
							<div class="grid gap-2 px-4 py-2">
								<input type="date" bind:value={editingStartDate} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
								<input type="date" bind:value={editingEndDate} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
							</div>
							<div class="px-4 py-2">
								{#if project.hourly_rate_hidden}
									<div class="text-right text-zinc-400" title="Stundensätze sind nur mit Berechtigung für Rechnungen oder Berichte sichtbar">verborgen</div>
								{:else}
									<input bind:value={editingRate} inputmode="decimal" placeholder="€/h" aria-label="Stundensatz" class="w-full rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-600 dark:bg-zinc-900" />
								{/if}
							</div>
							{#if isCloud}
								<div class="grid gap-2 px-4 py-2">
									<input bind:value={editingBudgetHours} inputmode="decimal" placeholder="Stunden" aria-label="Budget Stunden" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
									{#if project.budget_cents !== undefined}
										<input bind:value={editingBudgetEur} inputmode="decimal" placeholder="€" aria-label="Budget Euro" class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
									{/if}
								</div>
							{/if}
							<div class="flex items-center justify-end gap-2 px-4 py-2 text-xs">
								<button type="button" onclick={saveEdit} class="rounded bg-blue-600 px-2 py-1 text-white" disabled={saving || !editingName.trim()}>{t('common.save')}</button>
								<button type="button" onclick={cancelEdit} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">{t('common.cancel')}</button>
							</div>
						{:else}
							<div class="truncate px-4 py-2">{project.name}</div>
							<div class="truncate px-4 py-2">{project.customerName}</div>
							<div class="truncate px-4 py-2">{formatTimeframe(project)}</div>
							<div class="truncate px-4 py-2 text-right {project.hourly_rate_hidden ? 'text-zinc-400' : ''}">{formatRate(project)}</div>
							{#if isCloud}
								{@const b = burn(project)}
								<div class="px-4 py-2" data-testid="project-burn">
									{#if b}
										<div class="h-1.5 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
											<div class="h-full {b.pct > 100 ? 'bg-red-500' : b.pct >= 80 ? 'bg-amber-500' : 'bg-blue-500'}" style="width: {Math.min(100, b.pct)}%"></div>
										</div>
										<div class="mt-0.5 text-xs {b.pct > 100 ? 'text-red-600' : 'text-zinc-500'}">{b.label}</div>
									{:else}
										<span class="text-zinc-400">—</span>
									{/if}
								</div>
							{/if}
							<div class="px-4 py-2 text-right">
								<button type="button" onclick={() => startEdit(project)} class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium dark:border-zinc-600">{t('common.edit')}</button>
							</div>
						{/if}
					</div>
					{#if isCloud && isAdmin && members.length > 1}
						{@const staffed = members.filter((m) => m.project_ids.includes(project.id))}
						<div class="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 pb-2 text-xs text-zinc-500 dark:border-zinc-700/70">
							<span>Team:</span>
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
								<span>niemand zugewiesen</span>
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
