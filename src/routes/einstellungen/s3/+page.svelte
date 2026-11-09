<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { getS3Settings, saveS3Settings } from '$lib/db/settings';
	import type { AutoBackupStatus } from '$lib/db/types';
	import { testConnection } from '$lib/s3/client';
	import { t } from '$lib/i18n';
	import { messageForUnknown } from '$lib/shared/errors';
	import SectionHead from '../SectionHead.svelte';
	import SaveBar from '../SaveBar.svelte';
	import FormSkeleton from '../FormSkeleton.svelte';

	let form = $state({
		enabled: 0,
		endpoint_url: '',
		region: 'eu-central-1',
		bucket_name: '',
		access_key_id: '',
		secret_access_key: '',
		path_prefix: 'rechnungen',
		auto_backup_enabled: 0,
		last_auto_backup_at: null as string | null,
		last_auto_backup_status: null as AutoBackupStatus | null,
		last_auto_backup_error: null as string | null
	});
	let loading = $state(true);
	let saving = $state(false);
	let testing = $state(false);
	let feedback = $state('');
	let saveError = $state(false);
	let testFeedback = $state('');
	let testError = $state(false);
	let credentialWarning = $state('');

	onMount(async () => {
		const data = await getS3Settings();
		form = { ...data };
		if (data.enabled === 1 && !data.access_key_id && !data.secret_access_key) {
			credentialWarning = t('settings.credentialWarning');
		}
		loading = false;
	});

	async function handleSave() {
		saving = true;
		feedback = '';
		saveError = false;
		try {
			await saveS3Settings(form);
			feedback = t('settings.s3Saved');
			credentialWarning = '';
		} catch (err) {
			saveError = true;
			feedback = `${t('settings.s3SaveError')}: ${messageForUnknown(err)}`;
		} finally {
			saving = false;
		}
	}

	async function handleTestConnection() {
		testing = true;
		testFeedback = '';
		testError = false;
		try {
			await testConnection(form);
			testFeedback = t('settings.connectionSuccess');
		} catch (err) {
			testError = true;
			testFeedback = `${t('settings.connectionFailed')}: ${messageForUnknown(err)}`;
		} finally {
			testing = false;
		}
	}
</script>

{#snippet note(text: string, failed: boolean)}
	<p class="flex items-center gap-1.5 text-xs {failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}">
		<span class="h-1.5 w-1.5 shrink-0 rounded-full {failed ? 'bg-red-500' : 'bg-emerald-500'}"></span>{text}
	</p>
{/snippet}

<section class="card space-y-5 p-5">
	{#if loading}
		<FormSkeleton fields={6} />
	{:else}
		<div class="flex flex-wrap items-start justify-between gap-4">
			<SectionHead eyebrow={t('settingsUi.storageEyebrow')} title={t('settings.s3Title')} desc={t('settings.s3Desc')} />
			<label class="flex cursor-pointer items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
				<input
					type="checkbox"
					checked={form.enabled === 1}
					onchange={(e) => (form.enabled = e.currentTarget.checked ? 1 : 0)}
					class="h-4 w-4 rounded border-zinc-300 accent-accent-600"
				/>
				{t('settings.s3Enable')}
			</label>
		</div>

		{#if credentialWarning}
			<p class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20">{credentialWarning}</p>
		{/if}

		<div class="grid gap-3 transition-opacity duration-200 ease-spring md:grid-cols-2 {form.enabled === 1 ? '' : 'opacity-60'}">
			<TextInput bind:value={form.endpoint_url} label={t('settings.endpointUrl')} placeholder={t('settings.endpointPlaceholder')} />
			<TextInput bind:value={form.region} label={t('settings.region')} placeholder="eu-central-1" />
			<TextInput bind:value={form.bucket_name} label={t('settings.bucketName')} />
			<TextInput bind:value={form.path_prefix} label={t('settings.pathPrefix')} placeholder="rechnungen" />
			<TextInput bind:value={form.access_key_id} label={t('settings.accessKey')} />
			<TextInput bind:value={form.secret_access_key} label={t('settings.secretKey')} type="password" />
		</div>

		<SaveBar {saving} onsave={handleSave}>
			<button
				type="button"
				onclick={handleTestConnection}
				disabled={testing || !form.bucket_name || !form.access_key_id || !form.secret_access_key}
				class="btn-secondary"
			>
				{testing ? t('settings.testing') : t('settings.testConnection')}
			</button>
		</SaveBar>
		{#if feedback}{@render note(feedback, saveError)}{/if}
		{#if testFeedback}{@render note(testFeedback, testError)}{/if}
	{/if}
</section>
