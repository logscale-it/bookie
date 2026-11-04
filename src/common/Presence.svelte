<script lang="ts">
	// Cloud: the team around you. Right: overlapping avatars of the other members
	// online (people on this page first, in full color). Left: a hint when someone
	// has the same record open, and a refresh pill once the others changed data.
	// Renders nothing locally or alone.
	import { page } from '$app/state';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { beat, hasChanges, presence, refresh, startPresence } from '$lib/presence.svelte';
	import Avatar from './Avatar.svelte';

	const MAX = 4;

	$effect(() => startPresence());
	$effect(() => void beat(page.url.pathname));

	const here = $derived(page.url.pathname);
	const peers = $derived(
		[...presence.peers].sort((a, b) => Number(b.path === here) - Number(a.path === here))
	);
	// Detail pages (/rechnungen/12) are one record: two people there can overwrite each other.
	const sameRecord = $derived(/\/\d+$/.test(here) ? peers.filter((p) => p.path === here) : []);
	const names = $derived(
		sameRecord.length === 1 ? sameRecord[0]!.name : `${sameRecord.slice(0, -1).map((p) => p.name).join(', ')} und ${sameRecord.at(-1)?.name}`
	);
	const label = (p: { name: string; path: string }) =>
		p.path === here ? `${p.name} sieht diese Seite gerade` : `${p.name} ist gerade online`;
</script>

{#if peers.length || hasChanges()}
	<div class="mb-3 flex flex-wrap items-center justify-end gap-3" data-testid="presence">
		{#if sameRecord.length}
			<p
				class="mr-auto flex items-center gap-2 rounded-full bg-amber-50 py-1 pr-3 pl-1 text-xs text-amber-900 ring-1 ring-amber-600/15 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-400/20"
				role="status"
				data-testid="same-record"
				in:fly={{ y: -6, duration: 320, easing: cubicOut }}
			>
				<Avatar id={sameRecord[0]!.userId} name={sameRecord[0]!.name} size="sm" />
				<span><strong class="font-medium">{names}</strong> {sameRecord.length === 1 ? 'hat' : 'haben'} das hier gerade auch offen. Wer zuerst speichert, gewinnt.</span>
			</p>
		{/if}

		{#if hasChanges()}
			<button
				type="button"
				class="group inline-flex items-center gap-2 rounded-full bg-zinc-900 py-1 pr-1 pl-3.5 text-xs font-medium text-white shadow-soft transition duration-200 ease-spring hover:bg-zinc-800 active:scale-[0.98] dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
				data-testid="team-changes"
				onclick={refresh}
				in:fly={{ y: -6, duration: 320, easing: cubicOut }}
			>
				<span class="relative flex h-1.5 w-1.5">
					<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-400 opacity-60"></span>
					<span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-500"></span>
				</span>
				Neue Änderungen im Team
				<span class="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 transition-transform duration-300 ease-spring group-hover:rotate-180 dark:bg-zinc-900/10">
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
				</span>
				<span class="sr-only">Seite aktualisieren</span>
			</button>
		{/if}

		{#if peers.length}
			<div class="flex items-center -space-x-1.5" role="list" aria-label="Gerade online">
				{#each peers.slice(0, MAX) as p (p.userId)}
					<span role="listitem" aria-label={label(p)} title={label(p)} class="relative animate-pop rounded-full ring-2 ring-zinc-100 dark:ring-zinc-900">
						<Avatar id={p.userId} name={p.name} title={label(p)} dim={p.path !== here} />
						{#if p.path === here}
							<span class="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-zinc-100 dark:ring-zinc-900"></span>
						{/if}
					</span>
				{/each}
				{#if peers.length > MAX}
					<span
						role="listitem"
						title={peers.slice(MAX).map(label).join('\n')}
						class="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[11px] font-medium text-zinc-600 ring-2 ring-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-900"
					>
						+{peers.length - MAX}
					</span>
				{/if}
			</div>
		{/if}
	</div>
{/if}
