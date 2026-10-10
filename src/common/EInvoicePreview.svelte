<script lang="ts">
	import { t } from '$lib/i18n';
	import { readEInvoice, type EInvoice } from '$lib/einvoice';

	let {
		files = null,
		onapply
	}: { files?: FileList | null; onapply: (inv: EInvoice) => void } = $props();

	let inv = $state<EInvoice | null>(null);
	let error = $state('');

	// Read-only inspection: the File itself is never modified or re-encoded.
	$effect(() => {
		const file = files?.[0];
		inv = null;
		error = '';
		if (!file) return;
		let stale = false;
		file
			.arrayBuffer()
			.then((b) => readEInvoice(new Uint8Array(b)))
			.then((r) => {
				if (!stale) inv = r;
			})
			.catch((e) => {
				if (!stale) error = `${t('incomingInvoices.einvoiceError')}: ${e instanceof Error ? e.message : e}`;
			});
		return () => (stale = true);
	});

	const money = (c: number, cur: string) =>
		(c / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });
	const date = (d: string) => d.split('-').reverse().join('.');
</script>

{#if error}
	<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
{:else if inv}
	<div class="card space-y-2 text-sm">
		<h3 class="font-semibold">{t('incomingInvoices.einvoiceTitle')}</h3>
		<dl class="grid gap-x-4 gap-y-1 md:grid-cols-2">
			<div>{t('incomingInvoices.einvoiceSyntax')}: {inv.syntax === 'ubl' ? 'UBL' : 'CII'}{inv.profile ? ` (${inv.profile})` : ''}</div>
			<div>{t('incomingInvoices.invoiceNumber')}: {inv.number}</div>
			<div>{t('incomingInvoices.supplier')}: {inv.seller.name}{inv.seller.vatId ? ` (${inv.seller.vatId})` : ''}</div>
			<div>{t('incomingInvoices.invoiceDate')}: {date(inv.issueDate)}</div>
			<div>{t('incomingInvoices.net')}: {money(inv.totals.netCents, inv.currency)}</div>
			<div>{t('incomingInvoices.vat')}: {money(inv.totals.taxCents, inv.currency)}</div>
			<div class="font-medium">{t('incomingInvoices.gross')}: {money(inv.totals.grossCents, inv.currency)}</div>
		</dl>
		{#if inv.lines.length}
			<div>
				<div class="font-medium">{t('incomingInvoices.einvoiceLines')}</div>
				<ul class="list-disc pl-5">
					{#each inv.lines as l}
						<li>{l.quantity} {l.unit ?? ''} {l.name} – {money(l.netCents, inv.currency)}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<p class="text-xs text-zinc-500 dark:text-zinc-400">{t('incomingInvoices.einvoiceHint')}</p>
		<button type="button" class="btn-secondary" onclick={() => inv && onapply(inv)}>
			{t('incomingInvoices.einvoiceApply')}
		</button>
	</div>
{/if}
