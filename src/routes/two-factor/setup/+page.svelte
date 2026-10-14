<script lang="ts">
	import PasswordInput from '$lib/components/PasswordInput.svelte';
	import PageboxMark from '$lib/components/PageboxMark.svelte';
	let { data, form } = $props();
	const enrollment = $derived(!data.enabled && (form?.enrollment || data.pending));
</script>

<svelte:head
	><title>Authenticator — PageBox</title><meta name="robots" content="noindex" /></svelte:head
>

{#snippet setupForm(restart: boolean)}
	<form method="POST" action="?/enable" class="flex flex-col gap-4">
		<label class="field"
			>Current password<PasswordInput
				name="password"
				autocomplete="current-password"
				required
			/></label
		>
		<button class="btn btn-ghost" type="submit"
			>{restart ? 'Generate a new QR code and recovery codes' : 'Set up authenticator'}</button
		>
	</form>
{/snippet}

<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-10">
	<header>
		<p class="eyebrow">PageBox · {data.email}</p>
		<h1 class="text-[1.6rem] font-semibold tracking-tight">Two-factor authentication</h1>
		<p class="text-muted mt-2 text-sm">
			{data.enabled
				? 'Your account is protected with an authenticator app.'
				: 'Protect your account with an authenticator app such as Authy, Google Authenticator or 2FAS.'}
		</p>
	</header>
	{#if data.required}<p class="notice notice-info">
			Your administrator requires two-factor authentication for every account.
		</p>{/if}
	{#if form?.message}<p
			class="notice"
			class:notice-ok={form.ok === true}
			class:notice-info={form.info === true}
			role={form.ok || form.info ? 'status' : 'alert'}
		>
			{form.message}
		</p>{/if}
	{#if form?.qr && !data.enabled}
		<div class="flex flex-col items-center gap-3">
			<div class="flex items-center gap-2">
				<PageboxMark size={24} /><span class="font-semibold">PageBox</span>
			</div>
			<img
				src={form.qr}
				alt="Scan this QR code with your authenticator app"
				width="240"
				height="240"
			/>
			<p class="text-muted text-sm">Or enter this setup key manually:</p>
			<code class="mono break-all select-all">{form.secret}</code>
			<p class="text-muted text-center text-xs">
				Authy chooses its own icon. To change it, open Settings → Accounts → PageBox → Edit logo.
				<a
					class="underline"
					href="https://help.twilio.com/articles/19753405130523"
					target="_blank"
					rel="noreferrer">Authy help</a
				>
			</p>
		</div>
	{/if}
	{#if form?.backupCodes}
		<section class="section">
			<h2 class="font-semibold">Recovery codes</h2>
			<p class="text-muted my-2 text-sm">
				Save these somewhere safe. Each code can replace your authenticator code once. They are only
				shown here.
			</p>
			<ul class="mono grid grid-cols-2 gap-2 select-all">
				{#each form.backupCodes as code}<li>{code}</li>{/each}
			</ul>
			<a
				class="btn btn-ghost mt-3"
				download="pagebox-recovery-codes.txt"
				href={'data:text/plain;charset=utf-8,' +
					encodeURIComponent('PageBox recovery codes\n' + form.backupCodes.join('\n'))}
				>Download recovery codes</a
			>
		</section>
	{/if}
	{#if enrollment}
		<form method="POST" action="?/verify" class="flex flex-col gap-4">
			<label class="field"
				>Authenticator code<input
					class="input mono"
					name="code"
					inputmode="numeric"
					autocomplete="one-time-code"
					pattern={'[0-9]{6}'}
					maxlength="6"
					required
				/></label
			>
			<label class="flex items-center gap-2 text-sm"
				><input class="check" type="checkbox" name="saved" value="yes" required /><span
					>I have saved my recovery codes</span
				></label
			>
			<button class="btn btn-primary" type="submit">Verify and enable</button>
		</form>
	{/if}
	{#if !data.enabled}
		{#if enrollment}
			<details class="section">
				<summary class="text-muted cursor-pointer text-sm">Restart setup</summary>
				<p class="text-muted my-3 text-sm">
					Only restart if you need a new QR code. This replaces the current setup key and recovery
					codes.
				</p>
				{@render setupForm(true)}
			</details>
		{:else}
			{@render setupForm(false)}
		{/if}
	{:else}
		<section class="section" aria-labelledby="manage-authenticator">
			<div class="flex items-center justify-between gap-3">
				<h2 id="manage-authenticator" class="font-semibold">Manage authenticator</h2>
				<span class="tag tag-live">Enabled</span>
			</div>
			<p id="authenticator-actions-help" class="text-muted mt-2 mb-4 text-sm">
				Enter your current password to confirm the action you choose below.
			</p>
			<form
				method="POST"
				action="?/regenerate"
				class="flex flex-col gap-4"
				aria-describedby="authenticator-actions-help"
			>
				<label class="field"
					>Current password<PasswordInput
						name="password"
						autocomplete="current-password"
						required
					/></label
				>
				<div class="flex flex-wrap gap-2">
					<button class="btn btn-ghost" type="submit">Replace recovery codes</button>
					{#if !data.required}
						<button class="btn btn-danger" type="submit" formaction="?/disable"
							>Disable two-factor authentication</button
						>
					{/if}
				</div>
				<p class="text-muted text-xs">Replacing recovery codes invalidates your previous codes.</p>
			</form>
		</section>
	{/if}
	{#if data.enabled || !data.required}
		<a class="btn btn-primary" href={data.next}>Continue</a>
	{/if}
	{#if data.hostKind === 'admin'}<a class="text-muted text-sm underline" href="/account/password"
			>Account and password</a
		>{/if}
	<form method="POST" action="/logout">
		<button class="btn btn-ghost" type="submit">Sign out</button>
	</form>
</main>
