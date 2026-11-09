<script lang="ts">
	// Invoice status as a coloured pill that opens a small menu of the allowed
	// transitions (canChangeStatus). Choosing "paid" asks for the Zufluss date
	// inline; while paid, the same menu edits that date. Used by the invoice
	// list and the detail page; `onchanged` lets the caller reload.
	import { canChangeStatus, updateInvoiceStatus, updateInvoicePaidDate } from '$lib/db/invoices';
	import type { Invoice } from '$lib/db/types';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { can } from '$lib/session.svelte';
	import { t, tp } from '$lib/i18n';

	let { invoice, onchanged }: { invoice: Invoice; onchanged?: () => unknown } = $props();

	const localToday = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local

	const LABEL: Record<string, string> = $derived({
		draft: t('invoices.statusDraft'),
		sent: t('invoices.statusSent'),
		paid: t('invoices.statusPaid'),
		void: t('invoices.statusVoid')
	});
	const overdue = $derived(invoice.status === 'sent' && !!invoice.due_date && invoice.due_date < localToday());
	const tone = $derived(overdue ? 'overdue' : invoice.status);
	const STYLE: Record<string, { pill: string; dot: string }> = {
		draft: { pill: 'bg-zinc-100 text-zinc-600 ring-zinc-900/10 dark:bg-zinc-700/60 dark:text-zinc-300 dark:ring-white/10', dot: 'bg-zinc-400' },
		sent: { pill: 'bg-accent-50 text-accent-700 ring-accent-600/20 dark:bg-accent-900/30 dark:text-accent-300 dark:ring-accent-400/20', dot: 'bg-accent-500' },
		overdue: { pill: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-400/20', dot: 'bg-red-500' },
		paid: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-400/20', dot: 'bg-emerald-500' },
		void: { pill: 'bg-transparent text-zinc-400 ring-zinc-900/10 line-through dark:text-zinc-500 dark:ring-white/10', dot: 'bg-zinc-300 dark:bg-zinc-600' }
	};
	const style = $derived(STYLE[tone] ?? STYLE.draft);
	const label = $derived(overdue ? t('invoices.statusOverdue') : (LABEL[invoice.status] ?? invoice.status));
	const targets = $derived(
		(['draft', 'sent', 'paid', 'void'] as const).filter((s) => s !== invoice.status && canChangeStatus(invoice.status, s))
	);
	// Status changes need invoices:edit (server: invoices.ts route('edit')); view-only gets a plain badge.
	const interactive = $derived(can('invoices', 'edit') && (targets.length > 0 || invoice.status === 'paid'));

	let open = $state(false);
	let view = $state<'menu' | 'pay' | 'confirm'>('menu');
	let confirmTo = $state('');
	let payDate = $state('');
	let busy = $state(false);
	let root = $state<HTMLElement>();
	let menu = $state<HTMLElement>();

	// Paid moment: play the check-draw + pop when the status flips to paid
	// while mounted (not on first render).
	let prev: string | undefined;
	let celebrate = $state(0);
	$effect(() => {
		const s = invoice.status;
		if (prev !== undefined && prev !== 'paid' && s === 'paid') celebrate++;
		prev = s;
	});

	function toggle() {
		open = !open;
		view = 'menu';
		payDate = invoice.paid_date ?? localToday();
	}

	$effect(() => {
		if (!open) return;
		queueMicrotask(() => menu?.querySelector<HTMLElement>('[role=menuitem], input')?.focus());
		const away = (e: PointerEvent) => {
			if (!root?.contains(e.target as Node)) open = false;
		};
		window.addEventListener('pointerdown', away, true);
		return () => window.removeEventListener('pointerdown', away, true);
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			open = false;
			root?.querySelector<HTMLElement>('button')?.focus();
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const items = [...(menu?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
			if (!items.length) return;
			e.preventDefault();
			const i = items.indexOf(document.activeElement as HTMLElement);
			items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
		}
	}

	const money = () => new Intl.NumberFormat('de-DE', { style: 'currency', currency: invoice.currency || 'EUR' }).format(invoice.gross_cents / 100);

	async function run(fn: () => Promise<unknown>, success?: string) {
		busy = true;
		try {
			await fn();
			open = false;
			if (success) toasts.success(success);
		} catch (err) {
			// e.g. issuing a draft without items (cloud 400 no_items) or a lapsed subscription (402)
			toasts.error(err instanceof Error ? err.message : String(err));
		} finally {
			busy = false;
			// Reload so the caller reflects DB-side effects (paid_date stamp/clear).
			await onchanged?.();
		}
	}

	function pick(to: string) {
		if (to === 'paid') {
			view = 'pay';
			payDate = localToday();
			queueMicrotask(() => menu?.querySelector<HTMLElement>('input')?.focus());
			return;
		}
		// Issuing (number + GoBD lock) and storno are irreversible: one explicit confirm.
		if ((to === 'sent' && invoice.status === 'draft') || to === 'void') {
			confirmTo = to;
			view = 'confirm';
			queueMicrotask(() => menu?.querySelector<HTMLElement>('[data-confirm]')?.focus());
			return;
		}
		run(() => updateInvoiceStatus(invoice.id, invoice.status, to));
	}

	function confirmPaid() {
		if (!payDate) return;
		const { id, status } = invoice;
		run(async () => {
			await updateInvoiceStatus(id, status, 'paid');
			// The status change stamps today; only correct it when the user chose another day.
			if (payDate !== localToday()) await updateInvoicePaidDate(id, payDate);
		}, tp('invoices.paymentRecorded', { amount: money() }));
	}

	function savePaidDate() {
		if (!payDate || payDate === invoice.paid_date) return void (open = false);
		run(() => updateInvoicePaidDate(invoice.id, payDate));
	}
</script>

{#snippet dot(s: string)}
	<span class="h-1.5 w-1.5 shrink-0 rounded-full {STYLE[s]?.dot}"></span>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={root} class="relative inline-block {open ? 'z-20' : ''}" {onkeydown}>
	{#key celebrate}
		<button
			type="button"
			class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset transition duration-200 ease-spring {style.pill} {interactive ? 'cursor-pointer hover:brightness-[0.97] active:scale-[0.97] dark:hover:brightness-110' : 'cursor-default'} {celebrate ? 'paid-pop' : ''}"
			aria-haspopup={interactive ? 'menu' : undefined}
			aria-expanded={interactive ? open : undefined}
			disabled={busy}
			onclick={() => interactive && toggle()}
		>
			{#if invoice.status === 'paid'}
				<svg class="h-3 w-3 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
					<path class={celebrate ? 'check-draw' : ''} pathLength="1" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
				</svg>
			{:else}
				{@render dot(tone)}
			{/if}
			{label}
			{#if interactive}
				<svg class="-mr-0.5 h-3 w-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
			{/if}
		</button>
	{/key}

	{#if open}
		<div
			bind:this={menu}
			role="menu"
			tabindex="-1"
			aria-label={t('invoices.changeStatus')}
			class="absolute right-0 top-full mt-1.5 w-56 origin-top-right animate-pop rounded-xl bg-white p-1 text-sm text-zinc-700 shadow-float ring-1 ring-zinc-900/10 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-white/10"
		>
			{#if view === 'menu'}
				{#if targets.length}
					<p class="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('invoices.changeStatus')}</p>
					{#each targets as s (s)}
						<button
							type="button"
							role="menuitem"
							class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition duration-150 ease-spring hover:bg-zinc-100 focus-visible:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-700/70 dark:focus-visible:bg-zinc-700/70"
							disabled={busy}
							onclick={() => pick(s)}
						>
							{@render dot(s)}
							{LABEL[s]}
						</button>
					{/each}
				{/if}
				{#if invoice.status === 'paid'}
					<div class="{targets.length ? 'mt-1 border-t border-zinc-100 pt-2 dark:border-zinc-700' : 'pt-1'} space-y-1.5 px-2.5 pb-2">
						<label class="label block" for="paid-{invoice.id}">{t('invoices.paidDate')}</label>
						<div class="flex gap-1.5">
							<input id="paid-{invoice.id}" type="date" bind:value={payDate} class="input-base input-valid !py-1 text-xs tabular-nums" />
							<button type="button" class="btn-secondary !px-2.5 !py-1 text-xs" disabled={busy || !payDate} onclick={savePaidDate}>OK</button>
						</div>
					</div>
				{/if}
			{:else if view === 'confirm'}
				<div class="space-y-2.5 p-2">
					<p class="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
						{confirmTo === 'void'
							? t('statusPill.voidConfirm')
							: t('statusPill.issueConfirm')}
					</p>
					<div class="flex justify-between gap-2">
						<button type="button" class="icon-btn" aria-label={t('common.back')} onclick={() => (view = 'menu')}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
						</button>
						<button
							type="button"
							data-confirm
							class="{confirmTo === 'void' ? 'btn-danger' : 'btn-primary'} !px-3 !py-1.5 text-xs"
							disabled={busy}
							onclick={() => run(() => updateInvoiceStatus(invoice.id, invoice.status, confirmTo))}
						>
							{LABEL[confirmTo]}
						</button>
					</div>
				</div>
			{:else}
				<form
					class="space-y-2 p-2"
					onsubmit={(e) => {
						e.preventDefault();
						confirmPaid();
					}}
				>
					<label class="label block" for="pay-{invoice.id}">{t('invoices.paidDate')}</label>
					<input id="pay-{invoice.id}" type="date" bind:value={payDate} required class="input-base input-valid !py-1.5 tabular-nums" />
					<div class="flex justify-between gap-2 pt-1">
						<button type="button" class="icon-btn" aria-label={t('common.back')} onclick={() => (view = 'menu')}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
						</button>
						<button type="submit" class="btn-primary !bg-emerald-600 !px-3 !py-1.5 text-xs hover:!bg-emerald-700" disabled={busy || !payDate}>
							{t('invoices.markPaid')}
						</button>
					</div>
				</form>
			{/if}
		</div>
	{/if}
</div>

<style>
	.check-draw {
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: draw 520ms cubic-bezier(0.16, 1, 0.3, 1) 120ms forwards;
	}
	.paid-pop {
		animation: paid-pop 520ms cubic-bezier(0.32, 0.72, 0, 1);
	}
	@keyframes draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes paid-pop {
		0% {
			transform: scale(1);
		}
		35% {
			transform: scale(1.12);
		}
		100% {
			transform: scale(1);
		}
	}
</style>
