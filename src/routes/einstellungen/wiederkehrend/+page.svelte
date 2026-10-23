<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { deleteRecurring, listRecurring, updateRecurring } from '$lib/db/recurring';
	import type { RecurringEntry } from '$lib/db/types';
	import { messageForUnknown } from '$lib/shared/errors';
	import { getLocaleFormatting, t, tp } from '$lib/i18n';

	// Schedules are created from an invoice / incoming invoice ("monatlich");
	// here they are listed, edited, paused and deleted.
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
		if (!confirm(tp('recurring.deleteNamedConfirm', { name: r.label || t(KINDS[r.kind]) }))) return;
		return run(() => deleteRecurring(r.id), t('recurring.deleted'));
	}
</script>

<section class="card space-y-4">
	<div>
		<h2 class="text-base font-semibold">{t('recurring.title')}</h2>
		<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
			{t('recurring.manageHint')}
		</p>
	</div>

	{#if loading}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('common.loading')}</p>
	{:else if entries.length === 0 && !error}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('recurring.empty')}</p>
	{:else}
		<div class="space-y-3">
			{#each entries as r (r.id)}
				<div class="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
					<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
						<span class="font-medium text-zinc-700 dark:text-zinc-200">{t(KINDS[r.kind])}</span>
						<span>{tp('recurring.lastGenerated', { date: day(r.last_run_date) })}</span>
					</div>
					<div class="grid gap-3 md:grid-cols-[1fr_160px_100px_160px_160px]">
						<TextInput bind:value={r.label} label={t('recurring.label')} />
						<div class="mt-1 flex flex-col gap-1">
							<label for="freq-{r.id}" class="label">{t('recurring.frequency')}</label>
							<select id="freq-{r.id}" bind:value={r.frequency} class="input-base">
								{#each FREQUENCIES as value}
									<option {value}>{t(`recurring.${value}`)}</option>
								{/each}
							</select>
						</div>
						<div class="mt-1 flex flex-col gap-1">
							<label for="interval-{r.id}" class="label">{t('recurring.every')}</label>
							<input id="interval-{r.id}" type="number" min="1" step="1" bind:value={r.interval_count} class="input-base" />
						</div>
						<div class="mt-1 flex flex-col gap-1">
							<label for="next-{r.id}" class="label">{t('recurring.nextRun')}</label>
							<input id="next-{r.id}" type="date" bind:value={r.next_run_date} class="input-base" />
						</div>
						<div class="mt-1 flex flex-col gap-1">
							<label for="end-{r.id}" class="label">{t('recurring.endDate')}</label>
							<input id="end-{r.id}" type="date" bind:value={r.end_date} class="input-base" />
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-3">
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={!!r.active} onchange={(e) => (r.active = e.currentTarget.checked ? 1 : 0)} />
							{t('recurring.statusActive')}
						</label>
						<button type="button" onclick={() => save(r)} class="btn-primary">{t('common.save')}</button>
						<button type="button" onclick={() => remove(r)} class="btn-secondary">{t('common.delete')}</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
	{#if error}<p class="text-xs text-red-600">{error}</p>{/if}
	{#if notice}<p class="text-xs text-emerald-600">{notice}</p>{/if}
</section>
