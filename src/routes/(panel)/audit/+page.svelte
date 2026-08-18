<script lang="ts">
	let { data } = $props();

	const when = (value: string | Date) =>
		new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

	const actor = (entry: { actorEmail: string | null; actorTokenId: string | null }) =>
		entry.actorEmail ?? (entry.actorTokenId ? 'deploy token' : 'anonymous');

	const detail = (entry: { targetType: string | null; targetId: string | null }) =>
		entry.targetType ? `${entry.targetType}:${entry.targetId?.slice(0, 10) ?? ''}` : '—';
</script>

<svelte:head><title>Activity — PageBox</title></svelte:head>

<header class="mb-7 flex flex-wrap items-end justify-between gap-4">
	<div>
		<p class="eyebrow">Record</p>
		<h1 class="text-[1.75rem] font-semibold tracking-tight">Activity</h1>
		<p class="text-muted mt-1 text-[0.85rem]">Every deploy, grant, token and sign-in attempt.</p>
	</div>
	<form method="GET" class="flex w-full flex-wrap items-end gap-2 sm:w-auto">
		<label class="field min-w-36 flex-1 sm:max-w-44">
			Action
			<select class="select" name="action">
				<option value="">Any action</option>
				{#each data.actions as option (option)}
					<option value={option} selected={option === data.action}>{option}</option>
				{/each}
			</select>
		</label>
		<label class="field min-w-44 flex-1 sm:max-w-56">
			Search
			<input
				class="input mono"
				type="search"
				name="q"
				placeholder="actor, target, ip…"
				value={data.q}
			/>
		</label>
		<button class="btn btn-ghost" type="submit">Apply</button>
	</form>
</header>

{#if data.entries.length === 0}
	<p class="text-muted text-[0.85rem]">Nothing recorded for that filter.</p>
{:else}
	<div class="overflow-x-auto">
		<table class="table min-w-[860px]">
			<thead>
				<tr>
					<th class="w-40">When</th>
					<th class="w-48">Actor</th>
					<th class="w-44">Action</th>
					<th class="w-36">Target</th>
					<th>Detail</th>
				</tr>
			</thead>
			<tbody>
				{#each data.entries as entry (entry.id)}
					<tr>
						<td class="text-muted whitespace-nowrap">{when(entry.createdAt)}</td>
						<td class="max-w-[12rem] truncate" title={actor(entry)}>{actor(entry)}</td>
						<td class="mono">{entry.action}</td>
						<td class="mono text-muted whitespace-nowrap">{detail(entry)}</td>
						<td
							class="text-faint mono max-w-xs truncate"
							title={entry.meta ? JSON.stringify(entry.meta) : ''}
						>
							{entry.meta ? JSON.stringify(entry.meta) : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
