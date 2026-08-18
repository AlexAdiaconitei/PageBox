<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Change password — PageBox</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-7 px-6">
	<div>
		<p class="eyebrow">Account</p>
		<h1 class="text-[1.2rem] font-semibold tracking-tight">Change password</h1>
		{#if data.forced}
			<p class="text-muted mt-1 text-[0.85rem]">
				This account still uses the password it was created with. Replace it to continue.
			</p>
		{/if}
	</div>

	<form method="POST" class="flex flex-col gap-4">
		<label class="field">
			Current password
			<input
				class="input"
				type="password"
				name="currentPassword"
				autocomplete="current-password"
				required
			/>
		</label>
		<label class="field">
			New password
			<input
				class="input"
				type="password"
				name="newPassword"
				autocomplete="new-password"
				minlength="10"
				required
			/>
		</label>
		<label class="field">
			Repeat new password
			<input
				class="input"
				type="password"
				name="confirm"
				autocomplete="new-password"
				minlength="10"
				required
			/>
		</label>
		{#if form?.message}
			<p class="notice">{form.message}</p>
		{/if}
		<button class="btn btn-primary justify-center" type="submit">Save</button>
	</form>
</main>
