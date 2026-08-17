<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';

	let { data, form } = $props();
	let creating = $state(false);
</script>

<svelte:head><title>Sites — PageBox</title></svelte:head>

<header class="mb-7 flex items-start justify-between gap-4">
	<div>
		<p class="eyebrow">Hosting</p>
		<h1 class="text-[22px] font-semibold tracking-tight">Sites</h1>
		<p class="text-muted mt-1 text-[13px]">
			Served from <span class="mono">{data.sitesHost}{data.sitesPrefix}/&lt;slug&gt;/</span>
		</p>
	</div>
	{#if data.canCreate}
		<button class="btn btn-primary" onclick={() => (creating = !creating)}>
			<Plus size={14} strokeWidth={2} />
			New site
		</button>
	{/if}
</header>

{#if creating || form?.message}
	<form method="POST" action="?/create" class="card mb-6 grid gap-4 p-4 md:grid-cols-4">
		<label class="field">
			Slug
			<input
				class="input mono"
				name="slug"
				placeholder="docs-a"
				value={form?.slug ?? ''}
				required
			/>
		</label>
		<label class="field">
			Name
			<input class="input" name="name" placeholder="Docs A" />
		</label>
		<label class="field">
			Visibility
			<select class="select" name="visibility">
				<option value="private">Private — grants only</option>
				<option value="public">Public — anyone</option>
			</select>
		</label>
		<div class="flex items-end justify-between gap-3">
			<label class="text-muted flex items-center gap-2 text-[13px]">
				<input type="checkbox" name="spaFallback" />
				SPA fallback
			</label>
			<button class="btn btn-primary" type="submit">Create</button>
		</div>
		{#if form?.message}
			<p class="notice md:col-span-4">{form.message}</p>
		{/if}
	</form>
{/if}

{#if data.sites.length === 0}
	<div class="border-line rounded-md border border-dashed px-6 py-12 text-center">
		<p class="text-[14px] font-medium">No sites yet</p>
		<p class="text-muted mt-1 text-[13px]">
			{data.canCreate
				? 'Create one, then push a build to it with a deploy token.'
				: 'Ask a superadmin to grant you access to a site.'}
		</p>
	</div>
{:else}
	<table class="table">
		<thead>
			<tr>
				<th>Site</th>
				<th>Address</th>
				<th>Access</th>
				<th>Your role</th>
				<th class="num">Live</th>
			</tr>
		</thead>
		<tbody>
			{#each data.sites as site (site.id)}
				<tr>
					<td>
						<a class="font-medium hover:underline" href="/sites/{site.slug}">{site.name}</a>
						{#if site.name !== site.slug}
							<span class="mono text-faint ml-2">{site.slug}</span>
						{/if}
					</td>
					<td>
						<a
							class="mono text-muted inline-flex items-center gap-1 hover:underline"
							href={site.url}
							target="_blank"
							rel="noreferrer"
						>
							{site.basePath}
							<ArrowUpRight size={12} strokeWidth={1.75} />
						</a>
					</td>
					<td>
						{#if site.visibility === 'private'}
							<span class="tag tag-private"><Lock size={10} strokeWidth={2} /> Private</span>
						{:else}
							<span class="tag">Public</span>
						{/if}
					</td>
					<td class="text-muted">{site.permission}</td>
					<td class="num">
						{#if site.activeDeploymentId}
							<span class="dot dot-live" title="A deployment is live"></span>
						{:else}
							<span class="text-faint text-[12px]">no deployment</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
