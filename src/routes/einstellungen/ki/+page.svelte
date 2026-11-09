<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { aiConfig, saveAiConfig, hasAiKey, setAiKey, PROVIDERS, type AiProvider } from '$lib/ai';
	import { messageForUnknown } from '$lib/shared/errors';
	import { cloud } from '$lib/cloud';
	import { t } from '$lib/i18n';

	const saved = aiConfig();
	let enabled = $state(saved !== null);
	let provider = $state<AiProvider>(saved?.provider ?? 'anthropic');
	let model = $state(saved?.model ?? PROVIDERS.anthropic.model);
	let baseUrl = $state(saved?.baseUrl ?? PROVIDERS.anthropic.baseUrl);
	let apiKey = $state('');
	let keyStored = $state(false);
	let busy = $state(false);
	let feedback = $state('');

	const info = $derived(PROVIDERS[provider]);

	onMount(async () => {
		try {
			keyStored = await hasAiKey();
		} catch (e) {
			feedback = messageForUnknown(e);
		}
	});

	function changeProvider() {
		model = PROVIDERS[provider].model;
		baseUrl = PROVIDERS[provider].baseUrl;
	}

	async function save() {
		busy = true;
		feedback = '';
		try {
			if (apiKey.trim()) {
				await setAiKey(apiKey);
				apiKey = '';
				keyStored = true;
			}
			saveAiConfig(enabled ? { provider, model: model.trim(), baseUrl: baseUrl.trim() } : null);
			feedback = t('aiSettings.saved');
		} catch (e) {
			feedback = messageForUnknown(e);
		} finally {
			busy = false;
		}
	}

	async function removeKey() {
		busy = true;
		feedback = '';
		try {
			await setAiKey(null);
			keyStored = false;
			feedback = t('aiSettings.keyDeleted');
		} catch (e) {
			feedback = messageForUnknown(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="card space-y-4">
	<div>
		<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">{t('aiSettings.title')}</h2>
		<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
			{t('aiSettings.intro')}
		</p>
		{#if cloud()}
			<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
				{t('aiSettings.cloudNote')}
			</p>
		{/if}
	</div>

	<label class="flex w-fit items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
		<input type="checkbox" bind:checked={enabled} class="h-4 w-4 rounded border-zinc-300" />
		{t('aiSettings.enable')}
	</label>

	<div class="grid gap-3 md:grid-cols-2">
		<div>
			<label class="label" for="ai-provider">{t('aiSettings.provider')}</label>
			<select id="ai-provider" class="input-base w-full" bind:value={provider} onchange={changeProvider}>
				{#each Object.entries(PROVIDERS) as [value, p]}
					<option {value}>{p.label}</option>
				{/each}
			</select>
		</div>
		<TextInput bind:value={model} label={t('aiSettings.model')} placeholder={info.model} />
		{#if info.baseUrl}
			<div class="md:col-span-2">
				<TextInput bind:value={baseUrl} label={t('aiSettings.baseUrl')} placeholder={info.baseUrl} />
			</div>
		{/if}
		{#if info.needsKey}
			<div class="md:col-span-2">
				<label class="label" for="ai-key">{t('aiSettings.apiKey')}</label>
				<input
					id="ai-key"
					type="password"
					autocomplete="off"
					class="input-base w-full"
					bind:value={apiKey}
					placeholder={keyStored ? t('aiSettings.keyStoredPlaceholder') : t('aiSettings.keyPlaceholder')}
				/>
				<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
					{t('aiSettings.keyringNote')}
				</p>
			</div>
		{/if}
	</div>

	<p class="text-xs text-zinc-500 dark:text-zinc-400">
		{t('aiSettings.privacy')}
	</p>

	<div class="flex flex-wrap gap-2">
		<button class="btn-primary" onclick={save} disabled={busy}>{t('common.save')}</button>
		{#if keyStored}
			<button class="btn-secondary" onclick={removeKey} disabled={busy}>{t('aiSettings.deleteKey')}</button>
		{/if}
	</div>
	{#if feedback}<p class="text-sm">{feedback}</p>{/if}
</section>
