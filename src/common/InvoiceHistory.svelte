<script lang="ts">
	// Cloud: who changed what on an invoice, its items and payments
	// (bookie-server GET /api/invoices/:id/audit, append-only invoice_audit).
	import { api } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';
	import { getLocaleFormatting, t } from '$lib/i18n';

	type AuditRow = {
		id: number;
		entity_type: 'invoices' | 'invoice_items' | 'payments';
		op: 'insert' | 'update' | 'delete';
		actor_name: string | null;
		ts_unix_us: number;
		fields_diff: Record<string, { before: unknown; after: unknown }>;
	};

	let { invoiceId }: { invoiceId: number } = $props();

	const WHAT = { invoices: 'history.invoice', invoice_items: 'history.item', payments: 'history.payment' };
	const OP = { insert: 'history.inserted', update: 'history.updated', delete: 'history.deleted' };
	// Bookkeeping columns every write touches; not worth listing.
	const NOISE = new Set(['id', 'company_id', 'invoice_id', 'created_at', 'updated_at', 'created_by']);

	let rows = $state<AuditRow[]>([]);
	let error = $state('');

	$effect(() => {
		api<AuditRow[]>(`/api/invoices/${invoiceId}/audit`)
			.then((r) => ((rows = r.reverse()), (error = '')))
			.catch((e) => (error = messageForUnknown(e)));
	});

	// "vor 5 Min." etc.; the absolute timestamp stays in the title tooltip.
	const rtf = new Intl.RelativeTimeFormat(getLocaleFormatting(), { numeric: 'auto', style: 'short' });
	function relative(us: number): string {
		const sec = Math.round((us / 1000 - Date.now()) / 1000);
		const steps: [Intl.RelativeTimeFormatUnit, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12]];
		let v = sec;
		for (const [unit, size] of steps) {
			if (Math.abs(v) < size) return unit === 'second' ? t('history.justNow') : rtf.format(v, unit);
			v = Math.round(v / size);
		}
		return rtf.format(v, 'year');
	}
	const DOT = { insert: 'bg-emerald-500', update: 'bg-accent-500', delete: 'bg-red-500' };

	const fields = (r: AuditRow) =>
		r.op === 'update' ? Object.keys(r.fields_diff).filter((k) => !NOISE.has(k)).join(', ') : '';
</script>

<section class="card space-y-4" data-testid="invoice-history">
	<h2 class="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t('history.title')}</h2>
	{#if error}
		<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
	{:else if rows.length === 0}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('history.empty')}</p>
	{:else}
		<ol class="relative space-y-3 text-sm before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-zinc-200 dark:before:bg-zinc-700">
			{#each rows as r (r.id)}
				<li class="relative flex gap-3 pl-6">
					<span class="absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full ring-[3px] ring-white dark:ring-zinc-800 {DOT[r.op]}"></span>
					<div class="min-w-0 flex-1">
						<p class="text-zinc-700 dark:text-zinc-200">
							<span class="font-medium text-zinc-900 dark:text-zinc-100">{r.actor_name ?? t('history.system')}</span>
							· {t(WHAT[r.entity_type])} {t(OP[r.op])}
						</p>
						{#if fields(r)}<p class="truncate text-xs text-zinc-500 dark:text-zinc-400">{fields(r)}</p>{/if}
					</div>
					<time
						class="shrink-0 text-xs tabular-nums text-zinc-400"
						datetime={new Date(r.ts_unix_us / 1000).toISOString()}
						title={new Date(r.ts_unix_us / 1000).toLocaleString(getLocaleFormatting(), { dateStyle: 'medium', timeStyle: 'short' })}
					>
						{relative(r.ts_unix_us)}
					</time>
				</li>
			{/each}
		</ol>
	{/if}
</section>
