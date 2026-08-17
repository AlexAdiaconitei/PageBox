<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Change password — PageBox</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
	<div>
		<h1 class="text-xl font-semibold tracking-tight">Change password</h1>
		{#if data.forced}
			<p class="text-sm opacity-70">
				This account still uses the password it was created with. Replace it to continue.
			</p>
		{/if}
	</div>

	<form method="POST" class="flex flex-col gap-3">
		<label class="flex flex-col gap-1 text-sm">
			Current password
			<input
				class="rounded border px-2 py-1"
				type="password"
				name="currentPassword"
				autocomplete="current-password"
				required
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			New password
			<input
				class="rounded border px-2 py-1"
				type="password"
				name="newPassword"
				autocomplete="new-password"
				minlength="10"
				required
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			Repeat new password
			<input
				class="rounded border px-2 py-1"
				type="password"
				name="confirm"
				autocomplete="new-password"
				minlength="10"
				required
			/>
		</label>
		{#if form?.message}
			<p class="text-sm text-red-600">{form.message}</p>
		{/if}
		<button class="rounded bg-current/90 px-3 py-1.5 text-sm text-white" type="submit">
			Save
		</button>
	</form>
</main>
