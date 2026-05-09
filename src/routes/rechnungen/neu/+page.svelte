<script lang="ts">
	import { goto } from '$app/navigation';
	import InvoiceForm, { type SaveData } from '../../../common/InvoiceForm.svelte';
	import { createInvoice, updateInvoice } from '$lib/db/invoices';
	import { createInvoiceItem } from '$lib/db/invoice-items';
	import { getInvoiceSettings, saveInvoiceSettings } from '$lib/db/settings';
	import { t } from '$lib/i18n';

	let lastCreatedInvoiceId = $state<number | null>(null);

	async function handleSave(data: SaveData) {
		// DAT-1.d: convert float totals to integer cents at the DB boundary.
		const invoiceId = await createInvoice({
			company_id: data.company.id,
			customer_id: data.customerId,
			project_id: null,
			invoice_number: data.invoiceNumber,
			status: 'draft',
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
			recipient_name: '',
			recipient_street: null,
			recipient_postal_code: null,
			recipient_city: null,
			recipient_country_code: null,
			notes: data.notes || null,
			s3_key: null,
			language: data.language || 'de',
			legal_country_code: data.legalCountry || 'DE',
			delivery_date: data.issueDate,
			due_surcharge: data.dueSurcharge
		});

		for (let i = 0; i < data.items.length; i++) {
			const item = data.items[i];
			const quantity = parseFloat(item.quantity) || 0;
			const unitPriceNet = parseFloat(item.unit_price_net) || 0;
			const lineTotalNet = quantity * unitPriceNet;
			await createInvoiceItem({
				invoice_id: invoiceId,
				project_id: null,
				time_entry_id: null,
				position: i + 1,
				description: item.description,
				quantity,
				unit: 'Stk',
				unit_price_net_cents: Math.round(unitPriceNet * 100),
				tax_rate: parseFloat(item.tax_rate) || 0,
				line_total_net_cents: Math.round(lineTotalNet * 100)
			});
		}

		const settings = await getInvoiceSettings();
		await saveInvoiceSettings({
			...settings,
			invoice_number_incrementor: settings.invoice_number_incrementor + 1
		});

		lastCreatedInvoiceId = invoiceId;
		await goto('/rechnungen');
	}
</script>

<section class="space-y-6">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{t('invoices.newTitle')}</h1>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('invoices.newSubtitle')}</p>
		</div>
		<a
			href="/rechnungen"
			class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-700"
		>
			{t('common.back')}
		</a>
	</header>

	<InvoiceForm
		mode="create"
		onSave={handleSave}
		onS3KeyUpdate={(key) => {
			if (lastCreatedInvoiceId) {
				updateInvoice(lastCreatedInvoiceId, { s3_key: key });
			}
		}}
	/>
</section>
