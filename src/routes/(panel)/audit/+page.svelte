<script lang="ts">
	let { data } = $props();

	const when = (value: string | Date) =>
		new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

	const actor = (entry: { actorEmail: string | null; actorTokenId: string | null }) =>
		entry.actorEmail ?? (entry.actorTokenId ? 'deploy token' : 'anonymous');
</script>

<svelte:head><title>Activity — PageBox</title></svelte:head>

<header class="mb-7 flex items-end justify-between gap-4">
	<div>
		<p class="eyebrow">Record</p>
		<h1 class="text-[22px] font-semibold tracking-tight">Activity</h1>
		<p class="text-muted mt-1 text-[13px]">Every deploy, grant, token and sign-in attempt.</p>
	</div>
	<form method="GET" class="flex items-end gap-2">
		<label class="field w-56">
			Filter by action
			<input
				class="input mono"
				name="action"
				placeholder="deployment.created"
				value={data.action}
			/>
		</label>
		<button class="btn btn-ghost" type="submit">Apply</button>
	</form>
</header>

{#if data.entries.length === 0}
	<p class="text-muted text-[13px]">Nothing recorded for that filter.</p>
{:else}
	<table class="table">
		<thead>
			<tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr>
		</thead>
		<tbody>
			{#each data.entries as entry (entry.id)}
				<tr>
					<td class="text-muted whitespace-nowrap">{when(entry.createdAt)}</td>
					<td>{actor(entry)}</td>
					<td class="mono">{entry.action}</td>
					<td class="mono text-muted">
						{entry.targetType ? `${entry.targetType}:${entry.targetId?.slice(0, 10) ?? ''}` : '—'}
					</td>
					<td class="text-faint mono truncate">{entry.meta ? JSON.stringify(entry.meta) : ''}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
