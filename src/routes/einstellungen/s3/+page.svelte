<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { getS3Settings, saveS3Settings } from '$lib/db/settings';
	import { testConnection } from '$lib/s3/client';
	import { t } from '$lib/i18n';
	import { messageForUnknown } from '$lib/shared/errors';

	let form = $state({
		enabled: 0,
		endpoint_url: '',
		region: 'eu-central-1',
		bucket_name: '',
		access_key_id: '',
		secret_access_key: '',
		path_prefix: 'rechnungen',
		auto_backup_enabled: 0,
		last_auto_backup_at: null as string | null
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

<section class="card space-y-4">
	<h2 class="text-base font-semibold">{t('settings.s3Title')}</h2>
	<p class="text-sm text-zinc-500 dark:text-zinc-400">
		{t('settings.s3Desc')}
	</p>
	{#if loading}
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.loadingSettings')}</p>
	{:else}
		<label class="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
			<input
				type="checkbox"
				checked={form.enabled === 1}
				onchange={(e) => (form.enabled = e.currentTarget.checked ? 1 : 0)}
				class="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
			/>
			{t('settings.s3Enable')}
		</label>

		{#if credentialWarning}
			<p class="text-xs text-amber-600 dark:text-amber-400">{credentialWarning}</p>
		{/if}

		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={form.endpoint_url} label={t('settings.endpointUrl')} placeholder={t('settings.endpointPlaceholder')} />
			<TextInput bind:value={form.region} label={t('settings.region')} placeholder="eu-central-1" />
			<TextInput bind:value={form.bucket_name} label={t('settings.bucketName')} />
			<TextInput bind:value={form.access_key_id} label={t('settings.accessKey')} />
			<TextInput bind:value={form.secret_access_key} label={t('settings.secretKey')} type="password" />
			<TextInput bind:value={form.path_prefix} label={t('settings.pathPrefix')} placeholder="rechnungen" />
		</div>

		<div class="flex flex-wrap items-center gap-3">
			<button
				type="button"
				onclick={handleSave}
				disabled={saving}
				class="btn-primary"
			>
				{saving ? t('common.saving') : t('common.saveChanges')}
			</button>
			<button
				type="button"
				onclick={handleTestConnection}
				disabled={testing || !form.bucket_name || !form.access_key_id || !form.secret_access_key}
				class="btn-secondary"
			>
				{testing ? t('settings.testing') : t('settings.testConnection')}
			</button>
			{#if feedback}<p class={`text-xs ${saveError ? 'text-red-600' : 'text-emerald-600'}`}>{feedback}</p>{/if}
			{#if testFeedback}
				<p class={`text-xs ${testError ? 'text-red-600' : 'text-emerald-600'}`}>{testFeedback}</p>
			{/if}
		</div>
	{/if}
</section>
