<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import InvoiceForm, { type SaveData } from '../../../common/InvoiceForm.svelte';
	import { getInvoiceById, updateInvoice, deleteInvoice } from '$lib/db/invoices';
	import { listByInvoice, createInvoiceItem, updateInvoiceItem, deleteInvoiceItem } from '$lib/db/invoice-items';
	import { getS3Settings } from '$lib/db/settings';
	import { deleteFile } from '$lib/s3/client';
	import { createLogger } from '$lib/logger';
	import { t } from '$lib/i18n';
	import type { Invoice, InvoiceItem } from '$lib/db/types';

	const log = createLogger('rechnungen-edit');

	let invoice = $state<Invoice | null>(null);
	let existingItems = $state<InvoiceItem[]>([]);
	let loading = $state(true);
	let notFound = $state(false);
	let deleting = $state(false);

	const invoiceId = $derived(Number($page.params.id));

	$effect(() => {
		loadInvoice(invoiceId);
	});

	async function loadInvoice(id: number) {
		loading = true;
		const inv = await getInvoiceById(id);
		if (!inv) {
			notFound = true;
			loading = false;
			return;
		}
		invoice = inv;
		existingItems = (await listByInvoice(id)).rows;
		loading = false;
	}

	async function handleSave(data: SaveData) {
		if (!invoice) return;

		// DAT-1.d: float totals are converted to integer cents at the DB boundary.
		await updateInvoice(invoice.id, {
			customer_id: data.customerId,
			invoice_number: data.invoiceNumber,
			issue_date: data.issueDate,
			due_date: data.dueDate || null,
			service_period_start: data.servicePeriodStart || null,
			service_period_end: data.servicePeriodEnd || null,
			currency: data.currency,
			net_cents: Math.round(data.subtotal * 100),
			tax_cents: Math.round(data.taxTotal * 100),
			gross_cents: Math.round(data.grossTotal * 100),
			issuer_name: data.company.legal_name || data.company.name,
			issuer_tax_number: data.company.tax_number || null,
			issuer_vat_id: data.company.vat_id || null,
			issuer_bank_account_holder: data.company.bank_account_holder || null,
			issuer_bank_iban: data.company.bank_iban || null,
			issuer_bank_bic: data.company.bank_bic || null,
			issuer_bank_name: data.company.bank_name || null,
			notes: data.notes || null,
			language: data.language || 'de',
			legal_country_code: data.legalCountry || 'DE'
		});

		// Sync line items: delete removed, update existing, create new
		const newItemIds = new Set(data.items.filter(i => i.id).map(i => i.id!));
		for (const existing of existingItems) {
			if (!newItemIds.has(existing.id)) {
				await deleteInvoiceItem(existing.id);
			}
		}

		for (let i = 0; i < data.items.length; i++) {
			const item = data.items[i];
			const quantity = parseFloat(item.quantity) || 0;
			const unitPriceNet = parseFloat(item.unit_price_net) || 0;
			const lineTotalNet = quantity * unitPriceNet;
			const itemData = {
				position: i + 1,
				description: item.description,
				quantity,
				unit: 'Stk',
				unit_price_net_cents: Math.round(unitPriceNet * 100),
				tax_rate: parseFloat(item.tax_rate) || 0,
				line_total_net_cents: Math.round(lineTotalNet * 100)
			};
			if (item.id) {
				await updateInvoiceItem(item.id, itemData);
			} else {
				await createInvoiceItem({
					invoice_id: invoice.id,
					project_id: null,
					time_entry_id: null,
					...itemData
				});
			}
		}

		await goto('/rechnungen');
	}

	async function handleDelete() {
		if (!invoice) return;
		if (!confirm(t('invoices.deleteConfirm'))) return;
		deleting = true;

		try {
			const s3Config = await getS3Settings();
			if (s3Config.enabled) {
				const key = invoice.s3_key
					?? (() => {
						const safeNumber = invoice.invoice_number.replace(/[^a-zA-Z0-9\-_]/g, '-');
						const prefix = s3Config.path_prefix.replace(/\/$/, '');
						return prefix ? `${prefix}/${safeNumber}.pdf` : `${safeNumber}.pdf`;
					})();
				try { await deleteFile(s3Config, key); } catch (err) { log.warn('S3 delete failed', err); }
			}
		} catch { /* S3 settings not available */ }

		await deleteInvoice(invoice.id);
		await goto('/rechnungen');
	}

	const statusLabel = $derived.by(() => {
		const labels: Record<string, string> = {
			draft: t('invoices.statusDraft'),
			sent: t('invoices.statusSent'),
			paid: t('invoices.statusPaid'),
			void: t('invoices.statusVoid')
		};
		return invoice ? labels[invoice.status] || invoice.status : '';
	});

	const isDraft = $derived(invoice?.status === 'draft');
</script>

<section class="space-y-6">
	{#if loading}
		<div class="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('invoices.loadingInvoice')}</div>
	{:else if notFound}
		<div class="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
			{t('invoices.notFound')}
			<a href="/rechnungen" class="text-blue-600 underline">{t('invoices.backToList')}</a>
		</div>
	{:else if invoice}
		<header class="flex items-center justify-between">
			<div>
				<h1 class="page-header">
					{t('settings.invoiceTitle')} {invoice.invoice_number}
				</h1>
				<p class="text-sm text-zinc-600 dark:text-zinc-300">
					Status: {statusLabel}
					{#if !isDraft}
						<span class="ml-2 text-xs text-zinc-400">{t('invoices.onlyDraftsEditable')}</span>
					{/if}
				</p>
			</div>
			<div class="flex gap-2">
				{#if isDraft}
					<button
						type="button"
						onclick={handleDelete}
						disabled={deleting}
						class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
					>
						{deleting ? t('common.deleting') : t('common.delete')}
					</button>
				{/if}
				<a
					href="/rechnungen"
					class="btn-secondary"
				>
					{t('common.back')}
				</a>
			</div>
		</header>

		<InvoiceForm
			mode="edit"
			initialInvoiceNumber={invoice.invoice_number}
			initialCustomerId={String(invoice.customer_id)}
			initialCurrency={invoice.currency}
			initialIssueDate={invoice.issue_date}
			initialDueDate={invoice.due_date || ''}
			initialDueSurcharge="0"
			initialServicePeriodStart={invoice.service_period_start || ''}
			initialServicePeriodEnd={invoice.service_period_end || ''}
			initialDeliveryDate={invoice.issue_date}
			initialNotes={invoice.notes || ''}
			initialStatus={invoice.status}
			initialLanguage={invoice.language || 'de'}
			initialLegalCountry={invoice.legal_country_code || 'DE'}
			initialS3Key={invoice.s3_key}
			initialItems={existingItems.map(i => ({
				id: i.id,
				description: i.description,
				quantity: String(i.quantity),
				unit_price_net: String(i.unit_price_net),
				tax_rate: String(i.tax_rate)
			}))}
			readonly={!isDraft}
			onSave={handleSave}
			onS3KeyUpdate={(key) => {
				if (invoice) {
					invoice.s3_key = key;
					updateInvoice(invoice.id, { s3_key: key });
				}
			}}
		/>
	{/if}
</section>
