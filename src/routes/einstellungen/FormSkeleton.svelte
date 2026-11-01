<script lang="ts">
	let { fields = 6 }: { fields?: number } = $props();
</script>

<div class="space-y-4" aria-busy="true">
	<div class="space-y-2">
		<div class="skeleton h-2.5 w-16"></div>
		<div class="skeleton h-4 w-40"></div>
	</div>
	<div class="grid gap-3 md:grid-cols-2">
		{#each Array(fields) as _}
			<div class="space-y-1.5">
				<div class="skeleton h-2.5 w-20"></div>
				<div class="skeleton h-9 w-full rounded-lg"></div>
			</div>
		{/each}
	</div>
</div>
