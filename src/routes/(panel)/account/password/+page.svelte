<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldHalf from '@lucide/svelte/icons/shield-half';
	import PasswordInput from '$lib/components/PasswordInput.svelte';

	let { data, form } = $props();

	/**
	 * One toggle for the two new-password fields, none for the current one.
	 *
	 * They are meant to match, so reading one and not the other proves nothing; the current
	 * password is a different question — it is being recalled, not composed — and gets its
	 * own switch.
	 */
	let showNew = $state(false);
</script>

<svelte:head><title>Account — PageBox</title></svelte:head>

<header class="mb-7">
	<p class="eyebrow">Account</p>
	<h1 class="text-[1.75rem] font-semibold tracking-tight">{data.user.email}</h1>
	<p class="text-muted mt-1 flex flex-wrap items-center gap-x-2 text-[0.85rem]">
		{#if data.user.role === 'superadmin'}
			<span class="inline-flex items-center gap-1">
				<ShieldCheck size={12} strokeWidth={1.75} /> Superadmin
			</span>
		{:else if data.user.role === 'admin'}
			<span class="inline-flex items-center gap-1">
				<ShieldHalf size={12} strokeWidth={1.75} /> Admin
			</span>
		{:else}
			<span>User</span>
		{/if}
		<span class="text-faint">·</span>
		<span>signed in on <span class="mono">{data.adminHost}</span></span>
	</p>
</header>

{#if data.forced}
	<!-- The reason every other screen bounced back here. Said once, at the top, rather than
	     as a caveat beside the submit button. -->
	<div class="notice mb-6">
		<p class="font-medium">This account still uses the password it was issued with</p>
		<p class="text-muted mt-1 text-[0.85rem]">
			A handover credential is known to whoever created the account. Nothing else in the panel opens
			until it has been replaced.
		</p>
	</div>
{/if}

<section class="section">
	<h2 class="mb-3 text-[1.05rem] font-semibold">Password</h2>
	<p class="text-muted mb-4 text-[0.85rem]">
		Changing it signs out every other session on this account — a password is replaced because it
		might be known, and a session that outlives it defeats the point.
	</p>

	<form method="POST" class="flex max-w-sm flex-col gap-4">
		<label class="field">
			Current password
			<PasswordInput name="currentPassword" autocomplete="current-password" required />
		</label>
		<label class="field">
			New password
			<PasswordInput
				name="newPassword"
				autocomplete="new-password"
				minlength={10}
				required
				bind:visible={showNew}
			/>
		</label>
		<label class="field">
			Repeat new password
			<PasswordInput
				name="confirm"
				autocomplete="new-password"
				minlength={10}
				required
				bind:visible={showNew}
			/>
		</label>
		<p class="text-faint text-[0.8rem]">At least 10 characters.</p>

		{#if form?.message}
			<p class="notice" class:notice-ok={form.ok}>{form.message}</p>
		{/if}
		<div>
			<button class="btn btn-primary" type="submit">Change password</button>
		</div>
	</form>
</section>
