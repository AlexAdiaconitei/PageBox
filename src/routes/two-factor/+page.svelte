<script lang="ts">
	let { data, form } = $props();
	let backup = $state(false);
</script>

<svelte:head
	><title>Two-factor authentication — PageBox</title><meta
		name="robots"
		content="noindex"
	/></svelte:head
>

<main class="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6">
	<div>
		<p class="eyebrow">PageBox · Sign in</p>
		<h1 class="text-[1.5rem] font-semibold tracking-tight">Two-factor authentication</h1>
		<p class="text-muted mt-2 text-sm">
			{backup
				? 'Enter one of your saved recovery codes. Each code works once.'
				: 'Enter the 6-digit code from your authenticator app.'}
		</p>
	</div>
	<form method="POST" class="flex flex-col gap-4">
		<input type="hidden" name="next" value={data.next} />
		<input type="hidden" name="method" value={backup ? 'backup' : 'totp'} />
		<label class="field"
			>{backup ? 'Recovery code' : 'Authenticator code'}
			<input
				class="input mono"
				name="code"
				autocomplete="one-time-code"
				inputmode={backup ? 'text' : 'numeric'}
				pattern={backup ? undefined : '[0-9]{6}'}
				maxlength={backup ? 100 : 6}
				required
			/>
		</label>
		{#if form?.message}<p class="notice" role="alert">{form.message}</p>{/if}
		<button class="btn btn-primary justify-center" type="submit">Verify and continue</button>
	</form>
	<button class="btn btn-ghost" type="button" onclick={() => (backup = !backup)}
		>{backup ? 'Use authenticator app' : 'Use a recovery code'}</button
	>
	<a class="text-muted text-sm underline" href="/login">Start sign-in again</a>
</main>
