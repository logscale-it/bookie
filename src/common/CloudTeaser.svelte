<script lang="ts">
	// Local mode: what a cloud-only page would offer, with the way into the trial.
	let { title, points }: { title: string; points: string[] } = $props();
</script>

<section class="card max-w-2xl space-y-4">
	<span
		class="inline-flex rounded-full bg-accent-500/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-accent-700 ring-1 ring-accent-600/15 dark:text-accent-300"
	>
		bookie Cloud
	</span>
	<h1 class="page-header">{title}</h1>
	<ul class="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
		{#each points as p (p)}<li>{p}</li>{/each}
	</ul>
	<p class="text-sm text-zinc-500 dark:text-zinc-400">
		14 Tage kostenlos, ohne Kreditkarte. Danach 5 € pro Platz und Monat, monatlich kündbar. Deine
		lokalen Daten ziehen mit um.
	</p>
	<a href="/einstellungen/cloud?neu=1" class="btn-primary inline-flex">Kostenlos testen</a>
</section>
