<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>{data.hostKind === 'admin' ? 'PageBox' : 'PageBox — sites'}</title>
	<!-- The site host must never advertise what is hosted on it. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
	<h1 class="text-2xl font-semibold tracking-tight">PageBox</h1>

	{#if data.hostKind === 'admin'}
		<p class="text-sm opacity-80">
			Panel de administración. Los sitios se sirven en
			<code class="font-mono">{data.sitesHost}{data.sitesPrefix}/&lt;slug&gt;/</code>.
		</p>
		<p class="text-sm opacity-60">
			Autenticación y panel llegan en M3. Estado del servicio:
			<a class="underline" href="/healthz">/healthz</a>.
		</p>
	{:else}
		<!-- Deliberately says nothing about which sites exist: listing them would leak
		     the existence of private ones. -->
		<p class="text-sm opacity-80">Host de sitios estáticos.</p>
	{/if}
</main>
