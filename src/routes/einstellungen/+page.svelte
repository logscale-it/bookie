<script lang="ts">
	import { cloud } from '$lib/cloud';
	import { can } from '$lib/session.svelte';
	import { t } from '$lib/i18n';

	const links = [
		...(can('settings') ? [
			{ href: '/einstellungen/organisation', label: t('settings.organisation'), hint: t('settingsHub.orgHint') },
			{ href: '/einstellungen/rechnung', label: t('settings.invoice'), hint: t('settingsHub.invoiceHint') },
			{ href: '/einstellungen/mwst', label: t('settings.vatTaxes'), hint: t('settingsHub.vatHint') }
		] : []),
		...(cloud()
			? [
					{ href: '/einstellungen/cloud', label: t('settingsHub.account'), hint: t('settingsHub.accountHint') },
					{ href: '/einstellungen/team', label: t('settingsHub.team'), hint: t('settingsHub.teamHint') },
					...(can('invoices') ? [{ href: '/einstellungen/backup', label: t('settingsHub.cloudExport'), hint: t('settingsHub.cloudExportHint') }] : [])
				]
			: [
					{ href: '/einstellungen/cloud', label: t('settingsHub.cloud'), hint: t('settingsHub.cloudHint') },
					{ href: '/einstellungen/backup', label: t('settings.backup'), hint: t('settingsHub.backupHint') }
				]),
		{ href: '/einstellungen/diagnose', label: t('settings.diagnose'), hint: t('settingsHub.diagnoseHint') },
		{ href: '/einstellungen/updates', label: t('settingsHub.updates'), hint: t('settingsHub.updatesHint') }
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
