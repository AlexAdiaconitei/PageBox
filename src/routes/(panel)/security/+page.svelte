<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head><title>Security — PageBox</title></svelte:head>
<header class="mb-7">
	<p class="eyebrow">Instance settings</p>
	<h1 class="text-[1.75rem] font-semibold tracking-tight">Security</h1>
</header>
<section class="section max-w-xl">
	<h2 class="text-[1.05rem] font-semibold">Require an authenticator for everyone</h2>
	<p class="text-muted my-3 text-sm">
		When required, every account must set up an authenticator before accessing the panel or private
		sites. Existing sessions must verify a second factor. Users cannot disable their authenticator
		while this policy is active.
	</p>
	{#if !data.canRequire}
		<p class="notice mb-4">
			Set up your own authenticator before making it mandatory for everyone.
		</p>
		<a class="btn btn-ghost mb-4" href="/two-factor/setup?next=/security">Set up authenticator</a>
	{/if}
	<form method="POST" class="flex flex-col gap-4">
		<label class="field"
			>Two-factor policy
			<select class="select" name="required" value={String(data.required)}>
				<option value="false">Optional</option>
				<option value="true" disabled={!data.canRequire}>Required for all users</option>
			</select>
		</label>
		{#if form?.message}<p class="notice" role="status">{form.message}</p>{/if}
		<button class="btn btn-primary" type="submit">Save policy</button>
	</form>
</section>
