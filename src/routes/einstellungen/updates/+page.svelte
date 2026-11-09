<script lang="ts">
	import { check, type Update } from '@tauri-apps/plugin-updater';
	import { relaunch } from '@tauri-apps/plugin-process';
	import SectionHead from '../SectionHead.svelte';
	import { t, tp } from '$lib/i18n';

	let update = $state<Update | null>(null);
	let busy = $state(false);
	let feedback = $state('');

	async function checkForUpdate() {
		busy = true;
		feedback = '';
		try {
			update = await check();
			if (!update) feedback = t('updatesSettings.upToDate');
		} catch (e) {
			feedback = tp('updatesSettings.checkFailed', { error: String(e) });
		} finally {
			busy = false;
		}
	}

	async function install() {
		if (!update) return;
		busy = true;
		feedback = t('updatesSettings.downloading');
		try {
			await update.downloadAndInstall();
			await relaunch();
		} catch (e) {
			feedback = tp('updatesSettings.installFailed', { error: String(e) });
			busy = false;
		}
	}
</script>

<section class="card space-y-4 p-5">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<SectionHead eyebrow={t('updatesSettings.eyebrow')} title={t('updatesSettings.title')} desc={t('updatesSettings.desc')} />
		<button class="btn-secondary" onclick={checkForUpdate} disabled={busy}>
			{#if busy && !update}
				<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
			{/if}
			{t('updatesSettings.check')}
		</button>
	</div>
	{#if update}
		<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent-50 p-4 ring-1 ring-accent-600/10 animate-pop dark:bg-accent-900/20 dark:ring-accent-400/20">
			<p class="text-sm text-accent-900 dark:text-accent-100">{t('updatesSettings.availableLead')} <span class="font-mono font-medium">{update.version}</span> {t('updatesSettings.availableRest')}</p>
			<button class="btn-primary" onclick={install} disabled={busy}>{t('updatesSettings.install')}</button>
		</div>
	{/if}
	{#if feedback}<p class="text-sm text-zinc-600 dark:text-zinc-300">{feedback}</p>{/if}
</section>
