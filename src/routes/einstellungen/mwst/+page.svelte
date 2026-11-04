<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import SkeletonRows from '../../../common/SkeletonRows.svelte';
	import EmptyState from '../../../common/EmptyState.svelte';
	import SectionHead from '../SectionHead.svelte';
	import { createVatTax, deleteVatTax, listVatTaxes, updateVatTax } from '$lib/db/settings';
	import type { VatTax } from '$lib/db/types';
	import { t } from '$lib/i18n';
	import { toasts } from '$lib/ui/toasts.svelte';
	import { can } from '$lib/session.svelte';

	// settings:edit creates/changes rates; view-only reads them.
	const canEdit = can('settings', 'edit');
	import { deferDelete } from '$lib/ui/undo';

	let taxes = $state<VatTax[]>([]);
	let loading = $state(true);
	let form = $state({ name: '', description: '', goods_value_percent: '19' });

	async function loadTaxes() {
		taxes = await listVatTaxes();
		loading = false;
	}

	onMount(loadTaxes);

	async function createTax() {
		await createVatTax({
			name: form.name,
			description: form.description,
			goods_value_percent: Number(form.goods_value_percent) || 0
		});
		form = { name: '', description: '', goods_value_percent: '19' };
		toasts.success(t('settings.vatSaved'));
		await loadTaxes();
	}

	async function saveTax(tax: VatTax) {
		await updateVatTax(tax.id, tax);
		toasts.success(t('settings.vatSaved'));
	}

	function removeTax(tax: VatTax) {
		const before = taxes;
		deferDelete({
			message: t('settings.vatDeleted'),
			hide: () => (taxes = taxes.filter((x) => x.id !== tax.id)),
			restore: () => (taxes = before),
			run: () => deleteVatTax(tax.id),
			onDone: loadTaxes
		});
	}
</script>

<div class="space-y-6">
	{#if canEdit}
	<section class="card space-y-4 p-5">
		<SectionHead eyebrow="Neuer Satz" title={t('settings.vatTitle')} desc="Steuersätze, die du in Rechnungspositionen auswählen kannst." />
		<div class="grid gap-3 md:grid-cols-[1fr_1fr_160px]">
			<TextInput bind:value={form.name} label={t('settings.vatName')} placeholder="USt. 19 %" />
			<TextInput bind:value={form.description} label={t('settings.vatDescription')} />
			<TextInput bind:value={form.goods_value_percent} label={t('settings.vatPercent')} type="number" />
		</div>
		<button type="button" onclick={createTax} class="btn-primary" disabled={!form.name.trim()}>
			{t('settings.vatSave')}
		</button>
	</section>
	{/if}

	<div class="table-card">
		{#if loading}
			<SkeletonRows rows={3} cols={4} />
		{:else if taxes.length === 0}
			<EmptyState
				icon="M9 14.25l6-6m4.5-3.493V21.75l-3.75-1.5-3.75 1.5-3.75-1.5-3.75 1.5V4.757c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0c1.1.128 1.907 1.077 1.907 2.185zM9.75 9h.008v.008H9.75V9zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 4.5h.008v.008h-.008V13.5zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
				title={t('settings.vatEmpty')}
			/>
		{:else}
			<div class="table-head grid-cols-[1fr_1fr_140px_88px]">
				<div class="px-4 py-2.5">{t('settings.vatName')}</div>
				<div class="px-4 py-2.5">{t('settings.vatDescription')}</div>
				<div class="px-4 py-2.5 text-right">{t('settings.vatPercent')}</div>
				<div class="px-4 py-2.5"></div>
			</div>
			{#each taxes as tax (tax.id)}
				<div class="data-row group grid-cols-[1fr_1fr_140px_88px]">
					<div class="px-2 py-1.5">
						<input aria-label={t('settings.vatName')} readonly={!canEdit} bind:value={tax.name} class="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 outline-none transition duration-200 ease-spring hover:border-zinc-900/10 focus:border-accent-500 focus:ring-4 focus:ring-accent-500/15 dark:hover:border-white/10" />
					</div>
					<div class="px-2 py-1.5">
						<input aria-label={t('settings.vatDescription')} readonly={!canEdit} bind:value={tax.description} class="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-zinc-500 outline-none transition duration-200 ease-spring hover:border-zinc-900/10 focus:border-accent-500 focus:ring-4 focus:ring-accent-500/15 dark:text-zinc-400 dark:hover:border-white/10" />
					</div>
					<div class="px-2 py-1.5">
						<input id="tax-percent-{tax.id}" aria-label={t('settings.vatPercent')} readonly={!canEdit} bind:value={tax.goods_value_percent} type="number" class="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-right tabular-nums outline-none transition duration-200 ease-spring hover:border-zinc-900/10 focus:border-accent-500 focus:ring-4 focus:ring-accent-500/15 dark:hover:border-white/10" />
					</div>
					<div class="row-actions px-3 py-1.5">
						{#if canEdit}
						<button type="button" onclick={() => saveTax(tax)} class="icon-btn icon-btn-blue" title={t('common.save')} aria-label={t('common.save')}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
						</button>
						<button type="button" onclick={() => removeTax(tax)} class="icon-btn icon-btn-danger" title={t('common.delete')} aria-label={t('common.delete')}>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.16-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.04-2.09 1.02-2.09 2.2v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
						</button>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
