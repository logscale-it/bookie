<script lang="ts">
	import { onMount } from 'svelte';
	import TextInput from '../../../common/TextInput.svelte';
	import { aiConfig, saveAiConfig, hasAiKey, setAiKey, PROVIDERS, type AiProvider } from '$lib/ai';
	import { messageForUnknown } from '$lib/shared/errors';

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
			feedback = 'Gespeichert.';
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
			feedback = 'API-Key gelöscht.';
		} catch (e) {
			feedback = messageForUnknown(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="card space-y-4">
	<div>
		<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">KI-Belegerfassung</h2>
		<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
			Beim Hochladen einer Eingangsrechnung (PDF oder Bild) liest die KI Lieferant, Rechnungsnummer, Datum,
			Netto und MwSt. aus und füllt das Formular vor. Gespeichert wird erst nach deiner Prüfung.
		</p>
	</div>

	<label class="flex w-fit items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
		<input type="checkbox" bind:checked={enabled} class="h-4 w-4 rounded border-zinc-300" />
		KI-Erfassung aktivieren
	</label>

	<div class="grid gap-3 md:grid-cols-2">
		<div>
			<label class="label" for="ai-provider">Anbieter</label>
			<select id="ai-provider" class="input-base w-full" bind:value={provider} onchange={changeProvider}>
				{#each Object.entries(PROVIDERS) as [value, p]}
					<option {value}>{p.label}</option>
				{/each}
			</select>
		</div>
		<TextInput bind:value={model} label="Modell" placeholder={info.model} />
		{#if info.baseUrl}
			<div class="md:col-span-2">
				<TextInput bind:value={baseUrl} label="API-Basis-URL" placeholder={info.baseUrl} />
			</div>
		{/if}
		{#if info.needsKey}
			<div class="md:col-span-2">
				<label class="label" for="ai-key">API-Key</label>
				<input
					id="ai-key"
					type="password"
					autocomplete="off"
					class="input-base w-full"
					bind:value={apiKey}
					placeholder={keyStored ? '•••••••• (hinterlegt – leer lassen zum Behalten)' : 'API-Key einfügen'}
				/>
				<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
					Wird im Schlüsselbund des Betriebssystems gespeichert, nicht in der Datenbank.
				</p>
			</div>
		{/if}
	</div>

	<p class="text-xs text-zinc-500 dark:text-zinc-400">
		Datenschutz: Belege werden an den gewählten Anbieter übertragen. Für personenbezogene Daten ggf. einen
		Auftragsverarbeitungsvertrag (AVV) mit dem Anbieter abschließen. Mit Ollama bleiben die Daten auf deinem Server.
	</p>

	<div class="flex flex-wrap gap-2">
		<button class="btn-primary" onclick={save} disabled={busy}>Speichern</button>
		{#if keyStored}
			<button class="btn-secondary" onclick={removeKey} disabled={busy}>API-Key löschen</button>
		{/if}
	</div>
	{#if feedback}<p class="text-sm">{feedback}</p>{/if}
</section>
