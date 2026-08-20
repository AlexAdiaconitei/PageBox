<script lang="ts">
	/**
	 * The error page, and the reason `handleError` bothers to mint an id.
	 *
	 * Without this file SvelteKit renders its own default, which prints the message and
	 * nothing else — so the id that `handleError` logged next to the stack trace never
	 * reached the person looking at the screen, and a 500 in a form action was a blank wall
	 * with no way to connect it to a log line. Every route falls back here, the panel and
	 * the site host alike, so it stays plain and says only what is true.
	 */
	import { page } from '$app/state';

	const id = $derived(page.error?.id);
	const status = $derived(page.status);

	const heading = $derived(
		status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : 'Something broke'
	);
</script>

<svelte:head>
	<title>{status} — PageBox</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-6">
	<div>
		<p class="eyebrow">{status}</p>
		<h1 class="text-[1.2rem] font-semibold tracking-tight">{heading}</h1>
		<p class="text-muted mt-1 text-[0.85rem]">{page.error?.message ?? 'Unknown error'}</p>
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
