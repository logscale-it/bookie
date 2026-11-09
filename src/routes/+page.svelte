<script lang="ts">
	import { t } from '$lib/i18n';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { can } from '$lib/session.svelte';

	onMount(() => {
		// Without reports access the dashboard is empty: start at the time sheet.
		goto(can('reports') ? '/uebersicht' : '/zeiterfassung', { replaceState: true });
	});
</script>

<div class="space-y-4" aria-busy="true" aria-label={t('misc.redirecting')}>
	<div class="skeleton h-7 w-48"></div>
	<div class="grid gap-3 sm:grid-cols-3">
		{#each Array(3) as _}<div class="skeleton h-24 rounded-2xl"></div>{/each}
	</div>
	<div class="skeleton h-64 rounded-2xl"></div>
</div>
