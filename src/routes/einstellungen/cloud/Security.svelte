<script lang="ts">
	import { refreshMe } from '$lib/session.svelte';
	import { renderSVG } from 'uqr';
	import TextInput from '../../../common/TextInput.svelte';
	import { api, secondFactor, type Me } from '$lib/cloud';

	let {
		me = $bindable(),
		busy,
		run
	}: { me: Me; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> } = $props();

	let password = $state('');
	let newPassword = $state('');
	let code = $state('');
	let setup = $state<{ secret: string; uri: string } | null>(null);
	let recoveryCodes = $state<string[] | null>(null);
	let notice = $state('');

	const done = async (text: string) => {
		password = newPassword = code = '';
		notice = text;
		me = await refreshMe();
	};

	const changePassword = () =>
		run(async () => {
			await api('/auth/password/change', 'POST', { password, newPassword });
			await done('Passwort geändert. Andere Geräte wurden abgemeldet.');
		});

	const startSetup = () =>
		run(async () => {
			notice = '';
			setup = await api<{ secret: string; uri: string }>('/auth/totp/setup', 'POST', {});
		});

	const enable = () =>
		run(async () => {
			const r = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', 'POST', {
				code: code.trim()
			});
			recoveryCodes = r.recoveryCodes;
			setup = null;
			await done('2FA aktiviert. Andere Geräte wurden abgemeldet.');
		});

	const disable = () =>
		run(async () => {
			await api('/auth/totp/disable', 'POST', { password, ...secondFactor(code) });
			await done('2FA deaktiviert.');
		});
</script>

<div class="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-700">
	<h3 class="text-sm font-semibold">Passwort ändern</h3>
	<div class="grid gap-3 md:grid-cols-2">
		<TextInput bind:value={password} label="Aktuelles Passwort" type="password" />
		<TextInput bind:value={newPassword} label="Neues Passwort (mind. 12 Zeichen)" type="password" />
	</div>
	<button
		class="btn-secondary"
		onclick={changePassword}
		disabled={busy || !password || newPassword.length < 12}
	>
		Passwort ändern
	</button>
</div>

<div class="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-700">
	<h3 class="text-sm font-semibold">Zwei-Faktor-Authentifizierung</h3>

	{#if recoveryCodes}
		<p class="text-sm">
			Wiederherstellungscodes – jetzt sicher aufbewahren, sie werden nur dieses eine Mal angezeigt.
			Jeder Code funktioniert einmal, falls die Authenticator-App fehlt.
		</p>
		<pre class="card select-all font-mono text-sm">{recoveryCodes.join('\n')}</pre>
		<button class="btn-secondary" onclick={() => (recoveryCodes = null)}>
			Ich habe die Codes gespeichert
		</button>
	{:else if me.user.totpEnabled}
		<p class="text-sm">2FA ist aktiv. Zum Deaktivieren Passwort und Code eingeben.</p>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={password} label="Passwort" type="password" />
			<TextInput bind:value={code} label="2FA-Code oder Wiederherstellungscode" />
		</div>
		<button class="btn-secondary" onclick={disable} disabled={busy || !password || !code.trim()}>
			2FA deaktivieren
		</button>
	{:else if setup}
		<p class="text-sm">
			Scanne den QR-Code mit deiner Authenticator-App oder gib den Schlüssel manuell ein.
		</p>
		<div class="w-40">{@html renderSVG(setup.uri)}</div>
		<p class="text-sm">Schlüssel: <code class="select-all">{setup.secret}</code></p>
		<p class="text-xs break-all text-zinc-500 dark:text-zinc-400">
			<code class="select-all">{setup.uri}</code>
		</p>
		<div class="flex flex-wrap items-end gap-3">
			<TextInput bind:value={code} label="Code aus der App" />
			<button class="btn-primary" onclick={enable} disabled={busy || !/^\d{6}$/.test(code.trim())}>
				Aktivieren
			</button>
		</div>
	{:else}
		<p class="text-sm">Schützt dein Konto zusätzlich mit einem Code aus einer Authenticator-App.</p>
		<button class="btn-secondary" onclick={startSetup} disabled={busy}>2FA einrichten</button>
	{/if}
</div>

{#if notice}<p class="text-xs text-green-600 dark:text-green-400">{notice}</p>{/if}
