<script lang="ts">
	import TextInput from './TextInput.svelte';
	import DateInput from './DateInput.svelte';
	import Select from './Select.svelte';
	import { listCompanies } from '$lib/db/companies';
	import { listClients } from '$lib/db/customers';
	import {
		getInvoiceSettings,
		getOrganizationSettings,
		getS3Settings,
		listVatTaxes
	} from '$lib/db/settings';
	import { uploadInvoicePdf, presignDownloadUrl } from '$lib/s3/client';
	import type { Company, Customer, VatTax } from '$lib/db/types';
	import { generateInvoiceHtml, type InvoicePdfData } from '$lib/pdf/invoice-pdf';
	import { createInvoicePdf } from '$lib/pdf/invoice-pdf-writer';
	import { generateInvoiceNumber as formatInvoiceNumber } from '$lib/invoice-number';
	import { invoke } from '@tauri-apps/api/core';
	import { save } from '@tauri-apps/plugin-dialog';
	import { t, LOCALE_LABELS, type Locale } from '$lib/i18n';
	import { LEGAL_COUNTRIES, type LegalCountry } from '$lib/legal';

	type LineItem = {
		id?: number;
		description: string;
		quantity: string;
		unit_price_net: string;
		tax_rate: string;
	};

	type Props = {
		mode: 'create' | 'edit';
		initialInvoiceNumber?: string;
		initialCustomerId?: string;
		initialCurrency?: string;
		initialIssueDate?: string;
		initialDueDate?: string;
		initialDueSurcharge?: string;
		initialServicePeriodStart?: string;
		initialServicePeriodEnd?: string;
		initialDeliveryDate?: string;
		initialNotes?: string;
		initialItems?: LineItem[];
		initialStatus?: string;
		initialS3Key?: string | null;
		initialLanguage?: string;
		initialLegalCountry?: string;
		onSave: (data: SaveData) => Promise<void>;
		onS3KeyUpdate?: (s3Key: string) => void;
		readonly?: boolean;
	};

	export type SaveData = {
		company: Company;
		customerId: number;
		invoiceNumber: string;
		currency: string;
		issueDate: string;
		dueDate: string;
		dueSurcharge: number;
		servicePeriodStart: string;
		servicePeriodEnd: string;
		deliveryDate: string;
		notes: string;
		language: string;
		legalCountry: string;
		items: LineItem[];
		subtotal: number;
		taxTotal: number;
		grossTotal: number;
		taxGroups: Array<{ label: string; rate: number; netAmount: number; amount: number }>;
	};

	let {
		mode,
		initialInvoiceNumber = '',
		initialCustomerId = '',
		initialCurrency = '',
		initialIssueDate = '',
		initialDueDate = '',
		initialDueSurcharge = '0',
		initialServicePeriodStart = '',
		initialServicePeriodEnd = '',
		initialDeliveryDate = '',
		initialNotes = '',
		initialItems = [],
		initialStatus = 'draft',
		initialS3Key = null,
		initialLanguage = '',
		initialLegalCountry = '',
		onSave,
		onS3KeyUpdate,
		readonly = false
	}: Props = $props();

	const emptyItem = (): LineItem => ({
		description: '',
		quantity: '1',
		unit_price_net: '',
		tax_rate: '19'
	});

	let company = $state<Company | null>(null);
	let customers = $state<Customer[]>([]);
	let vatTaxes = $state<VatTax[]>([]);
	let orgSettings = $state({ name: '', country: '', address: '', street: '', postal_code: '', city: '', email: '', phone_number: '', registering_id: '', bank_name: '', bank_iban: '', bank_account_holder: '', vatin: '', website: '', default_locale: '', default_legal_country: '', einvoice_format: 'plain' as 'plain' | 'zugferd' | 'xrechnung' });
	let invoiceSettings = $state({ currency: 'EUR', decimal_places: 2, days_till_due: 14, due_surcharge: 0, notes: '', invoice_number_format: 'RE-{YYYY}-{COUNT}', invoice_number_incrementor: 1, company_logo_data_url: null as string | null });

	let loading = $state(true);
	let saving = $state(false);
	let showPreview = $state(false);
	let previewHtml = $state('');
	let noCompanyWarning = $state(false);

	let customerId = $state('');
	let invoiceNumber = $state('');
	let currency = $state('EUR');
	let issueDate = $state('');
	let dueDate = $state('');
	let dueSurcharge = $state('0');
	let servicePeriodStart = $state('');
	let servicePeriodEnd = $state('');
	let deliveryDate = $state('');
	let notes = $state('');
	let language = $state('de');
	let legalCountry = $state('DE');
	let items = $state<LineItem[]>([emptyItem()]);

	const CURRENCIES = [
		{ value: 'EUR', label: 'EUR' },
		{ value: 'USD', label: 'USD' },
		{ value: 'GBP', label: 'GBP' },
		{ value: 'CHF', label: 'CHF' }
	];

	const localeOptions = Object.entries(LOCALE_LABELS).map(([value, label]) => ({ value, label }));
	const legalCountryOptions = LEGAL_COUNTRIES.map((c) => ({ value: c.value, label: c.label }));

	function today(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	function addDays(dateStr: string, days: number): string {
		const d = new Date(dateStr);
		d.setDate(d.getDate() + days);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	function lineTotal(item: LineItem): number {
		return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price_net) || 0);
	}

	// Conversion at the PDF boundary: the form holds string-typed amounts and
	// computes totals as floats. The PDF generator (DAT-1.c) consumes integer
	// cents only. The form-side write path will move to cents in DAT-1.d (#54);
	// until then this is the only place a float -> cents conversion is needed.
	function toCents(value: number): number {
		return Number.isFinite(value) ? Math.round(value * 100) : 0;
	}

	const subtotal = $derived(items.reduce((sum, item) => sum + lineTotal(item), 0));

	const taxGroups = $derived.by(() => {
		const groups: Record<string, { label: string; rate: number; netAmount: number; amount: number }> = {};
		for (const item of items) {
			const rate = parseFloat(item.tax_rate) || 0;
			const total = lineTotal(item);
			const key = String(rate);
			if (!groups[key]) {
				const vat = vatTaxes.find((v) => v.goods_value_percent === rate);
				groups[key] = { label: vat ? `${vat.name} ${rate}%` : `Steuer ${rate}%`, rate, netAmount: 0, amount: 0 };
			}
			groups[key].netAmount += total;
			groups[key].amount += (total * rate) / 100;
		}
		return Object.values(groups);
	});

	const taxTotal = $derived(taxGroups.reduce((sum, g) => sum + g.amount, 0));
	const grossTotal = $derived(subtotal + taxTotal);

	const vatOptions = $derived(
		vatTaxes.map((v) => ({ value: String(v.goods_value_percent), label: `${v.name} ${v.goods_value_percent}%` }))
	);

	const customerOptions = $derived(
		customers.map((c) => ({ value: String(c.id), label: c.name }))
	);

	const isEditable = $derived(!readonly && (initialStatus === 'draft' || mode === 'create'));

	$effect(() => {
		loadData();
	});

	async function loadData() {
		loading = true;
		const companies = await listCompanies();
		if (companies.length > 0) {
			company = companies[0];
			customers = await listClients(company.id);
		}

		orgSettings = await getOrganizationSettings();
		invoiceSettings = await getInvoiceSettings();
		vatTaxes = await listVatTaxes();
		noCompanyWarning = !company && !orgSettings.name;

		if (mode === 'create') {
			issueDate = today();
			dueDate = addDays(issueDate, invoiceSettings.days_till_due);
			deliveryDate = issueDate;
			currency = invoiceSettings.currency;
			dueSurcharge = String(invoiceSettings.due_surcharge);
			notes = invoiceSettings.notes || '';
			language = orgSettings.default_locale || 'de';
			legalCountry = orgSettings.default_legal_country || 'DE';
			invoiceNumber = formatInvoiceNumber(
				invoiceSettings.invoice_number_format,
				invoiceSettings.invoice_number_incrementor
			);
			if (vatTaxes.length > 0) {
				items = [{ ...emptyItem(), tax_rate: String(vatTaxes[0].goods_value_percent) }];
			}
		} else {
			customerId = initialCustomerId;
			invoiceNumber = initialInvoiceNumber;
			currency = initialCurrency || 'EUR';
			issueDate = initialIssueDate;
			dueDate = initialDueDate || '';
			dueSurcharge = initialDueSurcharge;
			servicePeriodStart = initialServicePeriodStart;
			servicePeriodEnd = initialServicePeriodEnd;
			deliveryDate = initialDeliveryDate || initialIssueDate;
			notes = initialNotes;
			language = initialLanguage || 'de';
			legalCountry = initialLegalCountry || 'DE';
			items = initialItems.length > 0 ? initialItems : [emptyItem()];
		}

		loading = false;
	}

	function addItem() {
		const defaultRate = vatTaxes.length > 0 ? String(vatTaxes[0].goods_value_percent) : '19';
		items = [...items, { ...emptyItem(), tax_rate: defaultRate }];
	}

	function removeItem(index: number) {
		if (items.length <= 1) return;
		items = items.filter((_, i) => i !== index);
	}

	function getSelectedCustomer(): Customer | undefined {
		return customers.find((c) => c.id === Number(customerId));
	}

	function buildPdfData(): InvoicePdfData {
		const customer = getSelectedCustomer();
		const formatAddress = (street?: string | null, postalCode?: string | null, city?: string | null) =>
			[street, [postalCode, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
		const companyAddress = company ? formatAddress(company.street, company.postal_code, company.city) : '';
		const issuerAddress = companyAddress || formatAddress(orgSettings.street, orgSettings.postal_code, orgSettings.city) || orgSettings.address;

		const recipientAddress = customer
			? [customer.street, [customer.postal_code, customer.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
			: '';

		return {
			language: language as Locale,
			legalCountry: legalCountry as LegalCountry,
			issuerName: company?.legal_name || orgSettings.name || company?.name || '',
			issuerAddress,
			issuerTaxNumber: company?.tax_number || orgSettings.registering_id,
			issuerVatId: company?.vat_id || orgSettings.vatin,
			issuerBankAccountHolder: company?.bank_account_holder || orgSettings.bank_account_holder || orgSettings.name,
			issuerBankName: company?.bank_name || orgSettings.bank_name,
			issuerBankIban: company?.bank_iban || orgSettings.bank_iban,
			issuerBankBic: company?.bank_bic || '',
			issuerEmail: orgSettings.email,
			issuerWebsite: orgSettings.website,
			issuerPhone: orgSettings.phone_number,
			logoDataUrl: invoiceSettings.company_logo_data_url,
			recipientName: customer?.name || '',
			recipientAddress,
			invoiceNumber,
			issueDate,
			dueDate,
			deliveryDate: deliveryDate || issueDate,
			overdueCharge: parseFloat(dueSurcharge) || 0,
			servicePeriodStart,
			servicePeriodEnd,
			currency,
			notes,
			items: items.map((item, i) => ({
				position: i + 1,
				description: item.description,
				quantity: parseFloat(item.quantity) || 0,
				unit: 'Stk',
				unitPriceNetCents: toCents(parseFloat(item.unit_price_net) || 0),
				taxRate: parseFloat(item.tax_rate) || 0,
				lineTotalNetCents: toCents(lineTotal(item))
			})),
			subtotalCents: toCents(subtotal),
			taxGroups: taxGroups.map((g) => ({
				label: g.label,
				rate: g.rate,
				netAmountCents: toCents(g.netAmount),
				amountCents: toCents(g.amount)
			})),
			totalCents: toCents(grossTotal)
		};
	}

	function togglePreview() {
		if (showPreview) {
			showPreview = false;
			return;
		}
		previewHtml = generateInvoiceHtml(buildPdfData());
		showPreview = true;
	}

	let pdfError = $state('');
	let pdfSuccess = $state('');
	let pdfLoading = $state(false);
	let s3Key = $state<string | null>(null);
	$effect(() => { s3Key = initialS3Key ?? null; });
	let linkCopying = $state(false);

	function validatePdfData(data: InvoicePdfData): string[] {
		const missing: string[] = [];
		if (!data.issuerName) missing.push(t('invoiceForm.missingCompanyName'));
		if (!data.issuerAddress) missing.push(t('invoiceForm.missingCompanyAddress'));
		if (!data.issuerVatId) missing.push(t('invoiceForm.missingVatId'));
		if (!data.recipientName) missing.push(t('invoiceForm.missingCustomerName'));
		if (!data.invoiceNumber) missing.push(t('invoiceForm.missingInvoiceNumber'));
		if (data.items.length === 0 || !data.items.some(i => i.description && i.unitPriceNetCents > 0)) missing.push(t('invoiceForm.missingLineItem'));
		return missing;
	}

	async function downloadPdf() {
		const data = buildPdfData();
		const missing = validatePdfData(data);
		if (missing.length > 0) {
			pdfError = `${t('invoiceForm.missingFields')}:\n• ${missing.join('\n• ')}`;
			return;
		}
		pdfError = '';
		pdfSuccess = '';

		const safeNumber = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '-');
		const filePath = await save({
			title: t('invoiceForm.savePdf'),
			defaultPath: `Rechnung-${safeNumber}.pdf`,
			filters: [{ name: 'PDF', extensions: ['pdf'] }]
		});
		if (!filePath) return;

		pdfLoading = true;
		try {
			const pdfBytes = await createInvoicePdf(data);
			await invoke('write_binary_file', { path: filePath, data: Array.from(pdfBytes) });
		} catch (err) {
			pdfError = `${t('invoiceForm.pdfError')}: ${err}`;
		} finally {
			pdfLoading = false;
		}
	}

	async function handleSave() {
		if (!customerId || !invoiceNumber.trim()) return;
		if (!company) return;
		saving = true;
		pdfError = '';
		pdfSuccess = '';

		await onSave({
			company,
			customerId: Number(customerId),
			invoiceNumber,
			currency,
			issueDate,
			dueDate,
			dueSurcharge: parseFloat(dueSurcharge) || 0,
			servicePeriodStart,
			servicePeriodEnd,
			deliveryDate: deliveryDate || issueDate,
			notes,
			language,
			legalCountry,
			items,
			subtotal,
			taxTotal,
			grossTotal,
			taxGroups
		});

		try {
			const s3Config = await getS3Settings();
			if (s3Config.enabled) {
				const data = buildPdfData();
				const pdfBytes = await createInvoicePdf(data);
				const safeNumber = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '-');
				const key = await uploadInvoicePdf(s3Config, safeNumber, pdfBytes);
				s3Key = key;
				onS3KeyUpdate?.(key);
			}
		} catch (err) {
			pdfError = `${t('invoiceForm.s3UploadFailed')}: ${err instanceof Error ? err.message : err}`;
		}

		saving = false;
	}

	async function copySignedLink() {
		if (!s3Key) return;
		linkCopying = true;
		pdfError = '';
		pdfSuccess = '';
		try {
			const s3Config = await getS3Settings();
			const url = await presignDownloadUrl(s3Config, s3Key);
			await navigator.clipboard.writeText(url);
			pdfSuccess = t('invoiceForm.linkCopied');
		} catch (err) {
			pdfError = `${t('invoiceForm.linkCopyFailed')}: ${err instanceof Error ? err.message : err}`;
		} finally {
			linkCopying = false;
		}
	}

	function formatAmount(amount: number): string {
		return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
	}
</script>

<div class="flex gap-6" class:flex-col={!showPreview}>
	{#if loading}
		<div class="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('invoiceForm.loadingData')}</div>
	{:else}
		<!-- Form -->
		<div class="min-w-0 flex-1 space-y-6">
			{#if noCompanyWarning}
				<div class="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
					{t('invoiceForm.createCompanyFirst')} <a href="/einstellungen" class="underline">{t('invoiceForm.settingsLink')}</a>.
				</div>
			{/if}

			<div class="card shadow-sm">
				<!-- Row 1: Customer, Invoice Number, Currency -->
				<div class="grid gap-3 md:grid-cols-3">
					<Select
						bind:value={customerId}
						label={t('invoiceForm.selectCustomer')}
						options={customerOptions}
						placeholder={t('invoiceForm.selectCustomerPlaceholder')}
						disabled={!isEditable}
					/>
					<TextInput bind:value={invoiceNumber} label={t('invoiceForm.invoiceNumber')} disabled={!isEditable} />
					<Select bind:value={currency} label={t('invoiceForm.currency')} options={CURRENCIES} disabled={!isEditable} />
				</div>

				<!-- Row 2: Dates + Surcharge -->
				<div class="mt-3 grid gap-3 md:grid-cols-4">
					<DateInput bind:value={issueDate} label={t('invoiceForm.issueDate')} disabled={!isEditable} />
					<DateInput bind:value={dueDate} label={t('invoiceForm.dueDate')} disabled={!isEditable} />
					<DateInput bind:value={deliveryDate} label={t('invoiceForm.deliveryDate')} disabled={!isEditable} />
					<div class="flex flex-col gap-1">
						<TextInput bind:value={dueSurcharge} label={t('invoiceForm.overdueInterest')} type="number" placeholder="0" disabled={!isEditable} />
						<span class="text-right text-[10px] text-zinc-400">% p.a.</span>
					</div>
				</div>

				<!-- Row 3: Service period + Language/Legal -->
				<div class="mt-3 grid gap-3 md:grid-cols-4">
					<DateInput bind:value={servicePeriodStart} label={t('invoiceForm.servicePeriodFrom')} disabled={!isEditable} />
					<DateInput bind:value={servicePeriodEnd} label={t('invoiceForm.servicePeriodTo')} disabled={!isEditable} />
					<Select bind:value={language} label={t('invoiceForm.language')} options={localeOptions} disabled={!isEditable} />
					<Select bind:value={legalCountry} label={t('invoiceForm.legalCountry')} options={legalCountryOptions} disabled={!isEditable} />
				</div>
			</div>

			<!-- Line items -->
			<div class="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/40">
				<div
					class="grid border-b border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
					style="grid-template-columns: 1fr 100px 100px 140px 100px 40px"
				>
					<div class="px-3 py-2">{t('invoiceForm.description')}</div>
					<div class="px-3 py-2">{t('invoiceForm.quantity')}</div>
					<div class="px-3 py-2">{t('invoiceForm.unitPrice')}</div>
					<div class="px-3 py-2">{t('invoiceForm.taxPercent')}</div>
					<div class="px-3 py-2 text-right">{t('invoiceForm.total')}</div>
					<div class="px-3 py-2"></div>
				</div>

				{#each items as item, i}
					<div
						class="grid items-center border-b border-zinc-100 dark:border-zinc-700/70"
						style="grid-template-columns: 1fr 100px 100px 140px 100px 40px"
					>
						<div class="px-2 py-1.5">
							<input
								type="text"
								bind:value={item.description}
								placeholder="{t('invoiceForm.description')}…"
								disabled={!isEditable}
								class="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
							/>
						</div>
						<div class="px-2 py-1.5">
							<input
								type="number"
								bind:value={item.quantity}
								min="0"
								step="1"
								disabled={!isEditable}
								class="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
							/>
						</div>
						<div class="px-2 py-1.5">
							<input
								type="number"
								bind:value={item.unit_price_net}
								min="0"
								step="0.01"
								placeholder="0,00"
								disabled={!isEditable}
								class="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
							/>
						</div>
						<div class="px-2 py-1.5">
							{#if vatOptions.length > 0}
								<select
									bind:value={item.tax_rate}
									disabled={!isEditable}
									class="w-full cursor-pointer rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
								>
									{#each vatOptions as opt}
										<option value={opt.value}>{opt.label}</option>
									{/each}
								</select>
							{:else}
								<input
									type="number"
									bind:value={item.tax_rate}
									min="0"
									step="1"
									placeholder="19"
									disabled={!isEditable}
									class="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
								/>
							{/if}
						</div>
						<div class="px-3 py-1.5 text-right text-sm text-zinc-700 dark:text-zinc-200">
							{formatAmount(lineTotal(item))}
						</div>
						<div class="px-1 py-1.5 text-center">
							{#if isEditable}
								<button
									type="button"
									onclick={() => removeItem(i)}
									disabled={items.length <= 1}
									class="text-zinc-400 transition hover:text-red-500 disabled:opacity-30"
									title={t('invoiceForm.removeItem')}
								>
									&#x2715;
								</button>
							{/if}
						</div>
					</div>
				{/each}

				{#if isEditable}
					<div class="p-3">
						<button
							type="button"
							onclick={addItem}
							class="btn-secondary"
						>
							{t('invoiceForm.addItem')}
						</button>
					</div>
				{/if}
			</div>

			<!-- Notes + Summary -->
			<div class="flex gap-6">
				<div class="flex-1">
					<label class="label mb-1 block">
						{t('invoiceForm.customerNote')}
						<textarea
							bind:value={notes}
							rows="4"
							disabled={!isEditable}
							class="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
						></textarea>
					</label>
				</div>
				<div class="w-64 space-y-1 pt-5 text-sm">
					<div class="flex justify-between">
						<span class="text-zinc-500 dark:text-zinc-400">{t('invoiceForm.subtotal')}:</span>
						<span>{formatAmount(subtotal)}</span>
					</div>
					{#each taxGroups as g}
						<div class="flex justify-between">
							<span class="text-zinc-500 dark:text-zinc-400">{g.label}:</span>
							<span>{formatAmount(g.amount)}</span>
						</div>
					{/each}
					<div class="flex justify-between border-t border-zinc-200 pt-1 font-semibold dark:border-zinc-700">
						<span>{t('invoiceForm.grossTotal')}:</span>
						<span>{formatAmount(grossTotal)}</span>
					</div>
				</div>
			</div>

			{#if pdfError}
				<div class="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm whitespace-pre-line text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">{pdfError}</div>
			{/if}
			{#if pdfSuccess}
				<div class="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">{pdfSuccess}</div>
			{/if}

			<!-- Action buttons -->
			<div class="flex gap-3">
				<button
					type="button"
					onclick={togglePreview}
					class="btn-secondary"
				>
					{showPreview ? t('invoiceForm.closePreview') : t('invoiceForm.preview')}
				</button>
				<button
					type="button"
					onclick={downloadPdf}
					disabled={pdfLoading}
					class="btn-secondary"
				>
					{pdfLoading ? t('invoiceForm.creatingPdf') : t('invoiceForm.downloadPdf')}
				</button>
				{#if s3Key}
					<button
						type="button"
						onclick={copySignedLink}
						disabled={linkCopying}
						class="btn-secondary"
					>
						{linkCopying ? t('invoiceForm.creatingLink') : t('invoiceForm.copyLink')}
					</button>
				{/if}
				{#if isEditable}
					<button
						type="button"
						onclick={handleSave}
						disabled={saving || !customerId || !invoiceNumber.trim()}
						class="btn-primary"
					>
						{saving ? t('common.saving') : mode === 'create' ? t('invoiceForm.createInvoice') : t('common.saveChanges')}
					</button>
				{/if}
			</div>
		</div>

		<!-- PDF Preview -->
		{#if showPreview}
			<div class="w-[520px] shrink-0">
				<div class="sticky top-4 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/40">
					<div class="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
						<span class="label">{t('invoiceForm.pdfPreview')}</span>
						<button
							type="button"
							onclick={() => (showPreview = false)}
							class="text-xs text-zinc-400 hover:text-zinc-600"
						>
							{t('common.close')}
						</button>
					</div>
					<div class="overflow-hidden" style="height: 735px;">
						<iframe
							srcdoc={previewHtml}
							title={t('invoiceForm.invoicePreview')}
							class="border-0"
							style="width: 793px; height: 1122px; transform: scale(0.655); transform-origin: top left;"
							sandbox="allow-same-origin"
						></iframe>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>
