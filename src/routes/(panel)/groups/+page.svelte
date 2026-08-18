<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import Combobox from '$lib/components/Combobox.svelte';

	let { data, form } = $props();
	let creating = $state(false);
</script>

<svelte:head><title>Groups — PageBox</title></svelte:head>

<header class="mb-7 flex items-start justify-between gap-4">
	<div>
		<p class="eyebrow">Access</p>
		<h1 class="text-[1.75rem] font-semibold tracking-tight">Groups</h1>
		<p class="text-muted mt-1 text-[0.85rem]">
			Grant a site to a group once instead of to each person.
		</p>
	</div>
	{#if data.canManage}
		<button class="btn btn-primary" onclick={() => (creating = !creating)}>
			<Plus size={14} strokeWidth={2} />
			New group
		</button>
	{/if}
</header>

{#if form?.message}
	<p class="notice notice-ok mb-5">{form.message}</p>
{/if}

{#if creating}
	<form method="POST" action="?/create" class="card mb-6 flex flex-wrap items-end gap-3 p-4">
		<label class="field w-56 max-w-full">
			Slug
			<input class="input mono" name="slug" placeholder="docs-readers" required />
		</label>
		<label class="field w-56 max-w-full">
			Name
			<input class="input" name="name" placeholder="Docs readers" />
		</label>
		<button class="btn btn-primary" type="submit">Create</button>
	</form>
{/if}

{#if data.groups.length === 0}
	<div class="border-line rounded-md border border-dashed px-6 py-12 text-center">
		<p class="text-[0.95rem] font-medium">No groups yet</p>
		<p class="text-muted mt-1 text-[0.85rem]">
			Groups are optional; grants can name people directly.
		</p>
	</div>
{:else}
	<div class="flex flex-col gap-6">
		{#each data.groups as group (group.id)}
			<section class="card p-4">
				<div class="flex items-baseline gap-2">
					<h2 class="text-[1.05rem] font-semibold">{group.name}</h2>
					<span class="mono text-faint">{group.slug}</span>
					<span class="text-faint ml-auto text-[0.78rem]">
						{group.members.length}
						{group.members.length === 1 ? 'member' : 'members'}
					</span>
				</div>

				{#if group.members.length > 0}
					<ul class="mt-3 flex flex-wrap gap-2">
						{#each group.members as member (member.userId)}
							<li
								class="border-line flex items-center gap-1.5 rounded border px-2 py-0.5 text-[0.85rem]"
							>
								{member.email}
								{#if data.canManage}
									<form method="POST" action="?/removeMember">
										<input type="hidden" name="groupId" value={group.id} />
										<input type="hidden" name="userId" value={member.userId} />
										<button
											class="text-faint hover:text-[color:var(--pb-danger)]"
											type="submit"
											title="Remove {member.email}"
										>
											<X size={12} strokeWidth={2} />
										</button>
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if data.canManage}
					<form method="POST" action="?/addMember" class="mt-4 flex flex-wrap items-end gap-3">
						<input type="hidden" name="groupId" value={group.id} />
						<label class="field w-72 max-w-full">
							Add member
							<Combobox
								name="userId"
								options={data.users.map((person) => ({ value: person.id, label: person.email }))}
								placeholder="Search people…"
							/>
						</label>
						<button class="btn btn-ghost" type="submit">Add</button>
					</form>
				{/if}
			</section>
		{/each}
	</div>
{/if}
