<script lang="ts">
	// Revenue/costs areas + profit line. Hand-written SVG, sized in pixels from
	// the container width (no stretched strokes), redrawn with a draw-in on data change.
	type Point = { label: string; revenue: number; costs: number; profit: number };
	let {
		points,
		format,
		labels,
		height = 220
	}: {
		points: Point[];
		format: (v: number) => string;
		labels: { revenue: string; costs: string; profit: string };
		height?: number;
	} = $props();

	const uid = $props.id();
	const pad = { l: 8, r: 8, t: 12, b: 26 };
	let width = $state(600);
	let hover = $state<number | null>(null);

	const lo = $derived(Math.min(0, ...points.map((p) => p.profit)));
	const hi = $derived(Math.max(1, ...points.flatMap((p) => [p.revenue, p.costs, p.profit])));
	const step = $derived(points.length > 1 ? (width - pad.l - pad.r) / (points.length - 1) : 0);
	const x = (i: number) => pad.l + i * step;
	const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (height - pad.t - pad.b);
	const line = (k: keyof Omit<Point, 'label'>) =>
		points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
	const area = (k: 'revenue' | 'costs') =>
		`${line(k)}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
	const short = $derived(points.length > 6);

	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const i = Math.round((e.clientX - r.left - pad.l) / (step || 1));
		hover = Math.max(0, Math.min(points.length - 1, i));
	}
	function key(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		const d = e.key === 'ArrowLeft' ? -1 : 1;
		hover = Math.max(0, Math.min(points.length - 1, (hover ?? (d > 0 ? -1 : points.length)) + d));
	}
</script>

<div class="relative" bind:clientWidth={width}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<svg
		viewBox="0 0 {width} {height}"
		class="block w-full overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
		style="height:{height}px"
		role="img"
		aria-label="{labels.revenue}, {labels.costs}, {labels.profit}"
		tabindex="0"
		onpointermove={move}
		onpointerleave={() => (hover = null)}
		onkeydown={key}
		onblur={() => (hover = null)}
	>
		<defs>
			<linearGradient id="{uid}-rev" x1="0" x2="0" y1="0" y2="1">
				<stop offset="0" stop-color="#10b981" stop-opacity="0.28" /><stop offset="1" stop-color="#10b981" stop-opacity="0" />
			</linearGradient>
			<linearGradient id="{uid}-cost" x1="0" x2="0" y1="0" y2="1">
				<stop offset="0" stop-color="#f87171" stop-opacity="0.24" /><stop offset="1" stop-color="#f87171" stop-opacity="0" />
			</linearGradient>
		</defs>
		{#each [hi, (hi + lo) / 2, 0] as g (g)}
			<line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} class="stroke-zinc-200 dark:stroke-zinc-700/70" stroke-dasharray={g ? '2 4' : undefined} />
		{/each}
		{#key points}
			<g class="chart-rise" style="transform-origin: 0 {y(0)}px">
				<path d={area('revenue')} fill="url(#{uid}-rev)" />
				<path d={line('revenue')} fill="none" stroke="#10b981" stroke-width="1.5" stroke-linejoin="round" />
				<path d={area('costs')} fill="url(#{uid}-cost)" />
				<path d={line('costs')} fill="none" stroke="#f87171" stroke-width="1.5" stroke-linejoin="round" />
			</g>
			<path d={line('profit')} pathLength="1" class="chart-draw stroke-zinc-800 dark:stroke-zinc-100" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
		{/key}
		{#each points as p, i (i)}
			<text x={x(i)} y={height - 6} text-anchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} class="fill-zinc-400 text-[10px] dark:fill-zinc-500">{short ? p.label.slice(0, 3) : p.label}</text>
		{/each}
		{#if hover !== null}
			<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} class="stroke-zinc-400/70 dark:stroke-zinc-500" stroke-dasharray="3 3" />
			{#each [['revenue', '#10b981'], ['costs', '#f87171']] as const as [k, c] (k)}
				<circle cx={x(hover)} cy={y(points[hover][k])} r="3.5" fill={c} class="stroke-white dark:stroke-zinc-900" stroke-width="2" />
			{/each}
			<circle cx={x(hover)} cy={y(points[hover].profit)} r="3.5" class="fill-zinc-800 stroke-white dark:fill-zinc-100 dark:stroke-zinc-900" stroke-width="2" />
		{/if}
	</svg>
	{#if hover !== null}
		{@const p = points[hover]}
		<div
			class="pointer-events-none absolute top-0 z-10 min-w-44 rounded-xl bg-white/95 p-3 text-xs shadow-float ring-1 ring-zinc-900/5 backdrop-blur transition-transform duration-200 ease-out-expo dark:bg-zinc-800/95 dark:ring-white/10"
			style="left:0; transform: translateX(clamp(0px, {x(hover) - 88}px, {Math.max(0, width - 176)}px))"
			aria-live="polite"
		>
			<p class="mb-1.5 font-medium text-zinc-900 dark:text-zinc-100">{p.label}</p>
			{#each [[labels.revenue, p.revenue, 'bg-emerald-500'], [labels.costs, p.costs, 'bg-red-400'], [labels.profit, p.profit, 'bg-zinc-800 dark:bg-zinc-100']] as const as [l, v, dot] (l)}
				<p class="flex items-center justify-between gap-4 py-0.5 text-zinc-500 dark:text-zinc-400">
					<span class="flex items-center gap-1.5"><span class="h-1.5 w-1.5 rounded-full {dot}"></span>{l}</span>
					<span class="tabular-nums text-zinc-900 dark:text-zinc-100">{format(v)}</span>
				</p>
			{/each}
		</div>
	{/if}
</div>

<style>
	.chart-rise {
		animation: rise 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	.chart-draw {
		stroke-dasharray: 1;
		animation: draw 900ms cubic-bezier(0.16, 1, 0.3, 1) 150ms both;
	}
	@keyframes rise {
		from { transform: scaleY(0); opacity: 0; }
	}
	@keyframes draw {
		from { stroke-dashoffset: 1; }
		to { stroke-dashoffset: 0; }
	}
</style>
