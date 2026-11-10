<script lang="ts">
	import { listAllInvoices, type InvoiceWithCustomer } from '$lib/db/invoices';
	import { t, tp } from '$lib/i18n';
	import { publishContext } from '$lib/chat/context.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { parsePager, totalPages, type PagerState } from '$lib/pager';
	import { isPlainKey } from '$lib/ui/shortcut';
	import StatusPill from '../../common/StatusPill.svelte';
	import SkeletonRows from '../../common/SkeletonRows.svelte';
	import EmptyState from '../../common/EmptyState.svelte';
	import { can } from '$lib/session.svelte';
	import { pendingDeletes } from './pending-deletes.svelte';

	const COLS = 'grid-template-columns: minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1.1fr)';

	let invoices = $state<InvoiceWithCustomer[]>([]);
	let totalCount = $state(0);
	let loading = $state(true);

	const pager = $derived<PagerState>(parsePager(page.url.searchParams));
	const pageCount = $derived(totalPages(totalCount, pager.size));
	// Drafts deleted from the detail page stay hidden during their undo window.
	const visible = $derived(invoices.filter((i) => !pendingDeletes.has(i.id)));

	$effect(() => {
		// re-fetch when URL pager changes, or a deferred delete lands / is undone
		void pendingDeletes.size;
		loadInvoices(pager.page, pager.size);
	});

	async function loadInvoices(pageNum: number, size: number) {
		const offset = (pageNum - 1) * size;
		const result = await listAllInvoices({ limit: size, offset });
		invoices = result.rows;
		totalCount = result.totalCount;
		loading = false;
	}

	$effect(() => {
		if (loading) return;
		const eur = (c: number) => Math.round(c) / 100;
		const byStatus: Record<string, number> = {};
		for (const i of visible) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
		return publishContext({
			page: 'rechnungen',
			title: t('nav.invoices'),
			facts: {
				totalRows: totalCount,
				pageNumber: pager.page,
				pageCount,
				pageSize: pager.size,
				shownRows: visible.length,
				pageGrossEur: eur(visible.reduce((s, i) => s + i.gross_cents, 0)),
				pageNetEur: eur(visible.reduce((s, i) => s + i.net_cents, 0)),
				countByStatus: byStatus,
				invoices: visible.slice(0, 15).map((i) => ({ number: i.invoice_number, customer: i.customer_name, issueDate: i.issue_date, dueDate: i.due_date, grossEur: eur(i.gross_cents), currency: i.currency, status: i.status }))
			}
		});
	});

	function gotoPage(target: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(target));
		params.set('size', String(pager.size));
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return '—';
		const [y, m, d] = dateStr.split('-');
		return `${d}.${m}.${y}`;
	}

	function formatAmount(amount: number, currency: string): string {
		return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (isPlainKey(e, 'n') && can('invoices', 'edit')) {
			e.preventDefault();
			goto('/rechnungen/neu');
		}
	}}
/>

<section class="space-y-4">
	<header class="flex items-start justify-between gap-4">
		<div>
			<h1 class="page-header">{t('invoices.title')}</h1>
			<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('invoices.subtitle')}</p>
		</div>
		{#if can('invoices', 'edit')}
			<a href="/rechnungen/neu" class="btn-primary" title="{t('invoices.newTitle')} (N)">
				<svg class="-ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
				{t('invoices.newTitle')}
				<kbd class="kbd !border-white/25 !bg-white/15 !text-white/80">N</kbd>
			</a>
		{/if}
	</header>

	<!-- No overflow clip: the head sticks to <main> (the scroll container) and the status menu may overhang the card. -->
	<div class="table-card !overflow-visible">
		<div class="table-head rounded-t-[11px]" style={COLS}>
			<div class="truncate px-4 py-3">{t('invoices.invoiceNumber')}</div>
			<div class="truncate px-4 py-3">{t('invoices.customer')}</div>
			<div class="truncate px-4 py-3">{t('common.date')}</div>
			<div class="truncate px-4 py-3 text-right">{t('common.amount')}</div>
			<div class="truncate px-4 py-3">{t('common.status')}</div>
		</div>

		{#if loading}
			<SkeletonRows rows={6} cols={5} />
		{:else if visible.length === 0}
			<EmptyState
				title={t('invoices.empty')}
				hint={t('invoices.emptyHint')}
				actionLabel={can('invoices', 'edit') ? t('invoices.createFirst') : undefined}
				actionHref={can('invoices', 'edit') ? '/rechnungen/neu' : undefined}
			/>
		{:else}
			{#each visible as invoice (invoice.id)}
				<div data-testid="invoice-row" class="data-row group relative min-h-[52px] last:rounded-b-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700/30" style={COLS}>
					<!-- Stretched link: the whole row navigates; the status pill sits above it. -->
					<a
						href="/rechnungen/{invoice.id}"
						class="truncate px-4 py-2 text-[13px] tabular-nums text-zinc-900 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent-500/40 dark:text-zinc-100"
					>
						{invoice.invoice_number || '—'}
					</a>
					<div class="min-w-0 px-4 py-2">
						<p class="truncate font-medium text-zinc-900 dark:text-zinc-100">{invoice.customer_name ?? '—'}</p>
						{#if invoice.due_date && invoice.status === 'sent'}
							<p class="truncate text-xs text-zinc-500 dark:text-zinc-400">{tp('invoices.dueOn', { date: formatDate(invoice.due_date) })}</p>
						{/if}
					</div>
					<div class="truncate px-4 py-2 text-[13px] tabular-nums text-zinc-500 dark:text-zinc-400">{formatDate(invoice.issue_date)}</div>
					<div class="truncate px-4 py-2 text-right text-[13px] font-medium tabular-nums">{formatAmount(invoice.gross_cents / 100, invoice.currency)}</div>
					<div class="px-4 py-2">
						<StatusPill {invoice} onchanged={() => loadInvoices(pager.page, pager.size)} />
					</div>
				</div>
			{/each}
		{/if}
	</div>

	{#if !loading && totalCount > 0 && pageCount > 1}
		<nav class="flex items-center justify-end gap-1 text-sm" aria-label="Pagination">
			<button type="button" class="icon-btn" aria-label={t('common.pagerPrev')} disabled={pager.page <= 1} onclick={() => gotoPage(pager.page - 1)}>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
			</button>
			<span class="min-w-14 text-center text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{pager.page} / {pageCount}</span>
			<button type="button" class="icon-btn" aria-label={t('common.pagerNext')} disabled={pager.page >= pageCount} onclick={() => gotoPage(pager.page + 1)}>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
			</button>
		</nav>
	{/if}
</section>
