<script lang="ts">
	import { listAllInvoices, updateInvoiceStatus, type InvoiceWithCustomer } from '$lib/db/invoices';
	import { t, tp } from '$lib/i18n';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';

	const STATUSES = $derived([
		{ value: 'draft', label: t('invoices.statusDraft') },
		{ value: 'sent', label: t('invoices.statusSent') },
		{ value: 'paid', label: t('invoices.statusPaid') },
		{ value: 'void', label: t('invoices.statusVoid') }
	]);

	let invoices = $state<InvoiceWithCustomer[]>([]);
	let totalCount = $state(0);
	let loading = $state(true);

	const pager = $derived<PagerState>(parsePager(page.url.searchParams));
	const pageCount = $derived(totalPages(totalCount, pager.size));

	$effect(() => {
		// re-fetch when URL pager changes
		loadInvoices(pager.page, pager.size);
	});

	async function loadInvoices(pageNum: number, size: number) {
		loading = true;
		const offset = (pageNum - 1) * size;
		const result = await listAllInvoices({ limit: size, offset });
		invoices = result.rows;
		totalCount = result.totalCount;
		loading = false;
	}

	function gotoPage(target: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(target));
		params.set('size', String(pager.size));
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	async function changeStatus(e: Event, invoice: InvoiceWithCustomer) {
		e.stopPropagation();
		const newStatus = (e.currentTarget as HTMLSelectElement).value;
		if (newStatus === invoice.status) return;
		await updateInvoiceStatus(invoice.id, invoice.status, newStatus);
		invoice.status = newStatus;
	}

	function formatDate(dateStr: string): string {
		if (!dateStr) return '—';
		const [y, m, d] = dateStr.split('-');
		return `${d}.${m}.${y}`;
	}

	function formatAmount(amount: number, currency: string): string {
		return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
	}

	function statusSelectClass(status: string): string {
		const base =
			'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium outline-none transition focus:ring-2 focus:ring-offset-1 appearance-none pr-6 bg-[url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%236b7280\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'M6 8l4 4 4-4\'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_0.25rem_center] bg-[length:1rem_1rem]';
		switch (status) {
			case 'draft':
				return `${base} border-zinc-300 bg-zinc-50 text-zinc-700 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`;
			case 'sent':
				return `${base} border-blue-300 bg-blue-50 text-blue-700 focus:ring-blue-400 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300`;
			case 'paid':
				return `${base} border-green-300 bg-green-50 text-green-700 focus:ring-green-400 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300`;
			case 'void':
				return `${base} border-red-300 bg-red-50 text-red-700 focus:ring-red-400 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300`;
			default:
				return `${base} border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`;
		}
	}
</script>

<section class="space-y-4">
	<header class="flex items-start justify-between">
		<div>
			<h1 class="page-header">{t('invoices.title')}</h1>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('invoices.subtitle')}</p>
		</div>
		<a
			href="/rechnungen/neu"
			class="btn-primary"
		>
			{t('invoices.newInvoice')}
		</a>
	</header>

	<div
		class="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800/40"
	>
		<div
			class="grid border-b border-zinc-200 bg-zinc-100 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
			style="grid-template-columns: 1.1fr 1.4fr 1fr 1fr 1.2fr"
		>
			<div class="truncate px-4 py-3">{t('invoices.invoiceNumber')}</div>
			<div class="truncate px-4 py-3">{t('invoices.customer')}</div>
			<div class="truncate px-4 py-3">{t('common.date')}</div>
			<div class="truncate px-4 py-3">{t('common.amount')}</div>
			<div class="truncate px-4 py-3">{t('common.status')}</div>
		</div>

		{#if loading}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
				{t('invoices.loading')}
			</div>
		{:else if invoices.length === 0}
			<div class="px-4 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
				{t('invoices.empty')}
			</div>
		{:else}
			<div class="overflow-y-auto" style="max-height: 520px">
				{#each invoices as invoice (invoice.id)}
					<a
						href="/rechnungen/{invoice.id}"
						class="grid cursor-pointer items-center border-b border-zinc-100 text-sm text-zinc-700 transition hover:bg-zinc-50 last:border-0 dark:border-zinc-700/70 dark:text-zinc-200 dark:hover:bg-zinc-700/30"
						style="grid-template-columns: 1.1fr 1.4fr 1fr 1fr 1.2fr; min-height: 44px"
					>
						<div class="truncate px-4 py-2">{invoice.invoice_number}</div>
						<div class="truncate px-4 py-2">{invoice.customer_name ?? '—'}</div>
						<div class="truncate px-4 py-2">{formatDate(invoice.issue_date)}</div>
						<div class="truncate px-4 py-2">{formatAmount(invoice.gross_cents / 100, invoice.currency)}</div>
						<div class="px-4 py-2">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<select
								class={statusSelectClass(invoice.status)}
								value={invoice.status}
								onclick={(e) => e.stopPropagation()}
								onchange={(e) => changeStatus(e, invoice)}
							>
								{#each STATUSES as s}
									<option value={s.value}>{s.label}</option>
								{/each}
							</select>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>

	{#if !loading && totalCount > 0}
		<div class="flex items-center justify-between gap-3">
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
</section>
