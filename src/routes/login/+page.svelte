<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Sign in — PageBox</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
	<div>
		<h1 class="text-xl font-semibold tracking-tight">PageBox</h1>
		<p class="text-sm opacity-70">
			{data.hostKind === 'admin' ? 'Admin panel' : 'Site access'} · {data.host}
		</p>
	</div>

	<form method="POST" class="flex flex-col gap-3">
		<input type="hidden" name="next" value={data.next} />
		<label class="flex flex-col gap-1 text-sm">
			Email
			<input
				class="rounded border px-2 py-1"
				type="email"
				name="email"
				autocomplete="username"
				value={form?.email ?? ''}
				required
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			Password
			<input
				class="rounded border px-2 py-1"
				type="password"
				name="password"
				autocomplete="current-password"
				required
			/>
		</label>
		{#if form?.message}
			<p class="text-sm text-red-600">{form.message}</p>
		{/if}
		<button class="rounded bg-current/90 px-3 py-1.5 text-sm text-white" type="submit">
			Sign in
		</button>
	</form>
</main>
