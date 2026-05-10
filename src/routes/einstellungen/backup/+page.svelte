<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import FileUpload from '../../../common/FileUpload.svelte';
	import { getS3Settings, saveS3Settings, type UpsertS3Settings } from '$lib/db/settings';
	import { performBackup } from '$lib/s3/auto-backup';
	import { t } from '$lib/i18n';

	type BackupPayload = { file_name: string; bytes: number[] };

	let files = $state<FileList | null>(null);
	let loading = $state(false);
	let feedback = $state('');

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

	onMount(async () => {
		s3 = await getS3Settings();
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

	function downloadFile(fileName: string, bytes: number[]) {
		const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(link.href);
	}

	async function handleBackupDownload() {
		loading = true;
		feedback = '';
		const payload = await invoke<BackupPayload>('backup_database');
		downloadFile(payload.file_name, payload.bytes);
		feedback = t('settings.backupDownloaded');
		loading = false;
	}

	async function handleRestore() {
		if (!files?.[0]) {
			feedback = t('settings.selectFile');
			return;
		}
		if (!confirm(t('settings.restoreConfirm'))) return;
		loading = true;
		feedback = '';
		try {
			const bytes = new Uint8Array(await files[0].arrayBuffer());
			await invoke('restore_database', { bytes: Array.from(bytes) });
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
		gobdLoading = true;
		try {
			const payload = await invoke<BackupPayload>('export_gobd', {
				fromYear: gobdFromYear,
				toYear: gobdToYear
			});
			downloadFile(payload.file_name, payload.bytes);
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

<div class="space-y-6">
	<section class="card space-y-4">
		<h2 class="text-base font-semibold">{t('settings.backupTitle')}</h2>
		<p class="text-sm text-zinc-500 dark:text-zinc-400">
			{t('settings.backupDesc')}
		</p>
		<div class="flex flex-wrap gap-3">
			<button
				type="button"
				onclick={handleBackupDownload}
				disabled={loading}
				class="btn-primary"
			>
				{t('settings.downloadDb')}
			</button>
		</div>
		<FileUpload bind:files label={t('settings.uploadBackup')} accept=".db,.sqlite,.sqlite3" />
		<button type="button" onclick={handleRestore} disabled={loading} class="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
			{t('settings.restore')}
		</button>
		{#if feedback}<p class="text-xs text-emerald-600">{feedback}</p>{/if}
	</section>

	<section class="card space-y-4">
		<h2 class="text-base font-semibold">{t('settings.gobdTitle')}</h2>
		<p class="text-sm text-zinc-500 dark:text-zinc-400">
			{t('settings.gobdDesc')}
		</p>
		<div class="flex flex-wrap items-end gap-3">
			<label class="flex flex-col gap-1 text-sm">
				<span class="font-medium">{t('settings.gobdFromYear')}</span>
				<input
					type="number"
					bind:value={gobdFromYear}
					min="2000"
					max="2100"
					step="1"
					class="input-base w-28"
				/>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span class="font-medium">{t('settings.gobdToYear')}</span>
				<input
					type="number"
					bind:value={gobdToYear}
					min="2000"
					max="2100"
					step="1"
					class="input-base w-28"
				/>
			</label>
			<button
				type="button"
				onclick={handleGobdExport}
				disabled={gobdLoading}
				class="btn-primary"
			>
				{gobdLoading ? t('settings.gobdExporting') : t('settings.gobdExport')}
			</button>
		</div>
		{#if gobdFeedback}
			<p class="text-xs {gobdFeedback.startsWith('Fehler') || gobdFeedback.startsWith('Error') || gobdFeedback === t('settings.gobdInvalidRange') ? 'text-red-600' : 'text-emerald-600'}">{gobdFeedback}</p>
		{/if}
	</section>

	<section class="card space-y-4">
		<h2 class="text-base font-semibold">{t('settings.autoBackup')}</h2>
		{#if s3 && s3.enabled}
			<p class="text-sm text-zinc-500 dark:text-zinc-400">
				{t('settings.autoBackupDesc')}
			</p>
			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					checked={!!s3.auto_backup_enabled}
					onchange={toggleAutoBackup}
					class="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
				/>
				<span class="text-sm font-medium">{t('settings.dailyBackup')}</span>
			</label>
			<p class="text-xs text-zinc-500 dark:text-zinc-400">
				{#if lastBackupFormatted}
					{t('settings.lastBackup')}: {lastBackupFormatted} Uhr
				{:else}
					{t('settings.noBackupYet')}
				{/if}
			</p>
			<button
				type="button"
				onclick={handleS3Backup}
				disabled={s3BackupLoading}
				class="btn-primary"
			>
				{s3BackupLoading ? t('settings.backingUp') : t('settings.backupNow')}
			</button>
			{#if s3Feedback}
				<p class="text-xs {s3Feedback.startsWith('Fehler') ? 'text-red-600' : 'text-emerald-600'}">{s3Feedback}</p>
			{/if}
		{:else}
			<p class="text-sm text-zinc-500 dark:text-zinc-400">
				<a href="/einstellungen/s3" class="text-blue-600 hover:underline">{t('settings.enableS3')}</a>{t('settings.enableS3Hint')}
			</p>
		{/if}
	</section>
</div>
