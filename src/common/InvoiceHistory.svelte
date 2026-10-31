<script lang="ts">
	// Cloud: who changed what on an invoice, its items and payments
	// (bookie-server GET /api/invoices/:id/audit, append-only invoice_audit).
	import { api } from '$lib/cloud';
	import { messageForUnknown } from '$lib/shared/errors';

	type AuditRow = {
		id: number;
		entity_type: 'invoices' | 'invoice_items' | 'payments';
		op: 'insert' | 'update' | 'delete';
		actor_name: string | null;
		ts_unix_us: number;
		fields_diff: Record<string, { before: unknown; after: unknown }>;
	};

	let { invoiceId }: { invoiceId: number } = $props();

	const WHAT = { invoices: 'Rechnung', invoice_items: 'Position', payments: 'Zahlung' };
	const OP = { insert: 'angelegt', update: 'geändert', delete: 'gelöscht' };
	// Bookkeeping columns every write touches; not worth listing.
	const NOISE = new Set(['id', 'company_id', 'invoice_id', 'created_at', 'updated_at', 'created_by']);

	let rows = $state<AuditRow[]>([]);
	let error = $state('');

	$effect(() => {
		api<AuditRow[]>(`/api/invoices/${invoiceId}/audit`)
			.then((r) => ((rows = r.reverse()), (error = '')))
			.catch((e) => (error = messageForUnknown(e)));
	});

	const fields = (r: AuditRow) =>
		r.op === 'update' ? Object.keys(r.fields_diff).filter((k) => !NOISE.has(k)).join(', ') : '';
</script>

<section class="card space-y-3" data-testid="invoice-history">
	<h2 class="text-base font-semibold">Verlauf</h2>
	{#if error}
		<p class="text-sm text-red-600">{error}</p>
	{:else if rows.length === 0}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">Noch keine Einträge.</p>
	{:else}
		<ol class="space-y-2 text-sm">
			{#each rows as r (r.id)}
				<li class="flex flex-wrap gap-x-2">
					<span class="tabular-nums text-zinc-500 dark:text-zinc-400">
						{new Date(r.ts_unix_us / 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
					</span>
					<strong>{r.actor_name ?? 'System'}</strong>
					<span>{WHAT[r.entity_type]} {OP[r.op]}</span>
					{#if fields(r)}<span class="text-zinc-500 dark:text-zinc-400">({fields(r)})</span>{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>
