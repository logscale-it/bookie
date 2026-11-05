<script lang="ts">
	// Settings form footer: primary save button with ⌘S, plus optional extras.
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n';
	import { isSaveKey } from '$lib/ui/shortcut';
	import { can } from '$lib/session.svelte';

	let {
		saving = false,
		disabled = false,
		onsave,
		children
	}: { saving?: boolean; disabled?: boolean; onsave: () => unknown; children?: Snippet } = $props();

	// settings:view only = read-only page (server: PATCH needs settings:edit).
	const canEdit = can('settings', 'edit');
	const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
</script>

<svelte:window
	onkeydown={(e) => {
		if (!isSaveKey(e) || !canEdit) return;
		e.preventDefault();
		if (!saving && !disabled) onsave();
	}}
/>

{#if canEdit}
	<div class="flex flex-wrap items-center gap-3">
		<button type="button" onclick={onsave} disabled={saving || disabled} class="btn-primary">
			{saving ? t('common.saving') : t('common.saveChanges')}
			<span class="kbd border-white/20 bg-white/10 text-white/80 dark:border-white/20 dark:bg-white/10 dark:text-white/80">{mac ? '⌘S' : 'Strg S'}</span>
		</button>
		{@render children?.()}
	</div>
{/if}
