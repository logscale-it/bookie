<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
	import CloudWorkContext from '../../common/CloudWorkContext.svelte';

	let { children }: { children: Snippet } = $props();

	const navItems = [
		{ get label() { return t('timeTracking.entries'); }, href: '/zeiterfassung' },
		{ get label() { return t('timeTracking.timesheet'); }, href: '/zeiterfassung/stundenzettel' }
	];
	const activeIndex = $derived(Math.max(0, navItems.findIndex((item) => page.url.pathname === item.href)));
</script>

<div class="space-y-6">
	<header>
		<h1 class="text-2xl font-semibold tracking-tight">{t('timeTracking.title')}</h1>
		<p class="text-sm text-zinc-500 dark:text-zinc-400">{t('timeTracking.subtitle')}</p>
	</header>

	<CloudWorkContext />

	<!-- Segmented control: the indicator slides under the active tab. -->
	<nav class="relative inline-grid grid-cols-2 rounded-xl bg-zinc-900/[0.04] p-1 ring-1 ring-zinc-900/5 dark:bg-white/[0.04] dark:ring-white/10">
		<span
			aria-hidden="true"
			class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-white shadow-soft ring-1 ring-zinc-900/5 transition-transform duration-300 ease-spring dark:bg-zinc-700 dark:ring-white/10"
			style="transform: translateX({activeIndex * 100}%)"
		></span>
		{#each navItems as item, i}
			<a
				href={item.href}
				aria-current={i === activeIndex ? 'page' : undefined}
				class="relative z-10 px-4 py-1.5 text-center text-sm font-medium transition-colors duration-200 {i === activeIndex ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}"
			>
				{item.label}
			</a>
		{/each}
	</nav>

	{@render children()}
</div>
