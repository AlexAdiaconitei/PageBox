<script lang="ts">
	/**
	 * Errors raised inside the panel, rendered inside the panel.
	 *
	 * Without this file they fall through to src/routes/+error.svelte, which is the
	 * boundary above the group layout: the rail disappears and a signed-in operator who
	 * clicked one link too far is dropped onto a bare page with a "start again" link, as if
	 * the session had ended. Here the console stays up and the error is just the content of
	 * the current view.
	 *
	 * The 404 note is the load-bearing part. The panel answers 404 — not 403 — for a site,
	 * group or user the account is not allowed to see (see hasOperatorAccess, and the
	 * `error(404)` calls in the +page.server.ts files), because a 403 would confirm the
	 * thing exists. That is right, and it is also confusing to whoever hit it, so the page
	 * says so: it may be missing, or it may be yours-to-not-see.
	 */
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	const status = $derived(page.status);
	const id = $derived(page.error?.id);

	const heading = $derived(
		status === 404
			? 'Not found'
			: status === 403
				? 'Not allowed'
				: status === 429
					? 'Too many requests'
					: 'Something broke'
	);

	const detail = $derived(
		(page.error?.message ?? '').toLowerCase() === heading.toLowerCase()
			? null
			: (page.error?.message ?? null)
	);

	const note = $derived(
		status === 404
			? 'The panel answers the same way for a page that does not exist and for one your account may not open, so this is either a dead link or a boundary — it does not say which.'
			: status >= 500
				? 'The server threw while handling this. If it was an action that changes something, check the current state before repeating it — this page cannot tell you how far it got.'
				: null
	);
</script>

<svelte:head><title>{status} — {heading}</title></svelte:head>

<div class="border-line rounded-md border border-dashed px-6 py-12 text-center">
	<p class="eyebrow">{status}</p>
	<p class="mt-1 text-[0.95rem] font-medium">{heading}</p>
	{#if detail}
		<p class="text-muted mt-1 text-[0.85rem]">{detail}</p>
	{/if}
	{#if note}
		<p class="text-faint mx-auto mt-3 max-w-sm text-[0.8rem]">{note}</p>
	{/if}

	{#if id}
		<p class="text-faint mt-4 text-[0.78rem]">
			Reference <span class="mono">{id}</span> — the server log has the same id.
		</p>
	{/if}

	<div class="mt-6">
		<a class="btn btn-ghost" href="/sites">
			<ArrowLeft size={14} strokeWidth={1.75} />
			Back to sites
		</a>
	</div>
</div>
