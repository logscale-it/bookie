<script lang="ts">
	import { t, tp } from '$lib/i18n';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';
	import { save } from '@tauri-apps/plugin-dialog';
	import { invoke } from '@tauri-apps/api/core';
	import { writeBinaryFile } from '$lib/fs';
	import { messageFor, messageForUnknown, parseBookieError } from '$lib/shared/errors';
	import { aiConfig, extractInvoice, extractInvoiceCloud, type Extracted } from '$lib/ai';
	import { can } from '$lib/session.svelte';
	import AddEntryFormSection from '../../common/components/AddEntryFormSection.svelte';
	import TextInput from '../../common/TextInput.svelte';
	import DateInput from '../../common/DateInput.svelte';
	import DisplayField from '../../common/DisplayField.svelte';
	import FileUpload from '../../common/FileUpload.svelte';
	import { createCompany, listCompanies } from '$lib/db/companies';
	import { listSuppliers, createCustomer } from '$lib/db/customers';
	import {
		listIncomingInvoices,
		createIncomingInvoice,
		updateIncomingInvoice,
		updateIncomingInvoiceStatus,
		updateIncomingInvoicePaidDate,
		deleteIncomingInvoice,
		getIncomingInvoiceFile,
		uploadReceipt,
		downloadReceipt,
		type IncomingInvoiceWithSupplier
	} from '$lib/db/incoming-invoices';
	import { snapshotIncoming, createRecurring } from '$lib/db/recurring';
	import { advance } from '$lib/recurrence';
	import { getS3Settings } from '$lib/db/settings';
	import { uploadFile, downloadFile as s3DownloadFile, deleteFile as s3DeleteFile } from '$lib/s3/client';
	import { createLogger } from '$lib/logger';
	import { cloud, CloudError } from '$lib/cloud';
	import type { Customer } from '$lib/db/types';
	import EInvoicePreview from '../../common/EInvoicePreview.svelte';
	import type { EInvoice } from '$lib/einvoice';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import { deferDelete } from '$lib/ui/undo';
	import { isPlainKey } from '$lib/ui/shortcut';

	const log = createLogger('eingehende-rechnungen');

	type InvoiceForm = {
		supplierName: string;
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
		supplierName: '',
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
	let recurring = $state(false);
	let editingId = $state<number | null>(null);
	let editForm = $state<InvoiceForm>(initialForm());
	let uploadError = $state('');
	let aiStatus = $state('');
	let aiBusy = $state(false);
	let bulkFiles = $state<FileList | null>(null);
	let bulkBusy = $state(false);
	let bulkStatus = $state('');
	const aiAvailable = cloud() !== null || aiConfig() !== null;
	const cols = 'minmax(0,0.8fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,0.8fr) 9rem minmax(0,0.5fr) 88px';

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

	const supplierNames = $derived(suppliers.map((s) => s.name));

	// Resolve a freehand issuer name to a supplier_id: reuse an existing
	// supplier (case-insensitive match) or create a new one on the fly.
	async function resolveSupplierId(
		companyId: number,
		rawName: string
	): Promise<number | null> {
		const name = rawName.trim();
		if (!name) return null;
		const existing = suppliers.find(
			(s) => s.name.toLowerCase() === name.toLowerCase()
		);
		if (existing) return existing.id;
		return createCustomer({
			company_id: companyId,
			customer_number: null,
			name,
			contact_name: null,
			email: null,
			phone: null,
			street: null,
			postal_code: null,
			city: null,
			country_code: 'DE',
			vat_id: null,
			website: null,
			type: 'lieferant'
		});
	}

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

	// DAT-5.b: helper to land a PDF on disk under <appdata>/incoming_invoices/
	// when S3 is unavailable. Mirrors the path layout used by the DAT-5.a
	// backfill (`<appdata>/incoming_invoices/<basename>`) so all on-disk
	// supplier PDFs share one directory under the user's backup boundary.
	async function writeLocalAttachment(file: File): Promise<string> {
		const appDataDir = await invoke<string>('get_app_data_dir');
		const sep = appDataDir.endsWith('/') || appDataDir.endsWith('\\') ? '' : '/';
		// Disambiguate by timestamp so two uploads with the same filename
		// (e.g. "rechnung.pdf" from two suppliers) don't clobber each other.
		const stamp = Date.now();
		const safeName = file.name.replace(/[\\/]/g, '_');
		const path = `${appDataDir}${sep}incoming_invoices/${stamp}-${safeName}`;
		await writeBinaryFile(path, new Uint8Array(await file.arrayBuffer()));
		return path;
	}

	// Creates the row from `f` and attaches `file` (S3, local disk or, in cloud
	// mode, the server's bucket). Attach failures land in `uploadError`; the row stays.
	async function storeInvoice(companyId: number, f: InvoiceForm, file: File | undefined): Promise<number> {
		const net = parseFloat(f.netAmount);
		const tax = parseFloat(f.taxAmount) || 0;

		let fileName: string | null = null;
		let fileType: string | null = null;
		let s3Key: string | null = null;
		// DAT-5.b: no-S3 uploads (or S3 fall-throughs on failure) land at
		// `local_path` instead of the legacy `file_data` BLOB.
		let localPath: string | null = null;

		// Cloud: the receipt goes to the server's bucket after the row exists (below).
		if (!cloud() && file) {
			fileName = file.name;
			fileType = file.type;

			const s3Config = await getS3Settings();
			if (s3Config.enabled) {
				try {
					const bytes = new Uint8Array(await file.arrayBuffer());
					s3Key = await uploadFile(s3Config, 'eingehende-rechnungen', file.name, bytes, file.type || 'application/octet-stream');
				} catch (err) {
					uploadError = `${t('incomingInvoices.s3UploadFailed')}: ${err instanceof Error ? err.message : err}`;
					try {
						localPath = await writeLocalAttachment(file);
					} catch (diskErr) {
						log.warn('Local attachment write failed after S3 failure', diskErr);
					}
				}
			} else {
				try {
					localPath = await writeLocalAttachment(file);
				} catch (err) {
					uploadError = `${t('incomingInvoices.s3UploadFailed')}: ${err instanceof Error ? err.message : err}`;
				}
			}
		}

		// DAT-1.d: convert float inputs to integer cents at the DB boundary.
		// `gross_cents` is derived inside `createIncomingInvoice`.
		const newId = await createIncomingInvoice({
			company_id: companyId,
			supplier_id: await resolveSupplierId(companyId, f.supplierName),
			invoice_number: f.invoiceNumber.trim() || null,
			invoice_date: f.invoiceDate,
			net_cents: Math.round(net * 100),
			tax_cents: Math.round(tax * 100),
			status: 'offen',
			file_name: fileName,
			file_type: fileType,
			s3_key: s3Key,
			local_path: localPath,
			notes: f.notes.trim() || null
		});

		if (cloud() && file) {
			try {
				await uploadReceipt(newId, file);
			} catch (err) {
				uploadError = `${t('incomingInvoices.s3UploadFailed')}: ${messageForUnknown(err)}`;
			}
		}
		return newId;
	}

	// Any failure (e.g. 403 on the recurring schedule) shows in the dialog and must not leave `saving` stuck.
	async function addInvoice() {
		if (!form.invoiceDate || isNaN(parseFloat(form.netAmount))) return;
		saving = true;
		uploadError = '';
		try {
			await saveInvoice();
		} catch (e) {
			uploadError = messageForUnknown(e);
		} finally {
			saving = false;
		}
	}

	async function saveInvoice() {
		const companyId = await ensureCompanyId();
		const newId = await storeInvoice(companyId, form, uploadFiles?.[0]);

		// Recurring: schedule the next copy one month out on the same day.
		// The boot generator (see +layout) materialises it.
		if (recurring) {
			const snap = await snapshotIncoming(newId);
			await createRecurring({
				company_id: companyId,
				kind: 'incoming',
				label: snap.label,
				frequency: 'monthly',
				interval_count: 1,
				next_run_date: advance(form.invoiceDate, 'monthly', 1),
				end_date: null,
				payload: snap.payload
			});
		}

		form = initialForm();
		uploadFiles = null;
		recurring = false;
		showAddForm = false;
		await loadData();
	}

	// Bulk capture: one open row per receipt, prefilled by AI and flagged in the
	// notes for review. Sequential: the server rate-limits OCR per company.
	async function bulkCapture() {
		const files = Array.from(bulkFiles ?? []);
		if (!files.length) return;
		bulkBusy = true;
		uploadError = '';
		let unread = 0;
		let lastError = '';
		try {
			const companyId = await ensureCompanyId();
			const config = aiConfig();
			for (const [i, file] of files.entries()) {
				bulkStatus = tp('incomingInvoices.bulkProgress', { i: i + 1, n: files.length });
				let x: Extracted = {};
				try {
					x = cloud() ? await extractInvoiceCloud(file) : await extractInvoice(file, config!);
				} catch (e) {
					log.warn(`Bulk AI extraction failed: ${file.name}`, e);
					lastError = `${t('incomingInvoices.aiError')}: ${messageForUnknown(e)}`;
				}
				if (!x.netAmount) unread++;
				const note = t(x.netAmount ? 'incomingInvoices.aiCheckNote' : 'incomingInvoices.aiFailedNote');
				await storeInvoice(companyId, { ...initialForm(), netAmount: '0', ...x, notes: note }, file);
				suppliers = await listSuppliers(companyId); // a supplier created for this receipt is reused by the next
			}
			bulkStatus = tp('incomingInvoices.bulkDone', { n: files.length, failed: unread }) + (lastError ? ` – ${lastError}` : '');
			bulkFiles = null;
		} catch (e) {
			bulkStatus = messageForUnknown(e);
		} finally {
			bulkBusy = false;
			await loadData();
		}
	}

	function toEditForm(inv: IncomingInvoiceWithSupplier): InvoiceForm {
		return {
			supplierName: inv.supplier_name ?? '',
			invoiceNumber: inv.invoice_number ?? '',
			invoiceDate: inv.invoice_date,
			netAmount: String(inv.net_cents / 100),
			taxAmount: String(inv.tax_cents / 100),
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

		const companyId = await ensureCompanyId();

		// DAT-1.d: writes go through `*_cents`; the UPDATE handler keeps
		// `gross_cents = net_cents + tax_cents` consistent automatically.
		await updateIncomingInvoice(editingId, {
			supplier_id: await resolveSupplierId(companyId, editForm.supplierName),
			invoice_number: editForm.invoiceNumber.trim() || null,
			invoice_date: editForm.invoiceDate,
			net_cents: Math.round(net * 100),
			tax_cents: Math.round((parseFloat(editForm.taxAmount) || 0) * 100),
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

	async function changePaidDate(id: number, e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		if (!v) return;
		await updateIncomingInvoicePaidDate(id, v);
		await loadData();
	}

	function removeInvoice(id: number) {
		const inv = invoices.find((i) => i.id === id);
		if (!inv) return;
		const before = invoices;
		deferDelete({
			message: inv.invoice_number ? `Rechnung ${inv.invoice_number} gelöscht` : 'Rechnung gelöscht',
			hide: () => {
				invoices = invoices.filter((i) => i.id !== id);
				totalCount -= 1;
			},
			restore: () => {
				invoices = before;
				totalCount += 1;
			},
			run: async () => {
				if (!cloud() && inv.s3_key) {
					try {
						const s3Config = await getS3Settings();
						if (s3Config.enabled) await s3DeleteFile(s3Config, inv.s3_key);
					} catch (err) {
						log.warn('S3 delete failed', err);
					}
				}
				await deleteIncomingInvoice(id);
			},
			onDone: () => loadData()
		});
	}

	function onKeydown(e: KeyboardEvent) {
		if (isPlainKey(e, 'n') && !showAddForm) {
			e.preventDefault();
			showAddForm = true;
		}
	}

	async function downloadFile(id: number) {
		const fileInfo = await getIncomingInvoiceFile(id);
		if (!fileInfo?.file_name) return;

		const path = await save({ defaultPath: fileInfo.file_name });
		if (!path) return;

		if (cloud()) {
			try {
				await writeBinaryFile(path, await downloadReceipt(id));
			} catch (err) {
				uploadError = `${t('incomingInvoices.s3DownloadFailed')}: ${messageForUnknown(err)}`;
			}
			return;
		}

		// DAT-5.b: download path no longer falls through to a `file_data`
		// BLOB. A row's PDF lives in exactly one place — S3 (`s3_key`) or
		// disk (`local_path`). Rows that still hold a legacy BLOB must be
		// evacuated by the DAT-5.a backfill before they can be downloaded.
		if (fileInfo.s3_key) {
			try {
				const s3Config = await getS3Settings();
				const data = await s3DownloadFile(s3Config, fileInfo.s3_key);
				await writeBinaryFile(path, data);
			} catch (err) {
				uploadError = `${t('incomingInvoices.s3DownloadFailed')}: ${messageForUnknown(err)}`;
			}
		} else if (fileInfo.local_path) {
			try {
				const data = await invoke<ArrayBuffer>('read_binary_file', { path: fileInfo.local_path });
				await writeBinaryFile(path, new Uint8Array(data));
			} catch (err) {
				uploadError = `${t('incomingInvoices.s3DownloadFailed')}: ${messageForUnknown(err)}`;
			}
		}
	}

	// AI receipt extraction: prefill the form from an uploaded PDF/image. Cloud:
	// via bookie-server; local: when configured (Einstellungen → KI). XML
	// e-invoices go through EInvoicePreview.
	$effect(() => {
		const file = uploadFiles?.[0];
		const config = aiConfig();
		const viaCloud = cloud() !== null;
		aiStatus = '';
		if (!file || (!viaCloud && !config) || /\.xml$/i.test(file.name)) return;
		let stale = false;
		aiBusy = true;
		aiStatus = t('incomingInvoices.aiReading');
		(viaCloud ? extractInvoiceCloud(file) : extractInvoice(file, config!))
			.then((x) => {
				if (stale) return;
				Object.assign(form, x);
				aiStatus = t('incomingInvoices.aiApplied');
			})
			.catch((e) => {
				if (stale) return;
				// Server without MISTRAL_API_KEY: no extraction offered, not an error.
				if (e instanceof CloudError && e.code === 'ocr_not_configured') return void (aiStatus = '');
				const err = parseBookieError(e);
				aiStatus = `${t('incomingInvoices.aiError')}: ${err.kind === 'Unknown' ? err.message : messageFor(err)}`;
			})
			.finally(() => {
				if (!stale) aiBusy = false;
			});
		return () => {
			stale = true;
			aiBusy = false;
		};
	});

	function applyEInvoice(e: EInvoice) {
		form.supplierName = e.seller.name;
		form.invoiceNumber = e.number;
		if (e.issueDate) form.invoiceDate = e.issueDate;
		form.netAmount = (e.totals.netCents / 100).toFixed(2);
		form.taxAmount = (e.totals.taxCents / 100).toFixed(2);
	}

	function formatCurrency(amount: number): string {
		return amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
	}

	function formatDate(dateStr: string): string {
		const [y, m, d] = dateStr.split('-');
		return `${d}.${m}.${y}`;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<section class="space-y-6">
	<datalist id="supplier-names">
		{#each supplierNames as name}
			<option value={name}></option>
		{/each}
	</datalist>

	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="page-header">{t('incomingInvoices.title')}</h1>
			<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
				{t('incomingInvoices.subtitle')}
			</p>
		</div>
		<button type="button" class="btn-primary shrink-0" onclick={() => (showAddForm = true)}>
			<svg class="-ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
			{t('incomingInvoices.addButton')}
			<kbd class="kbd !border-white/25 !bg-white/15 !text-white/80">N</kbd>
		</button>
	</header>

	<AddEntryFormSection
		title={t('incomingInvoices.newTitle')}
		buttonLabel={t('incomingInvoices.addButton')}
		bind:open={showAddForm}
	>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput
				bind:value={form.supplierName}
				label={t('incomingInvoices.supplier')}
				placeholder={t('incomingInvoices.supplierPlaceholder')}
				list="supplier-names"
			/>
			<TextInput bind:value={form.invoiceNumber} label={t('incomingInvoices.invoiceNumber')} placeholder="RE-2026-001" />
			<DateInput bind:value={form.invoiceDate} label={t('incomingInvoices.invoiceDate')} />
			<TextInput bind:value={form.netAmount} label={t('incomingInvoices.netAmount')} placeholder="0.00" />
			<TextInput bind:value={form.taxAmount} label={t('incomingInvoices.taxAmount')} placeholder="0.00" />
			<DisplayField value="{grossAmount()} €" label={t('incomingInvoices.grossAmount')} />
			<div class="md:col-span-2">
				<FileUpload bind:files={uploadFiles} label={t('incomingInvoices.uploadFile')} accept=".pdf,.xml,.png,.jpg,.jpeg,.webp" />
			</div>
			<div class="md:col-span-2">
				<EInvoicePreview files={uploadFiles} onapply={applyEInvoice} />
			</div>
			{#if aiStatus}
				<p class="text-sm text-zinc-600 md:col-span-2 dark:text-zinc-300">{aiStatus}</p>
			{/if}
			<div class="md:col-span-2">
				<TextInput bind:value={form.notes} label={t('common.notes')} placeholder={t('incomingInvoices.optionalNotes')} />
			</div>
			<!-- Schedules need incoming_invoices:edit (server recurring.ts); own uploads alone are not enough. -->
			{#if can('incoming_invoices', 'edit')}
				<label class="flex w-fit items-center gap-2 text-sm text-zinc-700 md:col-span-2 dark:text-zinc-200">
					<input type="checkbox" bind:checked={recurring} class="h-4 w-4 rounded border-zinc-300" />
					{t('common.recurringMonthly')}
				</label>
			{/if}
		</div>
		{#if uploadError}
			<p class="text-sm text-red-600 dark:text-red-400">{uploadError}</p>
		{/if}
		<div class="flex justify-end">
			<button
				type="button"
				onclick={addInvoice}
				disabled={saving || aiBusy || !form.invoiceDate || !form.netAmount}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('incomingInvoices.saveInvoice')}
			</button>
		</div>
	</AddEntryFormSection>

	{#if aiAvailable}
		<section class="card space-y-3">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">{t('incomingInvoices.bulkTitle')}</h2>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('incomingInvoices.bulkHint')}</p>
			<FileUpload bind:files={bulkFiles} multiple disabled={bulkBusy} label={t('incomingInvoices.bulkUpload')} accept=".pdf,.png,.jpg,.jpeg,.webp" />
			{#if bulkStatus}
				<p class="text-sm text-zinc-600 dark:text-zinc-300">{bulkStatus}</p>
			{/if}
			{#if uploadError && bulkStatus}
				<p class="text-sm text-red-600 dark:text-red-400">{uploadError}</p>
			{/if}
			<div class="flex justify-end">
				<button type="button" class="btn-primary" onclick={bulkCapture} disabled={bulkBusy || !bulkFiles?.length}>
					{t('incomingInvoices.bulkButton')}
				</button>
			</div>
		</section>
	{/if}

	<div class="space-y-3">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div class="flex items-end gap-3">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">
					{t('incomingInvoices.overview')}
				</h2>
				<div class="flex gap-0.5 rounded-lg bg-zinc-900/[0.04] p-0.5 ring-1 ring-zinc-900/5 dark:bg-white/[0.04] dark:ring-white/10" role="group" aria-label={t('common.status')}>
					{#each [{ value: '', label: t('common.all') }, ...statusOptions] as opt}
						<button
							type="button"
							onclick={() => (statusFilter = opt.value)}
							aria-pressed={statusFilter === opt.value}
							class="rounded-md px-2.5 py-1 text-xs font-medium transition duration-200 ease-spring {statusFilter === opt.value ? 'bg-white text-zinc-900 shadow-soft dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'}"
						>{opt.label}</button>
					{/each}
				</div>
			</div>
			<div class="w-full max-w-sm">
				<TextInput bind:value={search} label={t('common.search')} placeholder={t('incomingInvoices.searchPlaceholder')} />
			</div>
		</div>

		<div class="table-card">
			<div class="table-scroll">
			<div class="min-w-[1040px]">
			<div class="table-head" style="grid-template-columns: {cols}">
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
				<SkeletonRows rows={6} cols={7} />
			{:else if filteredInvoices.length === 0}
				{#if search || statusFilter}
					<EmptyState
						icon="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
						title={t('incomingInvoices.empty')}
						hint="Passe Suche oder Filter an."
					/>
				{:else}
					<EmptyState
						icon="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z"
						title={t('incomingInvoices.empty')}
						hint="Erfasse Belege deiner Lieferanten, inklusive PDF oder E-Rechnung."
						actionLabel={t('incomingInvoices.addButton')}
						onaction={() => (showAddForm = true)}
					/>
				{/if}
			{:else}
				<div>
					{#each filteredInvoices as inv (inv.id)}
						<div
							data-testid="incoming-row"
							class="data-row group {editingId === inv.id ? 'bg-accent-50/40 dark:bg-accent-900/10' : ''}"
							style="grid-template-columns: {cols}; min-height: 48px"
						>
							{#if editingId === inv.id}
								<div class="px-3 py-2"><input bind:value={editForm.invoiceNumber} aria-label={t('incomingInvoices.invoiceNumber')} class="input-base input-valid rounded-lg px-2 py-1" /></div>
								<div class="px-3 py-2">
									<input bind:value={editForm.supplierName} aria-label={t('incomingInvoices.supplier')} list="supplier-names" class="input-base input-valid rounded-lg px-2 py-1" />
								</div>
								<div class="px-3 py-2"><input type="date" bind:value={editForm.invoiceDate} aria-label={t('incomingInvoices.invoiceDate')} class="input-base input-valid rounded-lg px-2 py-1" /></div>
								<div class="px-3 py-2"><input bind:value={editForm.netAmount} aria-label={t('incomingInvoices.netAmount')} class="input-base input-valid rounded-lg px-2 py-1 text-right tabular-nums" /></div>
								<div class="px-3 py-2"><input bind:value={editForm.taxAmount} aria-label={t('incomingInvoices.taxAmount')} class="input-base input-valid rounded-lg px-2 py-1 text-right tabular-nums" /></div>
								<div class="px-3 py-2 text-right text-xs tabular-nums text-zinc-500">{editGrossAmount()} €</div>
								<div class="px-3 py-2"></div>
								<div class="px-3 py-2"></div>
								<div class="flex justify-end gap-2 px-3 py-2 text-xs">
									<button type="button" onclick={saveEdit} class="btn-primary px-2.5 py-1 text-xs" disabled={saving}>{t('common.save')}</button>
									<button type="button" onclick={cancelEdit} class="btn-secondary px-2.5 py-1 text-xs">{t('common.cancel')}</button>
								</div>
							{:else}
								<div class="truncate px-3 py-2 text-xs tabular-nums">{inv.invoice_number || '—'}</div>
								<div class="truncate px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{inv.supplier_name || '—'}</div>
								<div class="truncate px-3 py-2 tabular-nums">{formatDate(inv.invoice_date)}</div>
								<div class="truncate px-3 py-2 text-right tabular-nums">{formatCurrency(inv.net_cents / 100)}</div>
								<div class="truncate px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{formatCurrency(inv.tax_cents / 100)}</div>
								<div class="truncate px-3 py-2 text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{formatCurrency(inv.gross_cents / 100)}</div>
								<div class="px-3 py-2">
									<select
										value={inv.status}
										onchange={(e) => changeStatus(inv.id, e.currentTarget.value)}
										aria-label={t('common.status')}
										class="cursor-pointer rounded-full border px-2 py-0.5 text-xs font-medium outline-none transition duration-200 ease-spring focus-visible:ring-2 focus-visible:ring-accent-500/40
											{inv.status === 'bezahlt' ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300'}"
									>
										{#each statusOptions as opt}
											<option value={opt.value}>{opt.label}</option>
										{/each}
									</select>
									{#if inv.status === 'bezahlt'}
										<input
											type="date"
											aria-label={t('incomingInvoices.paidDate')}
											title={t('incomingInvoices.paidDate')}
											value={inv.paid_date ?? ''}
											onchange={(e) => changePaidDate(inv.id, e)}
											class="mt-0.5 block w-full max-w-[8.5rem] rounded-md bg-transparent px-1 py-0 text-[11px] tabular-nums text-zinc-500 outline-none transition hover:bg-zinc-100 focus:bg-white focus:ring-2 focus:ring-accent-500/30 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:focus:bg-zinc-800"
										/>
									{/if}
								</div>
								<div class="px-3 py-2">
									{#if inv.file_name}
										<button
											type="button"
											onclick={() => downloadFile(inv.id)}
											class="icon-btn icon-btn-blue"
											title={inv.file_name}
											aria-label={inv.file_name}
										>
											<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
										</button>
									{:else}
										<span class="text-xs text-zinc-400">—</span>
									{/if}
								</div>
								<div class="row-actions px-3 py-2">
									<button type="button" onclick={() => startEdit(inv)} class="icon-btn icon-btn-blue" title={t('common.edit')} aria-label={t('common.edit')}>
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
									</button>
									<button type="button" onclick={() => removeInvoice(inv.id)} class="icon-btn icon-btn-danger" title={t('common.delete')} aria-label={t('common.delete')}>
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.16-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.04-2.09 1.02-2.09 2.2v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			</div>
			</div>
		</div>

		{#if !loading && totalCount > 0 && pageCount > 1}
			<div class="flex items-center justify-between gap-3">
				<button
					type="button"
					class="btn-secondary"
					disabled={pager.page <= 1}
					onclick={() => gotoPage(pager.page - 1)}
				>
					{t('common.pagerPrev')}
				</button>
				<span class="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
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
