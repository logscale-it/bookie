<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n';
</script>

<div class="flex min-h-[60vh] items-center justify-center px-4">
	<div class="flex max-w-sm animate-pop flex-col items-center gap-4 text-center">
		<span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:text-zinc-500 dark:ring-white/10">
			<svg class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.25"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
		</span>
		<div class="space-y-1.5">
			<p class="text-xs font-medium tabular-nums text-zinc-400">Fehler {page.status}</p>
			<h1 class="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
				{page.status === 404 ? 'Seite nicht gefunden' : 'Etwas ist schiefgelaufen'}
			</h1>
			<p class="text-sm text-zinc-500 dark:text-zinc-400">{page.error?.message ?? t('common.unexpectedError')}</p>
		</div>
		<a href="/" class="btn-primary mt-1">Zur Übersicht</a>
	</div>
</div>
