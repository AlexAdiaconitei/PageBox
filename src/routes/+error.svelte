<script lang="ts">
	/**
	 * The error page for everything the router does reach, and the reason `handleError`
	 * bothers to mint an id.
	 *
	 * Without this file SvelteKit renders its own default, which prints the message and
	 * nothing else — so the id logged next to the stack trace never reached the person
	 * looking at the screen, and a 500 in a form action was a blank wall with no way to
	 * connect it to a log line.
	 *
	 * Every route falls back here, the panel and the site host alike, so it stays plain and
	 * says only what is true of both. It is deliberately the same shape as the pages
	 * rendered by $lib/server/errorPage.ts — the ones the host dispatch and the site server
	 * answer with, which never reach the router at all. Two code paths, one design: a
	 * visitor cannot tell which of them answered, and should not have to.
	 */
	import { page } from '$app/state';
	import PageboxMark from '$lib/components/PageboxMark.svelte';

	const id = $derived(page.error?.id);
	const status = $derived(page.status);

	const heading = $derived(
		status === 404
			? 'Not found'
			: status === 401
				? 'Sign in required'
				: status === 403
					? 'Not allowed'
					: status === 429
						? 'Too many requests'
						: 'Something broke'
	);

	/**
	 * The server's own message, unless it only repeats the heading — `error(404, 'Not
	 * found')` is the common case and reading the same two words twice tells nobody
	 * anything. `Site not found` from a panel load does add something, so it stays.
	 */
	const detail = $derived(
		(page.error?.message ?? '').toLowerCase() === heading.toLowerCase()
			? null
			: (page.error?.message ?? null)
	);

	const note = $derived(
		status === 404
			? 'Renamed, deleted, or never there — this answer does not say which.'
			: status >= 500
				? 'Something on the server threw while answering this. The reference below is the only thing that ties it to a line in the log.'
				: null
	);
</script>

<svelte:head>
	<title>{status} — {heading}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-6">
	<div class="text-faint flex items-center gap-2">
		<PageboxMark size={22} />
		<b class="text-ink text-[0.95rem] font-semibold tracking-tight">PageBox</b>
	</div>

	<div>
		<p class="eyebrow">{status}</p>
		<h1 class="text-[1.2rem] font-semibold tracking-tight">{heading}</h1>
		{#if detail}
			<p class="text-muted mt-1 text-[0.9rem]">{detail}</p>
		{/if}
		{#if note}
			<p class="text-faint mt-3 text-[0.82rem]">{note}</p>
		{/if}
	</div>

	{#if id}
		<!-- The one thing worth carrying out of a 500: the server logged this exact string
		     beside the stack trace, so quoting it turns "it broke" into a line in the log. -->
		<div class="border-line rounded-md border p-3">
			<p class="eyebrow">Reference</p>
			<p class="mono mt-1 text-[0.8rem] break-all">{id}</p>
			<p class="text-faint mt-1 text-[0.78rem]">
				Quote this when reporting it — the server log has the same id.
			</p>
		</div>
	{/if}

	<div>
		<!-- `/` and not `/sites`: this page is the fallback for both hostnames, and only the
		     admin one has a panel to go back to. -->
		<a class="btn btn-ghost" href="/">Start again</a>
	</div>
</main>
