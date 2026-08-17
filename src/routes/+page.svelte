<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>PageBox</title>
	<!-- The site host must never advertise what is hosted on it. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
	<p class="eyebrow">{data.sitesHost}</p>
	<h1 class="text-[20px] font-semibold tracking-tight">Static sites</h1>
	<!-- Deliberately says nothing about which sites exist: listing them would leak the
	     existence of the private ones. -->
	<p class="text-muted text-[13.5px]">
		Sites live under <span class="mono">{data.sitesPrefix}/&lt;slug&gt;/</span>. Follow the link you
		were given.
	</p>
	<div class="mt-2 flex items-center gap-3">
		{#if data.signedIn}
			<form method="POST" action="/logout">
				<button class="btn btn-ghost" type="submit">Sign out</button>
			</form>
		{:else}
			<a class="btn btn-ghost" href="/login">Sign in to read private sites</a>
		{/if}
	</div>
</main>
