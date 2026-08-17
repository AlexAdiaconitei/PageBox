<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	let { data, form } = $props();
	let adding = $state(false);
	let resetting = $state<string | null>(null);

	const when = (value: string | Date) =>
		new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
</script>

<svelte:head><title>Users — PageBox</title></svelte:head>

<header class="mb-7 flex items-start justify-between gap-4">
	<div>
		<p class="eyebrow">Access</p>
		<h1 class="text-[22px] font-semibold tracking-tight">Users</h1>
		<p class="text-muted mt-1 text-[13px]">Accounts are created here; there is no sign-up page.</p>
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
	<form method="POST" action="?/create" class="card mb-6 grid gap-4 p-4 md:grid-cols-4">
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
			<input class="input mono" name="password" minlength="10" required />
		</label>
		<div class="flex items-end gap-3">
			<label class="field flex-1">
				Role
				<select class="select" name="role">
					<option value="user">user</option>
					<option value="superadmin">superadmin</option>
				</select>
			</label>
			<button class="btn btn-primary" type="submit">Create</button>
		</div>
	</form>
{/if}

<table class="table">
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
				<td>
					{person.email}
					{#if person.isSelf}<span class="text-faint ml-1 text-[12px]">you</span>{/if}
				</td>
				<td class="text-muted">{person.name}</td>
				<td>
					{#if person.isSelf}
						<span class="inline-flex items-center gap-1">
							{#if person.role === 'superadmin'}<ShieldCheck size={12} strokeWidth={1.75} />{/if}
							{person.role}
						</span>
					{:else}
						<form method="POST" action="?/setRole" class="flex items-center gap-1">
							<input type="hidden" name="userId" value={person.id} />
							<select class="select w-32 py-0.5 text-[12.5px]" name="role">
								<option value="user" selected={person.role === 'user'}>user</option>
								<option value="superadmin" selected={person.role === 'superadmin'}>
									superadmin
								</option>
							</select>
							<button class="btn btn-ghost btn-xs" type="submit">Set</button>
						</form>
					{/if}
				</td>
				<td>
					{#if person.banned}
						<span class="tag" style="color: var(--pb-danger)">Suspended</span>
					{:else if person.mustChangePassword}
						<span class="tag">Password pending</span>
					{:else}
						<span class="text-muted text-[13px]">active</span>
					{/if}
				</td>
				<td class="text-muted">{when(person.createdAt)}</td>
				<td class="num">
					{#if !person.isSelf}
						<div class="flex justify-end gap-1">
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => (resetting = resetting === person.id ? null : person.id)}
							>
								Reset password
							</button>
							<form method="POST" action="?/ban">
								<input type="hidden" name="userId" value={person.id} />
								<input type="hidden" name="banned" value={String(person.banned)} />
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
						<form method="POST" action="?/resetPassword" class="flex items-end gap-3">
							<input type="hidden" name="userId" value={person.id} />
							<label class="field w-72 max-w-full">
								New temporary password for {person.email}
								<input class="input mono" name="password" minlength="10" required />
							</label>
							<button class="btn btn-ghost" type="submit">Replace</button>
						</form>
					</td>
				</tr>
			{/if}
		{/each}
	</tbody>
</table>
