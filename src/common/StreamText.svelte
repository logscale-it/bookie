<script lang="ts">
	import { untrack } from 'svelte';
	// Reveals an answer token by token so it reads as streaming. The provider call
	// returns the whole text at once; this is a visual layer only. Respects
	// prefers-reduced-motion (shows everything at once) and reports growth so the
	// list can keep itself scrolled to the end.
	let {
		text,
		animate = false,
		ondone,
		ongrow
	}: { text: string; animate?: boolean; ondone?: () => void; ongrow?: () => void } = $props();

	const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	// Tokens ≈ a word with its trailing space, like a model's chunks.
	const tokens = $derived(text.match(/\S+\s*|\s+/g) ?? []);
	const live = untrack(() => animate) && !reduced;

	let count = $state(live ? 0 : Infinity);
	const shown = $derived(live ? tokens.slice(0, count).join('') : text);
	const streaming = $derived(live && count < tokens.length);

	$effect(() => {
		if (!live) return;
		let raf = 0;
		let last = 0;
		let carry = 0;
		const step = (now: number) => {
			// ~55 tokens/s, with the occasional pause after punctuation.
			carry += ((now - (last || now)) / 1000) * 55;
			last = now;
			let n = Math.floor(carry);
			if (n > 0) {
				carry -= n;
				const prev = tokens[count - 1] ?? '';
				if (/[.!?:]\s*$/.test(prev)) carry -= 0.6;
				count = Math.min(tokens.length, count + n);
				ongrow?.();
			}
			if (count < tokens.length) raf = requestAnimationFrame(step);
			else ondone?.();
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	});
</script>

<span class="whitespace-pre-wrap">{shown}</span>{#if streaming}<span class="stream-caret" aria-hidden="true"></span>{/if}

<style>
	.stream-caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		margin-left: 1px;
		vertical-align: text-bottom;
		border-radius: 2px;
		background: currentColor;
		opacity: 0.55;
		animation: caret 1s var(--ease-spring) infinite;
	}
	@keyframes caret {
		50% {
			opacity: 0.1;
		}
	}
</style>
