<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { open, save } from '@tauri-apps/plugin-dialog';
	import { getS3Settings, saveS3Settings, type UpsertS3Settings } from '$lib/db/settings';
	import { performBackup } from '$lib/s3/auto-backup';
	import { t } from '$lib/i18n';
	import { cloud } from '$lib/cloud';
	import { saveCloudExport } from '$lib/cloud-export';
	import Dialog from '../../../common/Dialog.svelte';
	import SectionHead from '../SectionHead.svelte';

	const SQLITE_FILTERS = [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }];

	let loading = $state(false);
	let feedback = $state('');
	let pendingRestore = $state<string | null>(null);

	let s3 = $state<UpsertS3Settings | null>(null);
	let s3BackupLoading = $state(false);
	let s3Feedback = $state('');

	// COMP-1.b: GoBD-Export. Default the year range to the previous calendar
	// year (the typical Betriebsprüfung target). Operators can widen the
	// range to cover multiple fiscal years in a single archive.
	const currentYear = new Date().getFullYear();
	let gobdFromYear = $state<number>(currentYear - 1);
	let gobdToYear = $state<number>(currentYear - 1);
	let gobdLoading = $state(false);
	let gobdFeedback = $state('');

	let cloudExportLoading = $state(false);
	let cloudExportFeedback = $state('');
	let cloudExportFailed = $state(false);

	async function handleCloudExport() {
		cloudExportFeedback = '';
		const dir = await open({ directory: true });
		if (typeof dir !== 'string') return;
		cloudExportLoading = true;
		try {
			const n = await saveCloudExport(dir);
			cloudExportFeedback = t('settings.cloudExported').replace('{n}', String(n));
			cloudExportFailed = false;
		} catch (e) {
			cloudExportFeedback = `${t('common.error')}: ${e instanceof Error ? e.message : e}`;
			cloudExportFailed = true;
		}
		cloudExportLoading = false;
	}

	onMount(async () => {
		if (!cloud()) s3 = await getS3Settings();
	});

	let lastBackupFormatted = $derived(
		s3?.last_auto_backup_at
			? new Date(s3.last_auto_backup_at).toLocaleString('de-DE', {
					day: '2-digit',
					month: '2-digit',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				})
			: null
	);

	// Path-based flows: the DB is copied by the backend, so its bytes never
	// cross the IPC boundary or get buffered in the webview.
	async function handleBackupDownload() {
		feedback = '';
		const targetPath = await save({ defaultPath: 'bookie.db', filters: SQLITE_FILTERS });
		if (!targetPath) return;
		loading = true;
		try {
			await invoke('backup_database', { targetPath });
			feedback = t('settings.backupDownloaded');
		} catch (e) {
			feedback = `${t('common.error')}: ${e}`;
		}
		loading = false;
	}

	async function handleRestore() {
		feedback = '';
		const sourcePath = await open({ multiple: false, filters: SQLITE_FILTERS });
		if (!sourcePath) return;
		// Overwrites the live DB: confirm in a dialog (irreversible, no undo).
		pendingRestore = sourcePath;
	}

	async function confirmRestore() {
		const sourcePath = pendingRestore;
		pendingRestore = null;
		if (!sourcePath) return;
		loading = true;
		try {
			await invoke('restore_database', { sourcePath });
			feedback = t('settings.restoreSuccess');
		} catch (e) {
			feedback = `${t('common.error')}: ${e}`;
		}
		loading = false;
	}

	async function toggleAutoBackup() {
		if (!s3) return;
		s3.auto_backup_enabled = s3.auto_backup_enabled ? 0 : 1;
		await saveS3Settings(s3);
	}

	async function handleGobdExport() {
		gobdFeedback = '';
		if (!Number.isInteger(gobdFromYear) || !Number.isInteger(gobdToYear) || gobdFromYear > gobdToYear) {
			gobdFeedback = t('settings.gobdInvalidRange');
			return;
		}
		const targetPath = await save({
			defaultPath: `gobd-export-${gobdFromYear}-${gobdToYear}.zip`,
			filters: [{ name: 'ZIP', extensions: ['zip'] }]
		});
		if (!targetPath) return;
		gobdLoading = true;
		try {
			await invoke('export_gobd', {
				fromYear: gobdFromYear,
				toYear: gobdToYear,
				targetPath
			});
			gobdFeedback = t('settings.gobdExported');
		} catch (e) {
			gobdFeedback = `${t('common.error')}: ${e}`;
		}
		gobdLoading = false;
	}

	async function handleS3Backup() {
		if (!s3) return;
		s3BackupLoading = true;
		s3Feedback = '';
		try {
			await performBackup(s3);
			s3 = await getS3Settings();
			s3Feedback = t('settings.backupSuccess');
		} catch (e) {
			s3Feedback = `${t('common.error')}: ${e}`;
		}
		s3BackupLoading = false;
	}
</script>

