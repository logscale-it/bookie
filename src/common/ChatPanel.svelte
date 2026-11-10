<script lang="ts">
	// Assistant docked beside the page: closed / docked (380px) / wide (560px).
	// It sees the figures the open page publishes (lib/chat/context) and shows them
	// in the header chip, so the user knows exactly what is sent. Mounted once in
	// the root layout; ⌘J / Ctrl+J toggles it.
	import { tick } from 'svelte';
	import { t, tp } from '$lib/i18n';
	import { aiConfig, aiUsage, PROVIDERS } from '$lib/ai';
	import { cloud } from '$lib/cloud';
	import { chat, sendChat, resetChat, toggleChat } from '$lib/chat/chat.svelte';
	import { pageContext } from '$lib/chat/context.svelte';
	import { valueCount } from '$lib/chat/prompt';
	import { isSub, session } from '$lib/session.svelte';
	import StreamText from './StreamText.svelte';

	let draft = $state('');
	let configured = $state(false);
	let showData = $state(false);
	let input = $state<HTMLTextAreaElement>();
	let list = $state<HTMLDivElement>();

	const ctx = $derived(pageContext.current);
	const open = $derived(chat.mode !== 'closed');
	const provider = () => (cloud() ? 'Mistral (EU)' : PROVIDERS[aiConfig()?.provider ?? 'anthropic'].label);
	const quick = ['chat.quick1', 'chat.quick2', 'chat.quick3'] as const;

	// localStorage is not reactive: re-check whenever the panel opens. Cloud: the server says
	// whether the assistant is on and how much of the month's quota is used.
	$effect(() => {
		if (!open) return;
		if (cloud()) {
			aiUsage()
				.then((u) => {
					configured = u.enabled;
					chat.quota = { used: u.used, limit: u.limit };
				})
				.catch(() => (configured = false));
		} else configured = aiConfig() !== null;
	});

	// The textarea exists only once configured; focus it whenever it appears while open.
	$effect(() => {
		if (open && input) input.focus();
	});

	// Another company is another set of books: start a fresh conversation.
	let lastCompany: number | undefined;
	$effect(() => {
		const id = session.company?.id;
		if (lastCompany !== undefined && id !== lastCompany) resetChat();
		lastCompany = id;
	});

	function scrollEnd(smooth = false) {
		list?.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}
	$effect(() => {
		chat.turns.length;
		chat.busy;
		tick().then(() => scrollEnd(true));
	});

	function grow() {
		if (!input) return;
		input.style.height = 'auto';
		input.style.height = Math.min(input.scrollHeight, 160) + 'px';
	}

	async function submit(text = draft) {
		const q = text.trim();
		if (!q || chat.busy) return;
		draft = '';
		tick().then(grow);
		if (!(await sendChat(q)) && chat.error) draft = q;
	}

	function onkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
			if (isSub()) return;
			e.preventDefault();
			toggleChat();
		} else if (e.key === 'Escape' && open && (e.target as HTMLElement)?.closest('[data-chat]')) {
			chat.mode = 'closed';
		}
	}
</script>

<svelte:window onkeydown={onkey} />

<aside
	data-chat
	data-testid="chat-panel"
	aria-label={t('chat.title')}
	inert={!open}
	class="shrink-0 overflow-hidden bg-white dark:bg-zinc-900
		max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-40 max-md:h-[65vh] max-md:rounded-t-2xl max-md:border-t max-md:border-zinc-900/10 max-md:dark:border-white/10
		{open ? '[transition:width_300ms_var(--ease-out-expo)]' : 'invisible max-md:hidden [transition:width_300ms_var(--ease-out-expo),visibility_0s_linear_300ms]'}
		{chat.mode === 'closed' ? 'md:w-0' : chat.mode === 'wide' ? 'md:w-[560px]' : 'md:w-[380px]'}
		md:border-l md:border-zinc-900/5 md:dark:border-white/10 {open ? '' : 'md:border-l-0'}"
