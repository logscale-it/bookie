<script lang="ts">
	import { t, tp } from '$lib/i18n';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';
	import { save } from '@tauri-apps/plugin-dialog';
	import { invoke } from '@tauri-apps/api/core';
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import Select from '../../common/Select.svelte';
	import DisplayField from '../../common/DisplayField.svelte';
	import FileUpload from '../../common/FileUpload.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listSuppliers } from '$lib/db/customers';
	import {
		listIncomingInvoices,
		createIncomingInvoice,
		updateIncomingInvoice,
		updateIncomingInvoiceStatus,
		deleteIncomingInvoice,
		getIncomingInvoiceFile,
		type IncomingInvoiceWithSupplier
	} from '$lib/db/incoming-invoices';
	import { getS3Settings } from '$lib/db/settings';
	import { uploadFile, downloadFile as s3DownloadFile, deleteFile as s3DeleteFile } from '$lib/s3/client';
	import { createLogger } from '$lib/logger';
	import type { Customer } from '$lib/db/types';

	const log = createLogger('eingehende-rechnungen');

	type InvoiceForm = {
		supplierId: string;
		invoiceNumber: string;
		invoiceDate: string;
		netAmount: string;
		taxAmount: string;
		notes: string;
	};

	const statusOptions = $derived([
		{ value: 'offen', label: t('incomingInvoices.statusOpen') },
		{ value: 'bezahlt', label: t('incomingInvoices.statusPaid') }
	]);

	const initialForm = (): InvoiceForm => ({
		supplierId: '',
		invoiceNumber: '',
		invoiceDate: new Date().toISOString().slice(0, 10),
		netAmount: '',
		taxAmount: '0',
		notes: ''
	});

	let invoices = $state<IncomingInvoiceWithSupplier[]>([]);
	let totalCount = $state(0);
	let suppliers = $state<Customer[]>([]);
	let search = $state('');
	let statusFilter = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let showAddForm = $state(false);
	let form = $state<InvoiceForm>(initialForm());
	let uploadFiles = $state<FileList | null>(null);
	let editingId = $state<number | null>(null);
	let editForm = $state<InvoiceForm>(initialForm());
	let uploadError = $state('');

	const pager = $derived<PagerState>(parsePager(page.url.searchParams));
	const pageCount = $derived(totalPages(totalCount, pager.size));

	const grossAmount = $derived(() => {
		const net = parseFloat(form.netAmount) || 0;
		const tax = parseFloat(form.taxAmount) || 0;
		return (net + tax).toFixed(2);
	});

	const editGrossAmount = $derived(() => {
		const net = parseFloat(editForm.netAmount) || 0;
		const tax = parseFloat(editForm.taxAmount) || 0;
		return (net + tax).toFixed(2);
	});

	const filteredInvoices = $derived.by(() => {
		let result = invoices;

		if (statusFilter) {
			result = result.filter((i) => i.status === statusFilter);
		}

		const term = search.trim().toLowerCase();
		if (term) {
			result = result.filter((i) => {
				const haystack = [i.supplier_name, i.invoice_number, i.notes]
					.filter(Boolean)
					.join(' ')
					.toLowerCase();
				return haystack.includes(term);
			});
		}

		return result;
	});

	const supplierOptions = $derived(
		suppliers.map((s) => ({ value: String(s.id), label: s.name }))
	);

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
		const [invoicesResult, suppliersResult] = await Promise.all([
			listIncomingInvoices(companyId, { limit: size, offset }),
			listSuppliers(companyId)
		]);
		invoices = invoicesResult.rows;
		totalCount = invoicesResult.totalCount;
		suppliers = suppliersResult;
		loading = false;
	}

	function gotoPage(target: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(target));
		params.set('size', String(pager.size));
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	async function readFileAsArray(file: File): Promise<number[]> {
		const buffer = await file.arrayBuffer();
		return Array.from(new Uint8Array(buffer));
	}

	async function addInvoice() {
		const net = parseFloat(form.netAmount);
		if (!form.invoiceDate || isNaN(net)) return;
		saving = true;
		uploadError = '';

		const companyId = await ensureCompanyId();
		const tax = parseFloat(form.taxAmount) || 0;

		let fileData: number[] | null = null;
		let fileName: string | null = null;
		let fileType: string | null = null;
		let s3Key: string | null = null;

		if (uploadFiles && uploadFiles.length > 0) {
			const file = uploadFiles[0];
			fileName = file.name;
			fileType = file.type;

			const s3Config = await getS3Settings();
			if (s3Config.enabled) {
				try {
					const bytes = new Uint8Array(await file.arrayBuffer());
					s3Key = await uploadFile(s3Config, 'eingehende-rechnungen', file.name, bytes, file.type || 'application/octet-stream');
				} catch (err) {
					uploadError = `${t('incomingInvoices.s3UploadFailed')}: ${err instanceof Error ? err.message : err}`;
					fileData = await readFileAsArray(file);
				}
			} else {
				fileData = await readFileAsArray(file);
			}
		}

		await createIncomingInvoice({
			company_id: companyId,
			supplier_id: form.supplierId ? parseInt(form.supplierId) : null,
			invoice_number: form.invoiceNumber.trim() || null,
			invoice_date: form.invoiceDate,
			net_amount: net,
			tax_amount: tax,
			status: 'offen',
			file_data: fileData,
			file_name: fileName,
			file_type: fileType,
			s3_key: s3Key,
			notes: form.notes.trim() || null
		});

		form = initialForm();
		uploadFiles = null;
		showAddForm = false;
		saving = false;
		await loadData();
	}

	function toEditForm(inv: IncomingInvoiceWithSupplier): InvoiceForm {
		return {
			supplierId: inv.supplier_id ? String(inv.supplier_id) : '',
			invoiceNumber: inv.invoice_number ?? '',
			invoiceDate: inv.invoice_date,
			netAmount: String(inv.net_amount),
			taxAmount: String(inv.tax_amount),
			notes: inv.notes ?? ''
		};
	}

	function startEdit(inv: IncomingInvoiceWithSupplier) {
		editingId = inv.id;
		editForm = toEditForm(inv);
	}

	function cancelEdit() {
		editingId = null;
		editForm = initialForm();
	}

	async function saveEdit() {
		if (!editingId) return;
		const net = parseFloat(editForm.netAmount);
		if (isNaN(net)) return;
		saving = true;

		await updateIncomingInvoice(editingId, {
			supplier_id: editForm.supplierId ? parseInt(editForm.supplierId) : null,
			invoice_number: editForm.invoiceNumber.trim() || null,
			invoice_date: editForm.invoiceDate,
			net_amount: net,
			tax_amount: parseFloat(editForm.taxAmount) || 0,
			notes: editForm.notes.trim() || null
		});

		cancelEdit();
		saving = false;
		await loadData();
	}

	async function changeStatus(id: number, status: string) {
		await updateIncomingInvoiceStatus(id, status);
		await loadData();
	}

	async function removeInvoice(id: number) {
		if (!confirm(t('incomingInvoices.deleteConfirm'))) return;
		const inv = invoices.find(i => i.id === id);
		if (inv?.s3_key) {
			try {
				const s3Config = await getS3Settings();
				if (s3Config.enabled) await s3DeleteFile(s3Config, inv.s3_key);
			} catch (err) { log.warn('S3 delete failed', err); }
		}
		await deleteIncomingInvoice(id);
		await loadData();
	}

	async function downloadFile(id: number) {
		const fileInfo = await getIncomingInvoiceFile(id);
		if (!fileInfo?.file_name) return;

		const path = await save({ defaultPath: fileInfo.file_name });
		if (!path) return;

		if (fileInfo.s3_key) {
			try {
				const s3Config = await getS3Settings();
				const data = await s3DownloadFile(s3Config, fileInfo.s3_key);
				await invoke('write_binary_file', { path, data: Array.from(data) });
			} catch (err) {
				uploadError = `${t('incomingInvoices.s3DownloadFailed')}: ${err instanceof Error ? err.message : err}`;
			}
		} else if (fileInfo.file_data) {
			await invoke('write_binary_file', { path, data: fileInfo.file_data });
		}
	}

	function formatCurrency(amount: number): string {
		return amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
	}

	function formatDate(dateStr: string): string {
		const [y, m, d] = dateStr.split('-');
		return `${d}.${m}.${y}`;
	}
