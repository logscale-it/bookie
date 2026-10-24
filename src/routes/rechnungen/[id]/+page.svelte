<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import InvoiceForm, { type SaveData } from '../../../common/InvoiceForm.svelte';
	import { getInvoiceById, updateInvoice, deleteInvoice, syncInvoiceItems, cancelInvoice } from '$lib/db/invoices';
	import { listByInvoice } from '$lib/db/invoice-items';
	import { listByInvoice as listPayments, createPayment, deletePayment } from '$lib/db/payments';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { withTransaction } from '$lib/db/connection';
	import { getS3Settings } from '$lib/db/settings';
	import { deleteFile } from '$lib/s3/client';
	import { createLogger } from '$lib/logger';
	import { t } from '$lib/i18n';
	import { cloud } from '$lib/cloud';
	import type { Invoice, InvoiceItem, Payment } from '$lib/db/types';

	const log = createLogger('rechnungen-edit');

	let invoice = $state<Invoice | null>(null);
	let existingItems = $state<InvoiceItem[]>([]);
	let loading = $state(true);
	let notFound = $state(false);
	let deleting = $state(false);
	let payments = $state<Payment[]>([]);
	let payAmount = $state('');
	let payDate = $state(new Date().toISOString().slice(0, 10));
	let payMethod = $state('Überweisung');
	let busy = $state(false);

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
		payments = inv.status === 'draft' ? [] : (await listPayments(id)).rows;
		loading = false;
	}

	async function handleSave(data: SaveData) {
		if (!invoice) return;

		const items = data.items.map((item, i) => {
			const quantity = parseFloat(item.quantity) || 0;
			const unitPriceNet = parseFloat(item.unit_price_net) || 0;
			return {
				id: item.id,
				position: i + 1,
				description: item.description,
				quantity,
				unit: 'Stk',
				unit_price_net_cents: Math.round(unitPriceNet * 100),
				tax_rate: parseFloat(item.tax_rate) || 0,
				line_total_net_cents: Math.round(quantity * unitPriceNet * 100)
			};
		});
		const id = invoice.id;
		const save = async () => {
			// DAT-1.d: float totals are converted to integer cents at the DB boundary.
			await updateInvoice(id, {
				customer_id: data.customerId,
				invoice_number: data.invoiceNumber,
				issue_date: data.issueDate,
				due_date: data.dueDate || null,
				service_period_start: data.servicePeriodStart || null,
				service_period_end: data.servicePeriodEnd || null,
				buyer_reference: data.buyerReference || null,
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
				issuer_street: data.company.street,
				issuer_postal_code: data.company.postal_code,
				issuer_city: data.company.city,
				issuer_country_code: data.company.country_code,
				recipient_name: data.customer?.name ?? '',
				recipient_street: data.customer?.street ?? null,
				recipient_postal_code: data.customer?.postal_code ?? null,
				recipient_city: data.customer?.city ?? null,
				recipient_country_code: data.customer?.country_code ?? null,
				notes: data.notes || null,
				language: data.language || 'de',
				legal_country_code: data.legalCountry || 'DE'
			});

			await syncInvoiceItems(id, items, existingItems);
		};
		// Cloud: header PATCH (server ignores number/issuer/totals) + items PATCH.
		if (cloud()) await save();
		else await withTransaction(save);

		await goto('/rechnungen');
	}

	async function handleDelete() {
		if (!invoice) return;
		if (!confirm(t('invoices.deleteConfirm'))) return;
		deleting = true;

		// S3 archival is desktop-only; nothing was uploaded in cloud mode.
		if (!cloud()) try {
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
	// Server/desktop: only sent/paid originals can be stornoed or take payments; a storno itself cannot.
	const isOpen = $derived(
		(invoice?.status === 'sent' || invoice?.status === 'paid') && invoice?.references_invoice_id == null
	);
	const eur = (cents: number) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: invoice?.currency || 'EUR' });
	const paidCents = $derived(payments.reduce((s, p) => s + p.amount_cents, 0));

	// Runs an action, reports failures, reloads the invoice (cloud may flip sent <-> paid).
	async function act(fn: () => Promise<unknown>) {
		busy = true;
		try {
			await fn();
			await loadInvoice(invoiceId);
		} catch (e) {
			toasts.error(String((e as Error).message ?? e));
		} finally {
			busy = false;
		}
	}

	function addPayment() {
		const cents = Math.round(Number(payAmount.replace(',', '.')) * 100);
		if (!invoice || !Number.isInteger(cents) || cents <= 0 || !payDate) {
			toasts.error('Bitte Betrag und Datum angeben');
			return;
		}
		const invoice_id = invoice.id;
		return act(async () => {
			await createPayment({ invoice_id, payment_date: payDate, amount_cents: cents, method: payMethod || null, reference: null, note: null });
			payAmount = '';
		});
	}

	async function handleStorno() {
		if (!invoice) return;
		const reason = prompt(`Rechnung ${invoice.invoice_number} stornieren? Grund:`)?.trim();
		if (!reason) return;
		busy = true;
		try {
			const stornoId = await cancelInvoice(invoice.id, reason);
			await goto(`/rechnungen/${stornoId}`);
		} catch (e) {
			toasts.error(String((e as Error).message ?? e));
		} finally {
			busy = false;
		}
	}
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
				{#if invoice.references_invoice_id != null}
					<p class="text-sm text-zinc-600 dark:text-zinc-300">
						Storno zu <a href="/rechnungen/{invoice.references_invoice_id}" class="text-blue-600 underline">Rechnung #{invoice.references_invoice_id}</a>{invoice.cancellation_reason ? ` — Grund: ${invoice.cancellation_reason}` : ''}
					</p>
				{/if}
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
				{#if isOpen}
					<button
						type="button"
						onclick={handleStorno}
						disabled={busy}
						class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
					>
						Stornieren
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
			initialBuyerReference={invoice.buyer_reference || ''}
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
				unit_price_net: String(i.unit_price_net_cents / 100),
				tax_rate: String(i.tax_rate)
			}))}
			readonly={!isDraft}
			snapshot={isDraft ? null : invoice}
			onSave={handleSave}
			onS3KeyUpdate={(key) => {
				if (invoice) {
					invoice.s3_key = key;
					updateInvoice(invoice.id, { s3_key: key });
				}
			}}
		/>

		{#if !isDraft}
			<div class="card space-y-3">
				<div class="flex items-baseline justify-between">
					<h2 class="text-lg font-semibold">Zahlungen</h2>
					<span class="text-sm text-zinc-600 dark:text-zinc-300">
						{eur(paidCents)} von {eur(invoice.gross_cents)} bezahlt
					</span>
				</div>
				{#if payments.length === 0}
					<p class="text-sm text-zinc-500 dark:text-zinc-400">Noch keine Zahlungen erfasst.</p>
				{:else}
					<ul class="divide-y divide-zinc-100 text-sm dark:divide-zinc-700">
						{#each payments as p (p.id)}
							<li class="flex items-center justify-between py-2">
								<span>{p.payment_date} · {p.method ?? '—'}</span>
								<span class="flex items-center gap-3">
									{eur(p.amount_cents)}
									<button
										type="button"
										class="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
										disabled={busy}
										onclick={() => confirm('Zahlung löschen?') && act(() => deletePayment(p.id, p.invoice_id))}
									>
										{t('common.delete')}
									</button>
								</span>
							</li>
						{/each}
					</ul>
				{/if}
				{#if isOpen}
					<div class="grid items-end gap-3 md:grid-cols-4">
						<label class="text-sm">
							<span class="label">Betrag (€)</span>
							<input bind:value={payAmount} inputmode="decimal" placeholder={((invoice.gross_cents - paidCents) / 100).toFixed(2).replace('.', ',')} class="input-base" />
						</label>
						<label class="text-sm">
							<span class="label">Datum</span>
							<input type="date" bind:value={payDate} class="input-base" />
						</label>
						<label class="text-sm">
							<span class="label">Zahlungsart</span>
							<select bind:value={payMethod} class="input-base">
								{#each ['Überweisung', 'Lastschrift', 'Bar', 'Karte', 'PayPal', 'Sonstiges'] as m}<option value={m}>{m}</option>{/each}
							</select>
						</label>
						<button type="button" class="btn-primary" disabled={busy} onclick={addPayment}>Zahlung erfassen</button>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</section>
