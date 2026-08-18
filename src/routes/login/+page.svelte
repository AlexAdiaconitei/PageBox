<script lang="ts">
	import LogIn from '@lucide/svelte/icons/log-in';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Sign in — PageBox</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-7 px-6">
	<div>
		<p class="text-[1.2rem] font-semibold tracking-tight">PageBox</p>
		<p class="eyebrow mt-1">
			{data.hostKind === 'admin' ? 'Admin panel' : 'Site access'} · {data.host}
		</p>
	</div>

	<form method="POST" class="flex flex-col gap-4">
		<input type="hidden" name="next" value={data.next} />
		<label class="field">
			Email
			<input
				class="input"
				type="email"
				name="email"
				autocomplete="username"
				value={form?.email ?? ''}
				required
			/>
		</label>
		<label class="field">
			Password
			<input
				class="input"
				type="password"
				name="password"
				autocomplete="current-password"
				required
			/>
		</label>

		{#if form?.message}
			<p class="notice">{form.message}</p>
		{/if}

		<button class="btn btn-primary justify-center" type="submit">
			<LogIn size={14} strokeWidth={2} />
			Sign in
		</button>
	</form>

	<p class="text-faint text-[0.8rem]">
		{data.hostKind === 'admin'
			? 'Accounts are issued by a superadmin.'
			: 'Signing in here only unlocks the private sites you were granted.'}
	</p>
</main>
