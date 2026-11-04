<script lang="ts">
	// One face per person everywhere (presence, feed, team): initials on a color
	// picked by user id, so the same colleague always looks the same.
	import { initials } from '$lib/session.svelte';

	let {
		id = null,
		name,
		size = 'md',
		dim = false,
		title = name
	}: { id?: number | null; name: string; size?: 'sm' | 'md'; dim?: boolean; title?: string } = $props();

	// Full class names so Tailwind sees them.
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
	const color = $derived(id == null ? 'bg-zinc-400 dark:bg-zinc-600' : COLORS[id % COLORS.length]);
</script>

<span
	{title}
	class="relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white transition duration-200 ease-spring {size === 'sm'
		? 'h-5 w-5 text-[10px]'
		: 'h-7 w-7 text-[11px]'} {color} {dim ? 'opacity-50 saturate-50' : ''}"
>
	{initials(name)}
</span>
