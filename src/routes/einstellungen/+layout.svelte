<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import { cloud } from '$lib/cloud';
	import { can } from '$lib/session.svelte';

	let { children }: { children: Snippet } = $props();

	// Cloud: pills follow the caller's grants (the server enforces them anyway).
	const navItems = [
		...(can('settings') ? [
			{ get label() { return t('settings.organisation'); }, href: '/einstellungen/organisation' },
			{ get label() { return t('settings.invoice'); }, href: '/einstellungen/rechnung' },
			{ get label() { return t('settings.vatTaxes'); }, href: '/einstellungen/mwst' }
		] : []),
		...(can('recurring') ? [{ get label() { return t('settings.recurring'); }, href: '/einstellungen/wiederkehrend' }] : []),
		// Backup/S3 act on the local SQLite file, which cloud mode does not use (getDb refuses).
		...(cloud() ? [] : [
			{ get label() { return t('settings.backup'); }, href: '/einstellungen/backup' },
			{ get label() { return t('settings.s3Storage'); }, href: '/einstellungen/s3' }
		]),
		{ get label() { return t('settings.diagnose'); }, href: '/einstellungen/diagnose' },
		{ label: cloud() ? 'Konto & Abo' : 'Cloud', href: '/einstellungen/cloud' },
		...(cloud() ? [{ label: 'Team', href: '/einstellungen/team' }] : [])
	];
</script>

<div class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold tracking-tight">{t('settings.title')}</h1>
		<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('settings.subtitle')}</p>
	</header>

	<nav class="flex flex-wrap gap-2">
		{#each navItems as item}
			<a
				href={item.href}
				class={`nav-pill ${page.url.pathname === item.href ? 'nav-pill-active' : 'nav-pill-inactive'}`}
			>
				{item.label}
			</a>
		{/each}
	</nav>

	{@render children()}
</div>