</script>

<section class="space-y-6">
	<header>
		<h1 class="page-header">{t('incomingInvoices.title')}</h1>
		<p class="text-sm text-zinc-600 dark:text-zinc-300">
			{t('incomingInvoices.subtitle')}
		</p>
	</header>

	<AddEntryFormSection
		title={t('incomingInvoices.newTitle')}
		buttonLabel={t('incomingInvoices.addButton')}
		bind:open={showAddForm}
	>
		<div class="grid gap-3 md:grid-cols-2">
			<Select
				bind:value={form.supplierId}
				label={t('incomingInvoices.supplier')}
				options={supplierOptions}
				placeholder={t('incomingInvoices.supplierPlaceholder')}
			/>
			<TextInput bind:value={form.invoiceNumber} label={t('incomingInvoices.invoiceNumber')} placeholder="RE-2026-001" />
			<DateInput bind:value={form.invoiceDate} label={t('incomingInvoices.invoiceDate')} />
			<TextInput bind:value={form.netAmount} label={t('incomingInvoices.netAmount')} placeholder="0.00" />
			<TextInput bind:value={form.taxAmount} label={t('incomingInvoices.taxAmount')} placeholder="0.00" />
			<DisplayField value="{grossAmount()} €" label={t('incomingInvoices.grossAmount')} />
			<div class="md:col-span-2">
				<FileUpload bind:files={uploadFiles} label={t('incomingInvoices.uploadFile')} accept=".pdf,.png,.jpg,.jpeg,.webp" />
			</div>
			<div class="md:col-span-2">
				<TextInput bind:value={form.notes} label={t('common.notes')} placeholder={t('incomingInvoices.optionalNotes')} />
			</div>
		</div>
		{#if uploadError}
			<p class="text-sm text-red-600 dark:text-red-400">{uploadError}</p>
		{/if}
		<div class="flex justify-end">
			<button
				type="button"
				onclick={addInvoice}
				disabled={saving || !form.invoiceDate || !form.netAmount}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('incomingInvoices.saveInvoice')}
			</button>
		</div>
	</AddEntryFormSection>

	<div class="card shadow-sm">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-3">
			<div class="flex items-end gap-3">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">
					{t('incomingInvoices.overview')}
				</h2>
				<div class="flex gap-1">
					<button
						type="button"
						onclick={() => (statusFilter = '')}
						class="rounded-md px-2 py-1 text-xs font-medium transition {statusFilter === '' ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'}"
					>{t('common.all')}</button>
					{#each statusOptions as opt}
						<button
							type="button"
							onclick={() => (statusFilter = opt.value)}
							class="rounded-md px-2 py-1 text-xs font-medium transition {statusFilter === opt.value ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'}"
						>{opt.label}</button>
					{/each}
				</div>
			</div>
			<div class="w-full max-w-sm">
				<TextInput bind:value={search} label={t('common.search')} placeholder={t('incomingInvoices.searchPlaceholder')} />
			</div>
		</div>

		<div class="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700">
			<div
				class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
				style="grid-template-columns: 0.8fr 1.2fr 0.8fr 0.8fr 0.8fr 0.8fr 0.7fr 0.5fr 1fr"
			>
				<div class="px-3 py-2">{t('incomingInvoices.invoiceNumber')}</div>
				<div class="px-3 py-2">{t('incomingInvoices.supplier')}</div>
				<div class="px-3 py-2">{t('common.date')}</div>
				<div class="px-3 py-2 text-right">{t('incomingInvoices.net')}</div>
				<div class="px-3 py-2 text-right">{t('incomingInvoices.vat')}</div>
				<div class="px-3 py-2 text-right">{t('incomingInvoices.gross')}</div>
				<div class="px-3 py-2">{t('common.status')}</div>
				<div class="px-3 py-2">{t('incomingInvoices.file')}</div>
				<div class="px-3 py-2 text-right">{t('common.action')}</div>
			</div>

			{#if loading}
				<div class="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('incomingInvoices.loading')}</div>
			{:else if filteredInvoices.length === 0}
				<div class="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('incomingInvoices.empty')}</div>
			{:else}
				<div class="max-h-[520px] overflow-y-auto">
					{#each filteredInvoices as inv (inv.id)}
						<div
							class="grid items-center border-b border-zinc-100 text-sm text-zinc-700 last:border-0 dark:border-zinc-700/70 dark:text-zinc-200"
							style="grid-template-columns: 0.8fr 1.2fr 0.8fr 0.8fr 0.8fr 0.8fr 0.7fr 0.5fr 1fr; min-height: 44px"
						>
							{#if editingId === inv.id}
								<div class="px-3 py-2"><input bind:value={editForm.invoiceNumber} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="px-3 py-2">
									<select bind:value={editForm.supplierId} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900">
										<option value="">—</option>
										{#each supplierOptions as opt}
											<option value={opt.value}>{opt.label}</option>
										{/each}
									</select>
								</div>
								<div class="px-3 py-2"><input type="date" bind:value={editForm.invoiceDate} class="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="px-3 py-2"><input bind:value={editForm.netAmount} class="w-full rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="px-3 py-2"><input bind:value={editForm.taxAmount} class="w-full rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-600 dark:bg-zinc-900" /></div>
								<div class="px-3 py-2 text-right text-xs text-zinc-500">{editGrossAmount()} €</div>
								<div class="px-3 py-2"></div>
								<div class="px-3 py-2"></div>
								<div class="flex justify-end gap-2 px-3 py-2 text-xs">
									<button type="button" onclick={saveEdit} class="rounded bg-blue-600 px-2 py-1 text-white" disabled={saving}>{t('common.save')}</button>
									<button type="button" onclick={cancelEdit} class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">{t('common.cancel')}</button>
								</div>
							{:else}
								<div class="truncate px-3 py-2">{inv.invoice_number || '—'}</div>
								<div class="truncate px-3 py-2">{inv.supplier_name || '—'}</div>
								<div class="truncate px-3 py-2">{formatDate(inv.invoice_date)}</div>
								<div class="truncate px-3 py-2 text-right">{formatCurrency(inv.net_amount)}</div>
								<div class="truncate px-3 py-2 text-right">{formatCurrency(inv.tax_amount)}</div>
								<div class="truncate px-3 py-2 text-right font-medium">{formatCurrency(inv.gross_amount)}</div>
								<div class="px-3 py-2">
									<select
										value={inv.status}
										onchange={(e) => changeStatus(inv.id, e.currentTarget.value)}
										class="rounded border px-1 py-0.5 text-xs font-medium
											{inv.status === 'bezahlt' ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300'}"
									>
										{#each statusOptions as opt}
											<option value={opt.value}>{opt.label}</option>
										{/each}
									</select>
								</div>
								<div class="px-3 py-2">
									{#if inv.file_name}
										<button
											type="button"
											onclick={() => downloadFile(inv.id)}
											class="rounded-md border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
											title={inv.file_name}
										>
											&#x2913;
										</button>
									{:else}
										<span class="text-xs text-zinc-400">—</span>
									{/if}
								</div>
								<div class="flex justify-end gap-2 px-3 py-2">
									<button type="button" onclick={() => startEdit(inv)} class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium dark:border-zinc-600">{t('common.edit')}</button>
									<button
										type="button"
										onclick={() => removeInvoice(inv.id)}
										class="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
									>{t('common.delete')}</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		{#if !loading && totalCount > 0}
			<div class="mt-4 flex items-center justify-between gap-3">
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
	</div>
</section>
