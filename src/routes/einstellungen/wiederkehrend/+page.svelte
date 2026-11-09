<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { deleteRecurring, listRecurring, updateRecurring } from '$lib/db/recurring';
	import type { RecurringEntry } from '$lib/db/types';
	import { messageForUnknown } from '$lib/shared/errors';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';
	import { deferDelete } from '$lib/ui/undo';
	import SectionHead from '../SectionHead.svelte';
	import EmptyState from '../../../common/EmptyState.svelte';
	import { can } from '$lib/session.svelte';

	// Schedules are created from an invoice / incoming invoice ("monatlich");
	// here they are listed, edited, paused and deleted.
	// Server recurring.ts: changing a schedule needs edit on its area.
	const mayEdit = (r: RecurringEntry) => can(r.kind === 'invoice' ? 'invoices' : 'incoming_invoices', 'edit');
	const KINDS: Record<RecurringEntry['kind'], string> = {
		invoice: 'recurring.kindInvoiceDraft',
		incoming: 'recurring.kindIncomingInvoice'
	};
	const FREQUENCIES: RecurringEntry['frequency'][] = ['weekly', 'monthly', 'quarterly', 'yearly'];
	const day = (d: string | null) =>
		d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(getLocaleFormatting(), { timeZone: 'UTC' }) : '–';

	let entries = $state<RecurringEntry[]>([]);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');

	async function load() {
		try {
			entries = await listRecurring();
		} catch (e) {
			error = messageForUnknown(e);
		}
		loading = false;
	}
	onMount(load);

	async function run(f: () => Promise<void>, done: string) {
		error = notice = '';
		try {
			await f();
			notice = done;
			await load();
		} catch (e) {
			error = messageForUnknown(e);
		}
	}

	function save(r: RecurringEntry) {
		if (!r.next_run_date || !Number.isInteger(Number(r.interval_count)) || Number(r.interval_count) < 1) {
			error = t('recurring.errorRequired');
			return;
		}
		if (r.end_date && r.end_date < r.next_run_date) {
			error = t('recurring.errorEndBeforeNext');
			return;
		}
		return run(
			() =>
				updateRecurring(r.id, {
					label: r.label,
					frequency: r.frequency,
					interval_count: Number(r.interval_count),
					next_run_date: r.next_run_date,
					end_date: r.end_date || null,
					active: r.active ? 1 : 0
				}),
			t('recurring.saved')
		);
	}

	function remove(r: RecurringEntry) {
		error = notice = '';
		const before = entries;
		deferDelete({
			message: `„${r.label || t(KINDS[r.kind])}“ ${t('recurring.deleted').toLowerCase()}`,
			hide: () => (entries = entries.filter((x) => x.id !== r.id)),
			restore: () => (entries = before),
			run: () => deleteRecurring(r.id),
			onDone: load
		});
	}
</script>

<section class="space-y-4">
	<div class="card p-5">
		<SectionHead eyebrow={t('settingsUi.automationEyebrow')} title={t('recurring.title')} desc={t('recurring.manageHint')} />
	</div>

	{#if loading}
		<div class="card space-y-3 p-5" aria-busy="true">
			<div class="skeleton h-3 w-32"></div>
			<div class="grid gap-3 md:grid-cols-5">
				{#each Array(5) as _}<div class="skeleton h-9 rounded-lg"></div>{/each}
			</div>
		</div>
	{:else if entries.length === 0 && !error}
		<div class="card p-0">
			<EmptyState
				icon="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
				title={t('recurring.empty')}
				hint={t('settingsUi.recurringHint')}
			/>
		</div>
	{:else}
		{#each entries as r (r.id)}
			<div class="card space-y-4 p-5 transition-opacity duration-200 ease-spring {r.active ? '' : 'opacity-70'}">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<span class="badge {r.kind === 'invoice' ? 'badge-blue' : 'badge-amber'}">{t(KINDS[r.kind])}</span>
						{#if !r.active}<span class="badge badge-zinc">{t('settingsUi.paused')}</span>{/if}
					</div>
					<span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{tp('recurring.lastGenerated', { date: day(r.last_run_date) })}</span>
				</div>
				<div class="grid gap-3 md:grid-cols-[1fr_160px_100px_160px_160px]">
					<TextInput bind:value={r.label} label={t('recurring.label')} />
					<div class="flex flex-col gap-1.5">
						<label for="freq-{r.id}" class="label">{t('recurring.frequency')}</label>
						<select id="freq-{r.id}" bind:value={r.frequency} class="input-base input-valid rounded-lg cursor-pointer">
							{#each FREQUENCIES as value}
								<option {value}>{t(`recurring.${value}`)}</option>
							{/each}
						</select>
					</div>
					<div class="flex flex-col gap-1.5">
						<label for="interval-{r.id}" class="label">{t('recurring.every')}</label>
						<input id="interval-{r.id}" type="number" min="1" step="1" bind:value={r.interval_count} class="input-base input-valid rounded-lg tabular-nums" />
					</div>
					<div class="flex flex-col gap-1.5">
						<label for="next-{r.id}" class="label">{t('recurring.nextRun')}</label>
						<input id="next-{r.id}" type="date" bind:value={r.next_run_date} class="input-base input-valid rounded-lg" />
					</div>
					<div class="flex flex-col gap-1.5">
						<label for="end-{r.id}" class="label">{t('recurring.endDate')}</label>
						<input id="end-{r.id}" type="date" bind:value={r.end_date} class="input-base input-valid rounded-lg" />
					</div>
				</div>
				<div class="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-700/70">
					<label class="flex cursor-pointer items-center gap-2 text-sm">
						<input type="checkbox" class="h-4 w-4 accent-accent-600" checked={!!r.active} onchange={(e) => (r.active = e.currentTarget.checked ? 1 : 0)} />
						{t('recurring.statusActive')}
					</label>
					{#if mayEdit(r)}
						<div class="flex gap-2">
							<button type="button" onclick={() => remove(r)} class="btn-secondary text-red-600 dark:text-red-400">{t('common.delete')}</button>
							<button type="button" onclick={() => save(r)} class="btn-primary">{t('common.save')}</button>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	{/if}
	{#if error}<p class="text-xs text-red-600 dark:text-red-400">{error}</p>{/if}
	{#if notice}<p class="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>{/if}
</section>
