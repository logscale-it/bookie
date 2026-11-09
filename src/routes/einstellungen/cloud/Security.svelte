<script lang="ts">
	import { refreshMe } from '$lib/session.svelte';
	import { renderSVG } from 'uqr';
	import TextInput from '../../../common/TextInput.svelte';
	import { api, secondFactor, type Me } from '$lib/cloud';
	import { t } from '$lib/i18n';

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
			await done(t('security.passwordChanged'));
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
			await done(t('security.totpEnabled'));
		});

	const disable = () =>
		run(async () => {
			await api('/auth/totp/disable', 'POST', { password, ...secondFactor(code) });
			await done(t('security.totpDisabled'));
		});
</script>

<div class="space-y-3 border-t border-zinc-100 pt-5 dark:border-zinc-700/70">
	<h3 class="text-sm font-semibold tracking-tight">{t('security.changePassword')}</h3>
	<div class="grid gap-3 md:grid-cols-2">
		<TextInput bind:value={password} label={t('security.currentPassword')} type="password" />
		<TextInput bind:value={newPassword} label={t('security.newPassword')} type="password" />
	</div>
	<button
		class="btn-secondary"
		onclick={changePassword}
		disabled={busy || !password || newPassword.length < 12}
	>
		{t('security.changePassword')}
	</button>
</div>

<div class="space-y-3 border-t border-zinc-100 pt-5 dark:border-zinc-700/70">
	<h3 class="text-sm font-semibold tracking-tight">{t('security.totpTitle')}</h3>

	{#if recoveryCodes}
		<p class="text-sm text-zinc-600 dark:text-zinc-300">
			{t('security.recoveryCodesNote')}
		</p>
		<pre class="select-all rounded-xl bg-zinc-50 p-4 text-sm leading-relaxed tabular-nums ring-1 ring-zinc-900/5 dark:bg-zinc-900/60 dark:ring-white/10">{recoveryCodes.join('\n')}</pre>
		<button class="btn-secondary" onclick={() => (recoveryCodes = null)}>
			{t('security.codesSaved')}
		</button>
	{:else if me.user.totpEnabled}
		<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('security.totpActive')}</p>
		<div class="grid gap-3 md:grid-cols-2">
			<TextInput bind:value={password} label={t('security.password')} type="password" />
			<TextInput bind:value={code} label={t('security.codeOrRecovery')} />
		</div>
		<button class="btn-secondary" onclick={disable} disabled={busy || !password || !code.trim()}>
			{t('security.disableTotp')}
		</button>
	{:else if setup}
		<p class="text-sm text-zinc-600 dark:text-zinc-300">
			{t('security.scanQr')}
		</p>
		<div class="w-40 rounded-xl bg-white p-2 ring-1 ring-zinc-900/10">{@html renderSVG(setup.uri)}</div>
		<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('security.key')} <code class="select-all rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">{setup.secret}</code></p>
		<p class="text-xs break-all text-zinc-500 dark:text-zinc-400">
			<code class="select-all">{setup.uri}</code>
		</p>
		<div class="flex flex-wrap items-end gap-3">
			<TextInput bind:value={code} label={t('security.appCode')} />
			<button class="btn-primary" onclick={enable} disabled={busy || !/^\d{6}$/.test(code.trim())}>
				{t('security.activate')}
			</button>
		</div>
	{:else}
		<p class="text-sm text-zinc-600 dark:text-zinc-300">{t('security.totpPitch')}</p>
		<button class="btn-secondary" onclick={startSetup} disabled={busy}>{t('security.setupTotp')}</button>
	{/if}
</div>

{#if notice}<p class="animate-pop text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>{/if}
