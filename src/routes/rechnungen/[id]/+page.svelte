<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import InvoiceForm, { type SaveData } from '../../../common/InvoiceForm.svelte';
	import InvoiceHistory from '../../../common/InvoiceHistory.svelte';
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
	import { deferDelete } from '$lib/ui/undo';
	import EmptyState from '../../../common/EmptyState.svelte';
	import StatusPill from '../../../common/StatusPill.svelte';
	import Dialog from '../../../common/Dialog.svelte';
	import { pendingDeletes } from '../pending-deletes.svelte';

	const log = createLogger('rechnungen-edit');

	let invoice = $state<Invoice | null>(null);
	let existingItems = $state<InvoiceItem[]>([]);
	let loading = $state(true);
	let notFound = $state(false);
	let stornoOpen = $state(false);
	let stornoReason = $state('');
	let hiddenPayments = $state<number[]>([]);
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
		// Reloads of the same invoice (status, payments) keep the page mounted so
		// the status pill can play its paid animation.
		if (invoice?.id !== id) loading = true;
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

	function handleDelete() {
		if (!invoice) return;
		const inv = invoice;
		// Undo instead of confirm(): drafts carry no GoBD weight. The list hides
		// the row until the timer fires (or brings it back on undo).
		deferDelete({
			message: t('invoices.deleted'),
			hide: () => {
				pendingDeletes.add(inv.id);
				goto('/rechnungen');
			},
			restore: () => pendingDeletes.delete(inv.id),
			onDone: () => pendingDeletes.delete(inv.id),
			run: async () => {
				// S3 archival is desktop-only; nothing was uploaded in cloud mode.
				if (!cloud()) try {
					const s3Config = await getS3Settings();
					if (s3Config.enabled) {
						const key = inv.s3_key
							?? (() => {
								const safeNumber = inv.invoice_number.replace(/[^a-zA-Z0-9\-_]/g, '-');
								const prefix = s3Config.path_prefix.replace(/\/$/, '');
								return prefix ? `${prefix}/${safeNumber}.pdf` : `${safeNumber}.pdf`;
							})();
						try { await deleteFile(s3Config, key); } catch (err) { log.warn('S3 delete failed', err); }
					}
				} catch { /* S3 settings not available */ }
				await deleteInvoice(inv.id);
			}
		});
	}

	const isDraft = $derived(invoice?.status === 'draft');
	// Server/desktop: only sent/paid originals can be stornoed or take payments; a storno itself cannot.
	const isOpen = $derived(
		(invoice?.status === 'sent' || invoice?.status === 'paid') && invoice?.references_invoice_id == null
	);
	const eur = (cents: number) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: invoice?.currency || 'EUR' });

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

	function deletePaymentUndoable(p: Payment) {
		deferDelete({
			message: t('invoices.paymentDeleted'),
			hide: () => (hiddenPayments = [...hiddenPayments, p.id]),
			restore: () => (hiddenPayments = hiddenPayments.filter((id) => id !== p.id)),
			run: () => deletePayment(p.id, p.invoice_id),
			// cloud may flip paid -> sent once the payment is gone
			onDone: () => act(async () => {})
		});
	}
	const visiblePayments = $derived(payments.filter((p) => !hiddenPayments.includes(p.id)));
	const paidCents = $derived(visiblePayments.reduce((s, p) => s + p.amount_cents, 0));

	async function handleStorno() {
		if (!invoice) return;
		const reason = stornoReason.trim();
		if (!reason) return;
		stornoOpen = false;
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
		<div class="space-y-3" aria-busy="true">
			<div class="skeleton h-3 w-24"></div>
			<div class="skeleton h-7 w-56"></div>
			<div class="skeleton mt-6 h-40 w-full rounded-xl"></div>
		</div>
	{:else if notFound}
		<EmptyState title={t('invoices.notFound')} actionLabel={t('invoices.backToList')} actionHref="/rechnungen" />
	{:else if invoice}
		<header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
			<div class="min-w-0 space-y-1.5">
				<a href="/rechnungen" class="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100">
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
					{t('invoices.title')}
				</a>
				<div class="flex flex-wrap items-center gap-3">
					<h1 class="page-header tabular-nums">
						<span class="sr-only">{t('settings.invoiceTitle')} </span>{invoice.invoice_number || '—'}
					</h1>
					<StatusPill {invoice} onchanged={() => loadInvoice(invoiceId)} />
				</div>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">
					{#if invoice.recipient_name}{invoice.recipient_name} · {/if}<span class="tabular-nums">{invoice.issue_date.split('-').reverse().join('.')}</span>
					{#if !isDraft}
						<span class="ml-1 inline-flex items-center gap-1 text-xs text-zinc-400">
							<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>
							{t('invoices.onlyDraftsEditable')}
						</span>
					{/if}
				</p>
				{#if invoice.references_invoice_id != null}
					<p class="text-sm text-zinc-600 dark:text-zinc-300">
						Storno zu <a href="/rechnungen/{invoice.references_invoice_id}" class="text-accent-600 underline-offset-2 hover:underline dark:text-accent-400">Rechnung #{invoice.references_invoice_id}</a>{invoice.cancellation_reason ? ` — Grund: ${invoice.cancellation_reason}` : ''}
					</p>
				{/if}
			</div>
			<div class="flex flex-col items-end gap-3">
				<p class="text-3xl font-semibold tracking-tight tabular-nums">{eur(invoice.gross_cents)}</p>
				<div class="flex gap-2">
					{#if isDraft}
						<button type="button" onclick={handleDelete} class="icon-btn icon-btn-danger" aria-label={t('common.delete')} title={t('common.delete')}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
						</button>
					{/if}
					{#if isOpen}
						<button type="button" onclick={() => ((stornoReason = ''), (stornoOpen = true))} disabled={busy} class="btn-secondary text-red-600 dark:text-red-400">
							{t('invoices.storno')}
						</button>
					{/if}
				</div>
			</div>
		</header>

		<Dialog bind:open={stornoOpen} title={t('invoices.stornoTitle')} size="sm">
			<form
				id="storno-form"
				class="space-y-3"
				onsubmit={(e) => {
					e.preventDefault();
					handleStorno();
				}}
			>
				<p class="text-sm text-zinc-600 dark:text-zinc-300">
					<span class="tabular-nums">{invoice.invoice_number}</span> · {t('invoices.stornoHint')}
				</p>
				<label class="block space-y-1">
					<span class="label">{t('invoices.stornoReason')}</span>
					<textarea bind:value={stornoReason} rows="3" required class="input-base input-valid"></textarea>
				</label>
			</form>
			{#snippet footer()}
				<button type="button" class="btn-secondary" onclick={() => (stornoOpen = false)}>{t('common.cancel')}</button>
				<button type="submit" form="storno-form" class="btn-danger" disabled={busy || !stornoReason.trim()}>{t('invoices.storno')}</button>
			{/snippet}
		</Dialog>

		<!-- remount on status change: the form reads its initial* props once -->
		{#key invoice.status}
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
		{/key}

		{#if !isDraft}
			<div class="card space-y-4">
				<div class="flex items-baseline justify-between gap-4">
					<h2 class="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Zahlungen</h2>
					<span class="text-sm text-zinc-500 dark:text-zinc-400">
						<span class="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{eur(paidCents)}</span>
						von <span class="tabular-nums">{eur(invoice.gross_cents)}</span> bezahlt
					</span>
				</div>
				<div class="h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-700/60">
					<div class="h-full origin-left rounded-full bg-emerald-500 transition-transform duration-500 ease-out-expo" style="transform: scaleX({invoice.gross_cents > 0 ? Math.min(1, paidCents / invoice.gross_cents) : 0})"></div>
				</div>
				{#if visiblePayments.length === 0}
					<p class="text-sm text-zinc-500 dark:text-zinc-400">Noch keine Zahlungen erfasst.</p>
				{:else}
					<ul class="divide-y divide-zinc-100 text-sm dark:divide-zinc-700/70">
						{#each visiblePayments as p (p.id)}
							<li class="group flex items-center justify-between gap-3 py-2">
								<span class="text-zinc-600 dark:text-zinc-300"><span class="tabular-nums">{p.payment_date.split('-').reverse().join('.')}</span> · {p.method ?? '—'}</span>
								<span class="flex items-center gap-2">
									<span class="font-medium tabular-nums">{eur(p.amount_cents)}</span>
									<span class="row-actions">
										<button type="button" class="icon-btn icon-btn-danger h-7 w-7" disabled={busy} aria-label={t('common.delete')} title={t('common.delete')} onclick={() => deletePaymentUndoable(p)}>
											<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
										</button>
									</span>
								</span>
							</li>
						{/each}
					</ul>
				{/if}
				{#if isOpen}
					<div class="grid items-end gap-3 border-t border-zinc-100 pt-4 md:grid-cols-4 dark:border-zinc-700/70">
						<label class="text-sm">
							<span class="label">Betrag (€)</span>
							<input bind:value={payAmount} inputmode="decimal" placeholder={((invoice.gross_cents - paidCents) / 100).toFixed(2).replace('.', ',')} class="input-base input-valid tabular-nums" />
						</label>
						<label class="text-sm">
							<span class="label">Datum</span>
							<input type="date" bind:value={payDate} class="input-base input-valid" />
						</label>
						<label class="text-sm">
							<span class="label">Zahlungsart</span>
							<select bind:value={payMethod} class="input-base input-valid">
								{#each ['Überweisung', 'Lastschrift', 'Bar', 'Karte', 'PayPal', 'Sonstiges'] as m}<option value={m}>{m}</option>{/each}
							</select>
						</label>
						<button type="button" class="btn-primary" disabled={busy} onclick={addPayment}>Zahlung erfassen</button>
					</div>
				{/if}
			</div>
		{/if}
		{#if cloud()}
			<!-- keyed: every reload of the invoice (save, payment) refetches the trail -->
			{#key invoice}<InvoiceHistory invoiceId={invoice.id} />{/key}
		{/if}
	{/if}
</section>
