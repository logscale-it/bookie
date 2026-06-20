<script lang="ts">
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { save } from '@tauri-apps/plugin-dialog';
	import { invoke } from '@tauri-apps/api/core';
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import Select from '../../common/Select.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { createCustomer, listCustomers, updateCustomer } from '$lib/db/customers';
	import { exportCustomerData, suggestExportFileName } from '$lib/db/dsgvo_export';
	import { anonymizeCustomer } from '$lib/db/dsgvo_erasure';
	import type { Customer } from '$lib/db/types';
	import { t } from '$lib/i18n';
	import { isValidVatId } from '$lib/validation';
	import { toasts } from '$lib/ui/toasts.svelte';

	type CustomerForm = {
		name: string;
		street: string;
		postalCode: string;
		city: string;
		emails: string;
		phone: string;
		vatId: string;
		website: string;
		type: string;
	};

	const typeOptions = $derived([
		{ value: 'kunde', label: t('companies.typeCustomer') },
		{ value: 'lieferant', label: t('companies.typeSupplier') },
		{ value: 'beides', label: t('companies.typeBoth') }
	]);

	const typeLabels: Record<string, string> = $derived({
		kunde: t('companies.typeCustomer'),
		lieferant: t('companies.typeSupplier'),
		beides: t('companies.typeBoth')
	});

	const initialForm = (): CustomerForm => ({
		name: '',
		street: '',
		postalCode: '',
		city: '',
		emails: '',
		phone: '',
		vatId: '',
		website: '',
		type: 'kunde'
	});

	let customers = $state<Customer[]>([]);
	let search = $state('');
	let typeFilter = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let showAddForm = $state(false);
	let form = $state<CustomerForm>(initialForm());
	let editingCustomerId = $state<number | null>(null);
	let editForm = $state<CustomerForm>(initialForm());
	let exportingCustomerId = $state<number | null>(null);
	let erasingCustomerId = $state<number | null>(null);

	// Live USt-IdNr (VAT ID) validation for the add/edit forms. Empty is allowed
	// (the field is optional); a non-empty malformed value shows inline guidance.
	const vatIdError = $derived(
		form.vatId.trim() && !isValidVatId(form.vatId) ? t('common.invalidVatId') : ''
	);
	const editVatIdError = $derived(
		editForm.vatId.trim() && !isValidVatId(editForm.vatId) ? t('common.invalidVatId') : ''
	);

	const filteredCustomers = $derived.by(() => {
		let result = customers;

		if (typeFilter) {
			result = result.filter((c) => c.type === typeFilter);
		}

		const term = search.trim().toLowerCase();
		if (term) {
			result = result.filter((c) => {
				const haystack = [c.name, c.street, c.email, c.phone, c.vat_id, c.website]
					.filter(Boolean)
					.join(' ')
					.toLowerCase();
				return haystack.includes(term);
			});
		}

		return result;
	});

	$effect(() => {
		loadCustomers();
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

	function toForm(customer: Customer): CustomerForm {
		return {
			name: customer.name,
			street: customer.street ?? '',
			postalCode: customer.postal_code ?? '',
			city: customer.city ?? '',
			emails: customer.email ?? '',
			phone: customer.phone ?? '',
			vatId: customer.vat_id ?? '',
			website: customer.website ?? '',
			type: customer.type ?? 'kunde'
		};
	}

	async function loadCustomers() {
		loading = true;
		const companyId = await ensureCompanyId();
		customers = await listCustomers(companyId);
		loading = false;
	}

	async function addCustomer() {
		if (!form.name.trim()) return;
		saving = true;

		const companyId = await ensureCompanyId();
		await createCustomer({
			company_id: companyId,
			customer_number: null,
			name: form.name.trim(),
			contact_name: null,
			email: form.emails.trim() || null,
			phone: form.phone.trim() || null,
			street: form.street.trim() || null,
			postal_code: form.postalCode.trim() || null,
			city: form.city.trim() || null,
			country_code: 'DE',
			vat_id: form.vatId.trim() || null,
			website: form.website.trim() || null,
			type: form.type
		});

		form = initialForm();
		showAddForm = false;
		saving = false;
		await loadCustomers();
	}

	function startEdit(customer: Customer) {
		editingCustomerId = customer.id;
		editForm = toForm(customer);
	}

	function cancelEdit() {
		editingCustomerId = null;
		editForm = initialForm();
	}

	async function saveEdit() {
		if (!editingCustomerId || !editForm.name.trim()) return;
		saving = true;
		await updateCustomer(editingCustomerId, {
			name: editForm.name.trim(),
			email: editForm.emails.trim() || null,
			phone: editForm.phone.trim() || null,
			street: editForm.street.trim() || null,
			postal_code: editForm.postalCode.trim() || null,
			city: editForm.city.trim() || null,
			vat_id: editForm.vatId.trim() || null,
			website: editForm.website.trim() || null,
			type: editForm.type
		});
		cancelEdit();
		saving = false;
		await loadCustomers();
	}

	async function openCustomerWebsite(rawWebsite: string | null) {
		if (!rawWebsite) return;
		const normalized = rawWebsite.startsWith('http') ? rawWebsite : `https://${rawWebsite}`;
		await openUrl(normalized);
	}

	async function handleDsgvoErase(customer: Customer) {
		const confirmed = window.confirm(
			`„${customer.name}“ gemäß DSGVO Art. 17 endgültig anonymisieren? ` +
				'Personenbezogene Daten werden unwiderruflich entfernt. Rechnungen ' +
				'und Buchungsbelege bleiben aus gesetzlichen Gründen (§147 AO) erhalten.'
		);
		if (!confirmed) return;

		erasingCustomerId = customer.id;
		try {
			await anonymizeCustomer(customer.id);
			toasts.success(`„${customer.name}“ wurde anonymisiert.`);
			await loadCustomers();
		} catch (e) {
			const err = e as Error;
			if (err?.name === 'RetentionViolation') {
				toasts.error(`Löschung verweigert: ${err.message}`);
			} else {
				toasts.error(`Fehler bei der DSGVO-Löschung: ${err?.message ?? String(e)}`);
			}
		} finally {
			erasingCustomerId = null;
		}
	}

	async function handleDsgvoExport(customer: Customer) {
		exportingCustomerId = customer.id;
		try {
			const defaultName = suggestExportFileName(customer);
			const filePath = await save({
				title: 'DSGVO-Auskunft speichern',
				defaultPath: defaultName,
				filters: [{ name: 'ZIP', extensions: ['zip'] }]
			});
			if (!filePath) {
				exportingCustomerId = null;
				return;
			}
			const bytes = await exportCustomerData(customer.id);
			await invoke('write_binary_file', {
				path: filePath,
				data: Array.from(bytes)
			});
			toasts.success(`DSGVO-Auskunft für „${customer.name}“ gespeichert.`);
		} catch (e) {
			toasts.error(`Fehler beim Erstellen der DSGVO-Auskunft: ${(e as Error).message ?? String(e)}`);
		} finally {
			exportingCustomerId = null;
		}
	}
</script>

<section class="space-y-6">
	<header>
		<h1 class="page-header">{t('companies.title')}</h1>
		<p class="text-sm text-zinc-600 dark:text-zinc-300">
			{t('companies.subtitle')}
		</p>
	</header>

	<AddEntryFormSection
		title={t('companies.newTitle')}
		buttonLabel={t('companies.addButton')}
		bind:open={showAddForm}
	>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={form.name} label={t('common.name')} placeholder="Muster GmbH" />
			<Select bind:value={form.type} label={t('common.type')} options={typeOptions} />
			<TextInput bind:value={form.street} label={t('companies.street')} placeholder="Musterweg 5" />
			<TextInput bind:value={form.postalCode} label={t('companies.postalCode')} placeholder="10115" />
			<TextInput bind:value={form.city} label={t('companies.city')} placeholder="Berlin" />
			<TextInput bind:value={form.emails} label={t('companies.emails')} placeholder="kontakt@firma.de; buchhaltung@firma.de" />
			<TextInput bind:value={form.phone} label={t('companies.phone')} placeholder="+49 ..." />
			<TextInput bind:value={form.vatId} label={t('companies.vatId')} placeholder="DE123456789" error={vatIdError} />
			<TextInput bind:value={form.website} label={t('companies.website')} placeholder="firma.de" />
		</div>
		<div class="flex justify-end">
			<button
				type="button"
				onclick={addCustomer}
				disabled={saving || !form.name.trim() || !!vatIdError}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('companies.saveCompany')}
			</button>
		</div>
	</AddEntryFormSection>

	<div class="space-y-3">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div class="flex flex-wrap items-end gap-3">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">
					{t('companies.overview')}
					{#if !loading}<span class="ml-1 font-normal text-zinc-400">({filteredCustomers.length})</span>{/if}
				</h2>
				<div class="flex gap-1">
					<button
						type="button"
						onclick={() => (typeFilter = '')}
						class="rounded-md px-2 py-1 text-xs font-medium transition {typeFilter === '' ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'}"
					>{t('common.all')}</button>
					{#each typeOptions as opt}
						<button
							type="button"
							onclick={() => (typeFilter = opt.value)}
							class="rounded-md px-2 py-1 text-xs font-medium transition {typeFilter === opt.value ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'}"
						>{opt.label}</button>
					{/each}
				</div>
			</div>
			<div class="w-full max-w-sm">
				<TextInput bind:value={search} label={t('common.search')} placeholder={t('companies.searchPlaceholder')} />
			</div>
		</div>

		<div class="table-card">
			{#if loading}
				<div class="empty-state" data-testid="customers-loading">
					<svg class="h-5 w-5 animate-spin text-zinc-400" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
					<span>{t('companies.loading')}</span>
				</div>
			{:else if filteredCustomers.length === 0}
				<div class="empty-state" data-testid="customers-empty">
					<svg class="h-8 w-8 text-zinc-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" /></svg>
					<span>{search || typeFilter ? t('companies.empty') : t('companies.empty')}</span>
					{#if !search && !typeFilter}
						<button type="button" class="btn-primary mt-1" onclick={() => (showAddForm = true)}>{t('companies.addButton')}</button>
					{/if}
				</div>
			{:else}
				<div class="table-scroll">
					<div class="min-w-[1080px]">
						<div
							class="table-head"
							style="grid-template-columns: 1.4fr 0.8fr 1fr 0.6fr 0.8fr 1.4fr 0.9fr 0.9fr 0.9fr 152px"
						>
							<div class="px-3 py-2.5">{t('common.name')}</div>
							<div class="px-3 py-2.5">{t('common.type')}</div>
							<div class="px-3 py-2.5">{t('companies.street')}</div>
							<div class="px-3 py-2.5">{t('companies.postalCode')}</div>
							<div class="px-3 py-2.5">{t('companies.city')}</div>
							<div class="px-3 py-2.5">{t('companies.emails')}</div>
							<div class="px-3 py-2.5">{t('companies.phone')}</div>
							<div class="px-3 py-2.5">{t('companies.vatId')}</div>
							<div class="px-3 py-2.5">{t('companies.website')}</div>
							<div class="px-3 py-2.5 text-right">{t('common.action')}</div>
						</div>

						<div class="max-h-[520px] overflow-y-auto">
							{#each filteredCustomers as customer (customer.id)}
								<div
									class="table-row hover:bg-zinc-50 dark:hover:bg-zinc-700/30"
									style="grid-template-columns: 1.4fr 0.8fr 1fr 0.6fr 0.8fr 1.4fr 0.9fr 0.9fr 0.9fr 152px; min-height: 48px"
								>
									{#if editingCustomerId === customer.id}
										<div class="px-3 py-2"><input bind:value={editForm.name} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2">
											<select bind:value={editForm.type} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900">
												{#each typeOptions as opt}
													<option value={opt.value}>{opt.label}</option>
												{/each}
											</select>
										</div>
										<div class="px-3 py-2"><input bind:value={editForm.street} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.postalCode} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.city} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.emails} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.phone} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.vatId} title={editVatIdError} class="w-full rounded border px-2 py-1 dark:bg-zinc-900 {editVatIdError ? 'border-red-400 dark:border-red-500' : 'border-zinc-300 dark:border-zinc-600'}" /></div>
										<div class="px-3 py-2"><input bind:value={editForm.website} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
										<div class="flex justify-end gap-2 px-3 py-2 text-xs">
											<button type="button" onclick={saveEdit} class="rounded bg-blue-600 px-2 py-1 text-white" disabled={saving || !editForm.name.trim() || !!editVatIdError}>{t('common.save')}</button>
											<button type="button" onclick={cancelEdit} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">{t('common.cancel')}</button>
										</div>
									{:else}
										<div class="truncate px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100" title={customer.name}>{customer.name}</div>
										<div class="px-3 py-2">
											<span class="badge {customer.type === 'kunde' ? 'badge-blue' : customer.type === 'lieferant' ? 'badge-amber' : 'badge-green'}">
												{typeLabels[customer.type] ?? customer.type}
											</span>
										</div>
										<div class="truncate px-3 py-2" title={customer.street ?? ''}>{customer.street || '—'}</div>
										<div class="truncate px-3 py-2">{customer.postal_code || '—'}</div>
										<div class="truncate px-3 py-2" title={customer.city ?? ''}>{customer.city || '—'}</div>
										<div class="truncate px-3 py-2" title={customer.email ?? ''}>{customer.email || '—'}</div>
										<div class="truncate px-3 py-2">{customer.phone || '—'}</div>
										<div class="truncate px-3 py-2">{customer.vat_id || '—'}</div>
										<div class="truncate px-3 py-2" title={customer.website ?? ''}>{customer.website || '—'}</div>
										<div class="flex items-center justify-end gap-0.5 px-2 py-2">
											<button
												type="button"
												onclick={() => openCustomerWebsite(customer.website)}
												disabled={!customer.website}
												title={t('common.open')}
												aria-label={t('common.open')}
												class="icon-btn"
											>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
											</button>
											<button
												type="button"
												onclick={() => startEdit(customer)}
												title={t('common.edit')}
												aria-label={t('common.edit')}
												class="icon-btn"
											>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /></svg>
											</button>
											<button
												type="button"
												onclick={() => handleDsgvoExport(customer)}
												disabled={exportingCustomerId === customer.id}
												title="DSGVO-Auskunft (Art. 15 DSGVO) als ZIP exportieren"
												aria-label="DSGVO-Auskunft exportieren"
												class="icon-btn icon-btn-blue"
											>
												{#if exportingCustomerId === customer.id}
													<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
												{:else}
													<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
												{/if}
											</button>
											<button
												type="button"
												onclick={() => handleDsgvoErase(customer)}
												disabled={erasingCustomerId === customer.id}
												title="DSGVO-Löschung (Art. 17 DSGVO) — anonymisiert PII, soweit gesetzlich zulässig"
												aria-label="DSGVO-Löschung"
												class="icon-btn icon-btn-danger"
											>
												{#if erasingCustomerId === customer.id}
													<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
												{:else}
													<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.16-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.04-2.09 1.02-2.09 2.2v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
												{/if}
											</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
</section>
