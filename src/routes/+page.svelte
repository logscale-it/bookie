<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { can } from '$lib/session.svelte';

	onMount(() => {
		// Without reports access the dashboard is empty: start at the time sheet.
		goto(can('reports') ? '/uebersicht' : '/zeiterfassung', { replaceState: true });
	});
</script>

<p class="text-sm text-zinc-600 dark:text-zinc-300">Weiterleitung…</p>
