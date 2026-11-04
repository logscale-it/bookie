<script lang="ts">
	import { cloud } from '$lib/cloud';
	import { can } from '$lib/session.svelte';

	const links = [
		...(can('settings') ? [
			{ href: '/einstellungen/organisation', label: 'Organisation', hint: 'Absender, Steuer, Bank, DATEV' },
			{ href: '/einstellungen/rechnung', label: 'Rechnung', hint: 'Nummernkreis, Fristen, Logo' },
			{ href: '/einstellungen/mwst', label: 'MwSt.-Steuern', hint: 'Steuersätze für Positionen' }
		] : []),
		...(cloud()
			? [
					{ href: '/einstellungen/cloud', label: 'Konto & Abo', hint: 'Anmeldung, Sicherheit, Abo' },
					{ href: '/einstellungen/team', label: 'Team', hint: 'Mitglieder, Einladungen, Einladung annehmen' },
					...(can('invoices') ? [{ href: '/einstellungen/backup', label: 'Cloud-Export', hint: 'Alle Daten und Belege sichern' }] : [])
				]
			: [
					{ href: '/einstellungen/cloud', label: 'Cloud', hint: 'Im Team arbeiten · 14 Tage kostenlos testen' },
					{ href: '/einstellungen/backup', label: 'Backup & Wiederherstellung', hint: 'Datenbank sichern, GoBD-Export' }
				]),
		{ href: '/einstellungen/diagnose', label: 'Diagnose', hint: 'Protokoll für den Support' },
		{ href: '/einstellungen/updates', label: 'Updates', hint: 'Neue Versionen installieren' }
	];
</script>

<section class="grid gap-3 sm:grid-cols-2">
	{#each links as item}
		<a
			href={item.href}
			class="card group flex items-center justify-between gap-3 transition duration-200 ease-spring hover:-translate-y-0.5 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
		>
			<span>
				<span class="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.label}</span>
				<span class="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{item.hint}</span>
			</span>
			<svg class="h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200 ease-spring group-hover:translate-x-0.5 group-hover:text-accent-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
		</a>
	{/each}
</section>
