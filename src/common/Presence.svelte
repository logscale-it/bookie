<script lang="ts">
	// Cloud: overlapping avatars of the other members online right now; people on
	// the same page come first and in full color. Renders nothing locally or alone.
	import { page } from '$app/state';
	import { initials } from '$lib/session.svelte';
	import { beat, presence, startPresence } from '$lib/presence.svelte';

	const MAX = 4;
	// Full class names so Tailwind sees them; picked by user id, stable across sessions.
	const COLORS = [
		'bg-sky-500',
		'bg-emerald-500',
		'bg-amber-500',
		'bg-rose-500',
		'bg-violet-500',
		'bg-teal-500',
		'bg-orange-500',
		'bg-indigo-500'
	];

	$effect(() => startPresence());
	$effect(() => void beat(page.url.pathname));

	const here = $derived(page.url.pathname);
	const peers = $derived(
		[...presence.peers].sort((a, b) => Number(b.path === here) - Number(a.path === here))
	);
	const label = (p: { name: string; path: string }) =>
		p.path === here ? `${p.name} sieht diese Seite gerade` : `${p.name} ist gerade online`;
</script>

{#if peers.length}
	<div class="flex items-center -space-x-1.5" role="list" aria-label="Gerade online">
		{#each peers.slice(0, MAX) as p (p.userId)}
			<span
				role="listitem"
				title={label(p)}
				aria-label={label(p)}
				class="relative flex h-7 w-7 animate-pop items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white transition duration-200 ease-spring dark:ring-zinc-900 {COLORS[
					p.userId % COLORS.length
				]} {p.path === here ? '' : 'opacity-50 saturate-50'}"
			>
				{initials(p.name)}
				{#if p.path === here}
					<span
						class="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-900"
					></span>
				{/if}
			</span>
		{/each}
		{#if peers.length > MAX}
			<span
				role="listitem"
				title={peers.slice(MAX).map(label).join('\n')}
				class="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-medium text-zinc-600 ring-2 ring-white dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-900"
			>
				+{peers.length - MAX}
			</span>
		{/if}
	</div>
{/if}
