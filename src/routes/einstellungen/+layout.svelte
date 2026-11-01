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

	// Sliding underline: a 1px-wide bar moved and stretched via transform only.
	let nav = $state<HTMLElement>();
	let bar = $state({ x: 0, w: 0, on: false, ready: false });
	// Plain (non-reactive) so measure() never subscribes the effects to `bar`.
	let last = { x: 0, w: 0, shown: false };
	function measure() {
		const el = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
		// No transition on the very first placement, so it doesn't slide in from 0.
		const ready = last.shown;
		if (el) last = { x: el.offsetLeft, w: el.offsetWidth, shown: true };
		bar = { x: last.x, w: last.w, on: !!el, ready };
	}
	$effect(() => {
		void page.url.pathname;
		measure();
	});
	$effect(() => {
		if (!nav) return;
		const ro = new ResizeObserver(measure);
		ro.observe(nav);
		return () => ro.disconnect();
	});
</script>

<div class="space-y-6">
	<header>
		<h1 class="page-header">{t('settings.title')}</h1>
		<p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('settings.subtitle')}</p>
	</header>

	<nav bind:this={nav} class="relative -mx-1 flex gap-1 overflow-x-auto border-b border-zinc-200/80 px-1 dark:border-zinc-700/70" aria-label={t('settings.title')}>
		{#each navItems as item}
			{@const active = page.url.pathname === item.href}
			<a
				href={item.href}
				aria-current={active ? 'page' : undefined}
				class="relative shrink-0 whitespace-nowrap rounded-md px-3 pb-3 pt-2 text-sm font-medium transition-colors duration-200 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 {active
					? 'text-zinc-900 dark:text-zinc-50'
					: 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}"
			>
				{item.label}
			</a>
		{/each}
		<span
			aria-hidden="true"
			class="pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left bg-accent-600 dark:bg-accent-400 {bar.ready
				? 'transition-[transform,opacity] duration-300 ease-spring'
				: ''}"
			style="transform: translateX({bar.x}px) scaleX({bar.w}); opacity: {bar.on ? 1 : 0}"
		></span>
	</nav>

	{@render children()}
</div>
