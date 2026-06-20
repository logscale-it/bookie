<script lang="ts">
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import Select from '../../common/Select.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listCustomers } from '$lib/db/customers';
	import { createProject, listProjects, updateProject } from '$lib/db/projects';
	import type { Customer, Project } from '$lib/db/types';
	import { t } from '$lib/i18n';

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

	let name = $state('');
	let customerId = $state('');
	let startDate = $state('');
	let endDate = $state('');

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
			hourly_rate: null,
			starts_on: startDate || null,
			ends_on: endDate || null
		});
		name = '';
		customerId = '';
		startDate = '';
		endDate = '';
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
	}

	function cancelEdit() {
		editingProjectId = null;
		editingName = '';
		editingCustomerId = '';
		editingStartDate = '';
		editingEndDate = '';
	}

	async function saveEdit() {
		if (!editingProjectId || !editingName.trim()) return;
		saving = true;
		await updateProject(editingProjectId, {
			name: editingName.trim(),
			customer_id: editingCustomerId ? Number(editingCustomerId) : null,
			starts_on: editingStartDate || null,
			ends_on: editingEndDate || null
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
		<div class="min-w-[640px]">
		<div
			class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
			style="grid-template-columns: 1.2fr 1fr 1fr 0.8fr"
		>
			<div class="px-4 py-3">{t('common.name')}</div>
			<div class="px-4 py-3">{t('projects.customer')}</div>
			<div class="px-4 py-3">{t('projects.timeframe')}</div>
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
					style="grid-template-columns: 1.2fr 1fr 1fr 0.8fr; min-height: 44px"
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
							<div class="flex items-center justify-end gap-2 px-4 py-2 text-xs">
								<button type="button" onclick={saveEdit} class="rounded bg-blue-600 px-2 py-1 text-white" disabled={saving || !editingName.trim()}>{t('common.save')}</button>
								<button type="button" onclick={cancelEdit} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">{t('common.cancel')}</button>
							</div>
						{:else}
							<div class="truncate px-4 py-2">{project.name}</div>
							<div class="truncate px-4 py-2">{project.customerName}</div>
							<div class="truncate px-4 py-2">{formatTimeframe(project)}</div>
							<div class="px-4 py-2 text-right">
								<button type="button" onclick={() => startEdit(project)} class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium dark:border-zinc-600">{t('common.edit')}</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		</div>
		</div>
	</div>
</section>
