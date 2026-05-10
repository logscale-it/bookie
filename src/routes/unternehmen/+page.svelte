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
	let exportFeedback = $state<{ kind: 'success' | 'error'; message: string } | null>(null);
	let erasingCustomerId = $state<number | null>(null);
	let eraseFeedback = $state<{ kind: 'success' | 'error'; message: string } | null>(null);

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
		eraseFeedback = null;
		const confirmed = window.confirm(
			`„${customer.name}“ gemäß DSGVO Art. 17 endgültig anonymisieren? ` +
				'Personenbezogene Daten werden unwiderruflich entfernt. Rechnungen ' +
				'und Buchungsbelege bleiben aus gesetzlichen Gründen (§147 AO) erhalten.'
		);
		if (!confirmed) return;

		erasingCustomerId = customer.id;
		try {
			await anonymizeCustomer(customer.id);
			eraseFeedback = {
				kind: 'success',
				message: `„${customer.name}“ wurde anonymisiert.`
			};
			await loadCustomers();
		} catch (e) {
			const err = e as Error;
			if (err?.name === 'RetentionViolation') {
				eraseFeedback = {
					kind: 'error',
					message: `Löschung verweigert: ${err.message}`
				};
			} else {
				eraseFeedback = {
					kind: 'error',
					message: `Fehler bei der DSGVO-Löschung: ${err?.message ?? String(e)}`
				};
			}
		} finally {
			erasingCustomerId = null;
		}
	}

	async function handleDsgvoExport(customer: Customer) {
		exportFeedback = null;
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
			exportFeedback = {
				kind: 'success',
				message: `DSGVO-Auskunft für „${customer.name}“ gespeichert.`
			};
		} catch (e) {
			exportFeedback = {
				kind: 'error',
				message: `Fehler beim Erstellen der DSGVO-Auskunft: ${(e as Error).message ?? String(e)}`
			};
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

	{#if exportFeedback}
		<div
			class="rounded-md border px-3 py-2 text-sm {exportFeedback.kind === 'success'
				? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
				: 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'}"
			role="status"
		>
			{exportFeedback.message}
		</div>
	{/if}

	{#if eraseFeedback}
		<div
			class="rounded-md border px-3 py-2 text-sm {eraseFeedback.kind === 'success'
				? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
				: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300'}"
			role="status"
		>
			{eraseFeedback.message}
		</div>
	{/if}

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
			<TextInput bind:value={form.vatId} label={t('companies.vatId')} placeholder="DE123456789" />
			<TextInput bind:value={form.website} label={t('companies.website')} placeholder="firma.de" />
		</div>
		<div class="flex justify-end">
			<button
				type="button"
				onclick={addCustomer}
				disabled={saving || !form.name.trim()}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('companies.saveCompany')}
			</button>
		</div>
	</AddEntryFormSection>

	<div class="card shadow-sm">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-3">
			<div class="flex items-end gap-3">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">
					{t('companies.overview')}
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

		<div class="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700">
			<div
				class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
				style="grid-template-columns: 1.2fr 0.7fr 1fr 0.5fr 0.7fr 1.2fr 0.7fr 0.7fr 0.7fr 1fr"
			>
				<div class="px-3 py-2">{t('common.name')}</div>
				<div class="px-3 py-2">{t('common.type')}</div>
				<div class="px-3 py-2">{t('companies.street')}</div>
				<div class="px-3 py-2">{t('companies.postalCode')}</div>
				<div class="px-3 py-2">{t('companies.city')}</div>
				<div class="px-3 py-2">{t('companies.emails')}</div>
				<div class="px-3 py-2">{t('companies.phone')}</div>
				<div class="px-3 py-2">{t('companies.vatId')}</div>
				<div class="px-3 py-2">{t('companies.website')}</div>
				<div class="px-3 py-2 text-right">{t('common.action')}</div>
			</div>

			{#if loading}
				<div class="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('companies.loading')}</div>
			{:else if filteredCustomers.length === 0}
				<div class="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('companies.empty')}</div>
			{:else}
				<div class="max-h-[520px] overflow-y-auto">
					{#each filteredCustomers as customer (customer.id)}
						<div
							class="grid items-center border-b border-zinc-100 text-sm text-zinc-700 last:border-0 dark:border-zinc-700/70 dark:text-zinc-200"
							style="grid-template-columns: 1.2fr 0.7fr 1fr 0.5fr 0.7fr 1.2fr 0.7fr 0.7fr 0.7fr 1fr; min-height: 44px"
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
								<div class="px-3 py-2"><input bind:value={editForm.vatId} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="px-3 py-2"><input bind:value={editForm.website} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="flex justify-end gap-2 px-3 py-2 text-xs">
									<button type="button" onclick={saveEdit} class="rounded bg-blue-600 px-2 py-1 text-white" disabled={saving || !editForm.name.trim()}>{t('common.save')}</button>
									<button type="button" onclick={cancelEdit} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">{t('common.cancel')}</button>
								</div>
							{:else}
								<div class="truncate px-3 py-2">{customer.name}</div>
								<div class="truncate px-3 py-2">
									<span class="rounded-full px-2 py-0.5 text-xs font-medium
										{customer.type === 'kunde' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' :
										customer.type === 'lieferant' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' :
										'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'}">
										{typeLabels[customer.type] ?? customer.type}
									</span>
								</div>
								<div class="truncate px-3 py-2">{customer.street || '—'}</div>
								<div class="truncate px-3 py-2">{customer.postal_code || '—'}</div>
								<div class="truncate px-3 py-2">{customer.city || '—'}</div>
								<div class="truncate px-3 py-2">{customer.email || '—'}</div>
								<div class="truncate px-3 py-2">{customer.phone || '—'}</div>
								<div class="truncate px-3 py-2">{customer.vat_id || '—'}</div>
								<div class="truncate px-3 py-2">{customer.website || '—'}</div>
								<div class="flex justify-end gap-2 px-3 py-2">
									<button
										type="button"
										onclick={() => openCustomerWebsite(customer.website)}
										disabled={!customer.website}
										class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
									>
										{t('common.open')}
									</button>
									<button type="button" onclick={() => startEdit(customer)} class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium dark:border-zinc-600">{t('common.edit')}</button>
									<button
										type="button"
										onclick={() => handleDsgvoExport(customer)}
										disabled={exportingCustomerId === customer.id}
										title="DSGVO-Auskunft (Art. 15 DSGVO) als ZIP exportieren"
										class="rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/30"
									>
										{exportingCustomerId === customer.id ? 'Exportiert…' : 'Auskunft erteilen'}
									</button>
									<button
										type="button"
										onclick={() => handleDsgvoErase(customer)}
										disabled={erasingCustomerId === customer.id}
										title="DSGVO-Löschung (Art. 17 DSGVO) — anonymisiert PII, soweit gesetzlich zulässig"
										class="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30"
									>
										{erasingCustomerId === customer.id ? 'Löscht…' : 'Löschen (DSGVO)'}
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</section>