>
	<div class="flex h-full flex-col md:h-screen {chat.mode === 'wide' ? 'md:w-[560px]' : 'md:w-[380px]'}">
		<header class="flex items-center gap-1 px-4 pb-2 pt-4">
			<h2 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('chat.title')}</h2>
			<span class="mr-auto ml-2 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500" data-testid="chat-quota">{chat.quota && cloud() ? tp('chat.quota', chat.quota) : ''}</span>
			{#if chat.turns.length}
				<button type="button" class="icon-btn" title={t('chat.clear')} aria-label={t('chat.clear')} onclick={resetChat} data-testid="chat-new">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992V4.356M2.985 19.644v-4.992h4.992m10.5-4.304A8.25 8.25 0 005.4 8.4M3.523 14.652A8.25 8.25 0 0018.6 15.6" /></svg>
				</button>
			{/if}
			<button
				type="button"
				class="icon-btn hidden md:inline-flex"
				title={chat.mode === 'wide' ? t('chat.collapse') : t('chat.expand')}
				aria-label={chat.mode === 'wide' ? t('chat.collapse') : t('chat.expand')}
				onclick={() => (chat.mode = chat.mode === 'wide' ? 'docked' : 'wide')}
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d={chat.mode === 'wide' ? 'M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5m4.5 0l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25' : 'M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15'} />
				</svg>
			</button>
			<button type="button" class="icon-btn" title={t('chat.close')} aria-label={t('chat.close')} onclick={() => (chat.mode = 'closed')}>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
			</button>
		</header>

		<div class="px-4 pb-3">
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded-md bg-zinc-100 px-2.5 py-1.5 text-left text-xs text-zinc-600 transition-colors duration-200 hover:bg-zinc-200/70 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
				aria-expanded={showData}
				disabled={!ctx}
				onclick={() => (showData = !showData)}
				data-testid="chat-context-chip"
			>
				<span class="h-1.5 w-1.5 shrink-0 rounded-full {ctx ? 'bg-accent-500' : 'bg-zinc-400'}"></span>
				<span class="truncate">{ctx ? tp('chat.sees', { title: ctx.title, n: valueCount(ctx.facts) }) : t('chat.seesNothing')}</span>
			</button>
			{#if showData && ctx}
				<div class="mt-2 animate-pop rounded-md bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
					<pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">{JSON.stringify(ctx.facts, null, 1)}</pre>
					<p class="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{tp('chat.sentNote', { provider: provider() })}</p>
				</div>
			{/if}
		</div>

		{#if !configured}
			<div class="flex flex-1 flex-col justify-center gap-3 px-6 pb-10">
				{#if cloud()}
					<p class="text-sm font-medium text-zinc-800 dark:text-zinc-100">{t('chat.unavailableTitle')}</p>
					<p class="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('chat.unavailableHint')}</p>
				{:else}
					<p class="text-sm font-medium text-zinc-800 dark:text-zinc-100">{t('chat.setupTitle')}</p>
					<p class="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('chat.setupHint')}</p>
					<a href="/einstellungen/ki" class="btn-primary self-start" onclick={() => (chat.mode = 'closed')}>{t('chat.setupAction')}</a>
				{/if}
			</div>
		{:else}
			<div bind:this={list} class="flex-1 space-y-4 overflow-y-auto px-4 pb-4" aria-live="polite">
				{#if !chat.turns.length}
					<div class="space-y-4 pt-6">
						<div class="space-y-1">
							<p class="text-sm font-medium text-zinc-800 dark:text-zinc-100">{t('chat.emptyTitle')}</p>
							<p class="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('chat.emptyHint')}</p>
						</div>
						<div class="flex flex-col items-start gap-2">
							{#each quick as k (k)}
								<button type="button" class="chip" disabled={!ctx} onclick={() => submit(t(k))}>{t(k)}</button>
							{/each}
						</div>
					</div>
				{/if}
				{#each chat.turns as turn, i (i)}
					{#if turn.role === 'user'}
						<p data-testid="chat-row" data-role="user" class="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-xl bg-zinc-100 px-3 py-2 text-sm text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{turn.text}</p>
					{:else}
						<p data-testid="chat-row" data-role="assistant" class="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200"><StreamText text={turn.text} animate={turn.stream} ongrow={() => scrollEnd()} ondone={() => (turn.stream = false)} /></p>
					{/if}
				{/each}
				{#if chat.busy}
					<div class="space-y-2" data-testid="chat-pending" role="status" aria-label={t('chat.thinking')}>
						<div class="skeleton h-3 w-11/12"></div>
						<div class="skeleton h-3 w-7/12"></div>
					</div>
				{/if}
				{#if chat.error}
					<p class="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-900/20 dark:text-red-200" role="alert" data-testid="chat-error">
						<span class="font-medium">{t('chat.error')}.</span> {chat.error}
					</p>
				{/if}
			</div>

			<form class="flex items-end gap-2 px-4 pb-4 pt-2" onsubmit={(e) => { e.preventDefault(); submit(); }}>
				<textarea
					bind:this={input}
					bind:value={draft}
					oninput={grow}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
							e.preventDefault();
							submit();
						}
					}}
					rows="1"
					placeholder={t('chat.placeholder')}
					aria-label={t('chat.placeholder')}
					class="input-base input-valid max-h-40 resize-none"
					data-testid="chat-input"
				></textarea>
				<button type="submit" data-testid="chat-send" class="btn-primary shrink-0" disabled={!draft.trim() || chat.busy}>{t('chat.send')}</button>
			</form>
		{/if}
	</div>
</aside>