{#snippet note(text: string, failed: boolean)}
	<p class="flex items-center gap-1.5 text-xs {failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}">
		<span class="h-1.5 w-1.5 rounded-full {failed ? 'bg-red-500' : 'bg-emerald-500'}"></span>{text}
	</p>
{/snippet}

<div class="space-y-6">
	<!-- Cloud mode: local backup, GoBD and S3 act on the local SQLite file (getDb refuses); only the export applies. -->
	{#if cloud()}
		<section class="card space-y-4 p-5">
			<SectionHead eyebrow="Cloud" title={t('settings.cloudExportTitle')} desc={t('settings.cloudExportDesc')} />
			<button type="button" onclick={handleCloudExport} disabled={cloudExportLoading} class="btn-primary">
				{cloudExportLoading ? t('settings.gobdExporting') : t('settings.cloudExport')}
			</button>
			{#if cloudExportFeedback}{@render note(cloudExportFeedback, cloudExportFailed)}{/if}
		</section>
	{:else}
	<section class="card space-y-4 p-5">
		<SectionHead eyebrow="Lokal" title={t('settings.backupTitle')} desc={t('settings.backupDesc')} />
		<div class="flex flex-wrap gap-2">
			<button type="button" onclick={handleBackupDownload} disabled={loading} class="btn-primary">
				{t('settings.downloadDb')}
			</button>
			<button type="button" onclick={handleRestore} disabled={loading} class="btn-secondary">
				{t('settings.restore')}
			</button>
		</div>
		{#if feedback}{@render note(feedback, feedback.startsWith(t('common.error')))}{/if}
	</section>

	<section class="card space-y-4 p-5">
		<SectionHead eyebrow="Betriebsprüfung" title={t('settings.gobdTitle')} desc={t('settings.gobdDesc')} />
		<div class="flex flex-wrap items-end gap-3">
			<label class="flex flex-col gap-1.5">
				<span class="label">{t('settings.gobdFromYear')}</span>
				<input type="number" bind:value={gobdFromYear} min="2000" max="2100" step="1" class="input-base input-valid w-28 rounded-lg tabular-nums" />
			</label>
			<label class="flex flex-col gap-1.5">
				<span class="label">{t('settings.gobdToYear')}</span>
				<input type="number" bind:value={gobdToYear} min="2000" max="2100" step="1" class="input-base input-valid w-28 rounded-lg tabular-nums" />
			</label>
			<button type="button" onclick={handleGobdExport} disabled={gobdLoading} class="btn-primary">
				{gobdLoading ? t('settings.gobdExporting') : t('settings.gobdExport')}
			</button>
		</div>
		{#if gobdFeedback}
			{@render note(gobdFeedback, gobdFeedback.startsWith('Fehler') || gobdFeedback.startsWith('Error') || gobdFeedback === t('settings.gobdInvalidRange'))}
		{/if}
	</section>

	<section class="card space-y-4 p-5">
		<SectionHead eyebrow="S3" title={t('settings.autoBackup')} desc={s3 && s3.enabled ? t('settings.autoBackupDesc') : undefined} />
		{#if s3 && s3.enabled}
			<label class="flex w-fit cursor-pointer items-center gap-3">
				<input
					type="checkbox"
					checked={!!s3.auto_backup_enabled}
					onchange={toggleAutoBackup}
					class="h-4 w-4 rounded border-zinc-300 accent-accent-600"
				/>
				<span class="text-sm font-medium">{t('settings.dailyBackup')}</span>
			</label>
			<p class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
				{#if lastBackupFormatted}
					{t('settings.lastBackup')}: {lastBackupFormatted} Uhr
				{:else}
					{t('settings.noBackupYet')}
				{/if}
			</p>
			<button type="button" onclick={handleS3Backup} disabled={s3BackupLoading} class="btn-primary">
				{s3BackupLoading ? t('settings.backingUp') : t('settings.backupNow')}
			</button>
			{#if s3Feedback}{@render note(s3Feedback, s3Feedback.startsWith('Fehler'))}{/if}
		{:else if s3}
			<p class="text-sm text-zinc-500 dark:text-zinc-400">
				<a href="/einstellungen/s3" class="font-medium text-accent-600 hover:underline dark:text-accent-400">{t('settings.enableS3')}</a>{t('settings.enableS3Hint')}
			</p>
		{:else}
			<div class="skeleton h-4 w-2/3"></div>
		{/if}
	</section>
	{/if}
</div>

<Dialog open={pendingRestore !== null} title={t('settings.restore')} size="sm" onclose={() => (pendingRestore = null)}>
	<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.restoreConfirm')}</p>
	<p class="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{pendingRestore}</p>
	{#snippet footer()}
		<button type="button" class="btn-secondary" onclick={() => (pendingRestore = null)}>{t('common.cancel')}</button>
		<button type="button" class="btn-danger" onclick={confirmRestore}>{t('settings.restore')}</button>
	{/snippet}
</Dialog>
