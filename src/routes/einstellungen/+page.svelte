<script lang="ts">
	const links = [
		{ href: '/einstellungen/organisation', label: 'Organisation' },
		{ href: '/einstellungen/rechnung', label: 'Rechnung' },
		{ href: '/einstellungen/mwst', label: 'MwSt.-Steuern' },
		{ href: '/einstellungen/backup', label: 'Backup & Wiederherstellung' },
		{ href: '/einstellungen/diagnose', label: 'Diagnose' }
	];
</script>

<section class="grid gap-3 sm:grid-cols-2">
	{#each links as item}
		<a
			href={item.href}
			class="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-700 transition hover:border-blue-500 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
		>
			{item.label}
		</a>
	{/each}
</section>
