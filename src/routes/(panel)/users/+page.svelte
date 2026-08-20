<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldHalf from '@lucide/svelte/icons/shield-half';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import PasswordInput from '$lib/components/PasswordInput.svelte';

	let { data, form } = $props();
	let adding = $state(false);
	let resetting = $state<string | null>(null);
	let transferring = $state<string | null>(null);

	const when = (value: string | Date) =>
		new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });

	// Only the superadmin can hand the seat over, and only to an admin.
	const canTransferTo = (role: string) => data.canSetRoles && role === 'admin';
</script>

<svelte:head><title>Users — PageBox</title></svelte:head>

<header class="mb-7 flex items-start justify-between gap-4">
	<div>
		<p class="eyebrow">Access</p>
		<h1 class="text-[1.75rem] font-semibold tracking-tight">Users</h1>
		<p class="text-muted mt-1 text-[0.85rem]">
			{data.canSetRoles
				? 'Every account on this instance. There is no sign-up page.'
				: 'The accounts you issued. They are yours to administer, and nobody else’s.'}
		</p>
	</div>
	<button class="btn btn-primary" onclick={() => (adding = !adding)}>
		<UserPlus size={14} strokeWidth={2} />
		Add user
	</button>
</header>

{#if form?.message}
	<p class="notice notice-ok mb-5">{form.message}</p>
{/if}

{#if adding}
	<form
		method="POST"
		action="?/create"
		class="card mb-6 grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4"
	>
		<label class="field">
			Email
			<input class="input" type="email" name="email" required />
		</label>
		<label class="field">
			Name
			<input class="input" name="name" />
		</label>
		<label class="field">
			Temporary password
			<!-- Visible from the start, unlike every other password field here: this one is
			     not a secret being kept but a credential being read out to somebody else, and
			     whoever types it has to be able to check what they typed. -->
			<PasswordInput
				name="password"
				autocomplete="off"
				minlength={10}
				required
				mono
				visible={true}
			/>
		</label>
		<div class="flex items-end gap-3">
			{#if data.canSetRoles}
				<label class="field flex-1">
					Role
					<select class="select" name="role">
						<option value="user">user — per-site grants only</option>
						<option value="admin">admin — own sites and accounts</option>
					</select>
				</label>
			{/if}
			<button class="btn btn-primary" type="submit">Create</button>
		</div>
		{#if !data.canSetRoles}
			<!-- An admin's form has no role field, and the server forces `user` regardless:
			     the tier is closed upwards, so there is nothing here to choose. -->
			<p class="text-muted text-[0.8rem] sm:col-span-2 xl:col-span-4">
				Accounts you create are plain users, and are yours to administer. Only the superadmin seats
				an admin.
			</p>
		{/if}
	</form>
{/if}

<!-- Six columns, two of them controls: below `sm` this stacks into cards, and in the band
     between that and the sidebar it keeps a floor width and scrolls rather than crushing an
     email address into a single-letter column. -->
<div class="overflow-x-auto">
	<table class="table table-stack sm:min-w-[46rem]">
		<thead>
			<tr>
				<th>Email</th>
				<th>Name</th>
				<th>Role</th>
				<th>State</th>
				<th>Added</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.users as person (person.id)}
				<tr>
					<td data-label="Email">
						<span class="flex flex-wrap items-baseline gap-x-1.5">
							<span class="break-words">{person.email}</span>
							{#if person.isSelf}<span class="text-faint text-[0.78rem]">you</span>{/if}
						</span>
					</td>
					<td class="text-muted" data-label="Name">{person.name}</td>
					<td data-label="Role">
						{#if !person.manageable || !data.canSetRoles}
							<!-- The seat, your own row, and everything an admin does not administer:
							     stated, not editable. -->
							<span class="inline-flex items-center gap-1">
								{#if person.role === 'superadmin'}
									<ShieldCheck size={12} strokeWidth={1.75} />
								{:else if person.role === 'admin'}
									<ShieldHalf size={12} strokeWidth={1.75} />
								{/if}
								{person.role}
							</span>
						{:else}
							<form method="POST" action="?/setRole" class="flex items-center gap-1">
								<input type="hidden" name="userId" value={person.id} />
								<select class="select select-xs w-32" name="role">
									<option value="user" selected={person.role === 'user'}>user</option>
									<option value="admin" selected={person.role === 'admin'}>admin</option>
								</select>
								<button class="btn btn-ghost btn-xs" type="submit">Set</button>
							</form>
						{/if}
					</td>
					<td data-label="State">
						{#if person.banned}
							<span class="tag" style="color: var(--pb-danger)">Suspended</span>
						{:else if person.mustChangePassword}
							<span class="tag">Password pending</span>
						{:else}
							<span class="text-muted text-[0.85rem]">active</span>
						{/if}
					</td>
					<td class="text-muted" data-label="Added">{when(person.createdAt)}</td>
					<td class="num">
						{#if person.manageable}
							<div class="flex justify-end gap-1">
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => (resetting = resetting === person.id ? null : person.id)}
								>
									Reset password
								</button>
								{#if canTransferTo(person.role)}
									<button
										class="btn btn-ghost btn-xs"
										onclick={() => (transferring = transferring === person.id ? null : person.id)}
									>
										Hand over seat
									</button>
								{/if}
								<!-- The action names what it does, so a page rendered before someone
								     else changed this row cannot flip it the wrong way. -->
								<form method="POST" action={person.banned ? '?/restore' : '?/suspend'}>
									<input type="hidden" name="userId" value={person.id} />
									<button class="btn btn-danger btn-xs" type="submit">
										{person.banned ? 'Restore' : 'Suspend'}
									</button>
								</form>
							</div>
						{/if}
					</td>
				</tr>
				{#if resetting === person.id}
					<tr>
						<td colspan="6" class="bg-line-soft">
							<form method="POST" action="?/resetPassword" class="flex flex-wrap items-end gap-3">
								<input type="hidden" name="userId" value={person.id} />
								<label class="field w-72 max-w-full">
									New temporary password for {person.email}
									<PasswordInput
										name="password"
										autocomplete="off"
										minlength={10}
										required
										mono
										visible={true}
									/>
								</label>
								<button class="btn btn-ghost" type="submit">Replace</button>
							</form>
						</td>
					</tr>
				{/if}
				{#if transferring === person.id}
					<tr>
						<td colspan="6" class="bg-line-soft">
							<form method="POST" action="?/transferSeat" class="flex flex-wrap items-end gap-3">
								<input type="hidden" name="userId" value={person.id} />
								<div class="w-full">
									<p class="text-[0.85rem] font-medium">
										Hand the superadmin seat to {person.email}
									</p>
									<p class="text-muted mt-1 text-[0.8rem]">
										There is one seat, so you step down to admin in the same moment they take it.
										Your sites and the accounts you issued stay yours. Only they can hand it back.
									</p>
								</div>
								<label class="field w-56 max-w-full">
									Type <span class="mono">transfer</span> to confirm
									<input class="input mono" name="confirm" autocomplete="off" required />
								</label>
								<button class="btn btn-danger" type="submit">Hand over</button>
								<button class="btn btn-ghost" type="button" onclick={() => (transferring = null)}>
									Cancel
								</button>
							</form>
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
</div>
