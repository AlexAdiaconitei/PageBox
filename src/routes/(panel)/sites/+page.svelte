<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import Lock from '@lucide/svelte/icons/lock';
	import PowerOff from '@lucide/svelte/icons/power-off';
	import Plus from '@lucide/svelte/icons/plus';
	import { formatBytes, fullDate, timeAgo } from '$lib/format';

	let { data, form } = $props();
	let creating = $state(false);

	/**
	 * The overview. Six figures, and every one of them is something an operator does
	 * something about: how much there is to look after, how much of it is actually serving,
	 * how much is dark, how much somebody switched off, what the live builds weigh and what
	 * the whole fleet occupies. Nothing here is a restatement of the table below — the table
	 * says which sites, the strip says how the fleet stands.
	 */
	const fleet = $derived.by(() => {
		// "Live" is now two conditions, not one: a site serves when it has a build *and*
		// nobody has switched it off. Counting the second as live is how a suspended site
		// stays invisible on the screen whose job is to say what is up.
		const live = data.sites.filter((entry) => entry.activeDeploymentId !== null && !entry.disabled);
		const off = data.sites.filter((entry) => entry.disabled);
		return {
			total: data.sites.length,
			live: live.length,
			dark: data.sites.length - live.length - off.length,
			off: off.length,
			bytes: live.reduce((sum, entry) => sum + (entry.liveBytes ?? 0), 0),
			// Everything the fleet holds, live builds and history alike — the figure that
			// grows while "Serving" stays flat, and the one a retention limit answers.
			storedBytes: data.sites.reduce((sum, entry) => sum + entry.storedBytes, 0)
		};
	});
</script>

<svelte:head><title>Sites — PageBox</title></svelte:head>

<header class="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
	<div class="min-w-0">
		<p class="eyebrow">Hosting</p>
		<h1 class="text-[1.75rem] font-semibold tracking-tight">Sites</h1>
		<p class="text-muted mt-1 text-[0.85rem]">
			Served from <span class="mono break-all"
				>{data.sitesHost}{data.sitesPrefix}/&lt;slug&gt;/</span
			>
		</p>
	</div>
	{#if data.canCreate}
		<button class="btn btn-primary" onclick={() => (creating = !creating)}>
			<Plus size={14} strokeWidth={2} />
			New site
		</button>
	{/if}
</header>

{#if data.sites.length > 0}
	<div class="figures mb-6">
		<div class="figure">
			<span class="eyebrow">Sites</span>
			<span class="figure-value">{fleet.total}</span>
		</div>
		<div class="figure figure-live">
			<span class="eyebrow">Live</span>
			<span class="figure-value">{fleet.live}</span>
		</div>
		<div class="figure figure-dark" data-zero={fleet.dark === 0}>
			<span class="eyebrow">No deployment</span>
			<span class="figure-value">{fleet.dark}</span>
		</div>
		<div class="figure figure-dark" data-zero={fleet.off === 0}>
			<span class="eyebrow">Disabled</span>
			<span class="figure-value">{fleet.off}</span>
		</div>
		<div class="figure">
			<span class="eyebrow">Serving</span>
			<span class="figure-value">{formatBytes(fleet.bytes)}</span>
		</div>
		<div class="figure" title="Every deployment still stored, not just the live ones">
			<span class="eyebrow">Stored</span>
			<span class="figure-value">{formatBytes(fleet.storedBytes)}</span>
		</div>
	</div>
{/if}

{#if creating || form?.message}
	<form
		method="POST"
		action="?/create"
		class="card mb-6 grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4"
	>
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
		<label class="field">
			Keep last N deployments
			<input
				class="input"
				type="number"
				name="retentionLimit"
				min={data.retention.min}
				max={data.retention.max}
				placeholder="all"
				inputmode="numeric"
			/>
		</label>
		<div class="flex items-end justify-between gap-3">
			<label class="text-muted flex items-center gap-2 text-[0.85rem]">
				<input class="check" type="checkbox" name="spaFallback" />
				SPA fallback
			</label>
			<button class="btn btn-primary" type="submit">Create</button>
		</div>
		<!-- Said at the point of setting it, not discovered later in the audit trail: this
		     field deletes builds. Empty keeps everything, which is the old behaviour. -->
		<p class="text-muted text-[0.8rem] sm:col-span-2 xl:col-span-4">
			Every deployment is a full copy of the build. With a limit set, each upload deletes the oldest
			ones past it — never the live one, and you are told what went. Leave it empty to keep
			everything.
		</p>
		{#if form?.message}
			<p class="notice sm:col-span-2 xl:col-span-4">{form.message}</p>
		{/if}
	</form>
{/if}

{#if data.sites.length === 0}
	<div class="border-line rounded-md border border-dashed px-6 py-12 text-center">
		<p class="text-[0.95rem] font-medium">No sites yet</p>
		<p class="text-muted mt-1 text-[0.85rem]">
			{data.canCreate
				? 'Create one, then push a build to it with a deploy token.'
				: 'Ask a superadmin to grant you access to a site.'}
		</p>
	</div>
{:else}
	<div class="overflow-x-auto">
		<table class="table table-stack sm:min-w-[38rem]">
			<thead>
				<tr>
					<th>Site</th>
					<th>Address</th>
					<th>Access</th>
					<th>Your role</th>
					<th class="num">Stored</th>
					<th class="num">Live</th>
				</tr>
			</thead>
			<tbody>
				{#each data.sites as site (site.id)}
					<tr>
						<td data-label="Site">
							<span class="flex flex-wrap items-baseline gap-x-2">
								{#if site.permission === 'viewer'}
									<!-- A viewer cannot open the management screen (deployments, grants,
								     tokens) — it 404s for them — so this goes straight to the site. -->
									<a
										class="inline-flex items-center gap-1 font-medium hover:underline"
										href={site.url}
										target="_blank"
										rel="noreferrer"
									>
										{site.name}
										<ArrowUpRight size={12} strokeWidth={1.75} class="text-faint" />
									</a>
								{:else}
									<a class="font-medium hover:underline" href="/sites/{site.slug}">{site.name}</a>
								{/if}
								{#if site.name !== site.slug}
									<span class="mono text-faint">{site.slug}</span>
								{/if}
							</span>
						</td>
						<td data-label="Address">
							<a
								class="mono text-muted inline-flex items-center gap-1 break-all hover:underline"
								href={site.url}
								target="_blank"
								rel="noreferrer"
							>
								{site.basePath}
								<ArrowUpRight size={12} strokeWidth={1.75} class="shrink-0" />
							</a>
						</td>
						<td data-label="Access">
							<span class="flex flex-wrap items-center gap-1.5">
								{#if site.visibility === 'private'}
									<span class="tag tag-private"><Lock size={10} strokeWidth={2} /> Private</span>
								{:else}
									<span class="tag">Public</span>
								{/if}
								{#if site.disabled}
									<span class="tag" style="color: var(--pb-danger)" title="Serving is switched off">
										<PowerOff size={10} strokeWidth={2} /> Off
									</span>
								{/if}
							</span>
						</td>
						<td class="text-muted" data-label="Your role">{site.permission}</td>
						<td
							class="num text-muted whitespace-nowrap"
							data-label="Stored"
							title="{site.deploymentCount} deployment(s) stored{site.retentionLimit
								? `, keeping the last ${site.retentionLimit}`
								: ''}"
						>
							{formatBytes(site.storedBytes)}
						</td>
						<td class="num" data-label="Live">
							{#if site.disabled}
								<!-- It has a build and still answers nothing: saying "no deployment" here
							     would send an operator looking for the wrong problem. -->
								<span
									class="inline-flex items-center gap-2"
									style="color: var(--pb-danger)"
									title="Disabled — the build is still here, the site answers 404"
								>
									<span class="dot dot-failed"></span>
									disabled
								</span>
							{:else if site.activeDeploymentId}
								<!-- One column for two facts that are only useful together: it is up, and
							     this is how long the build it is serving has been there. -->
								<span
									class="inline-flex items-center gap-2"
									title="Live since {fullDate(site.liveAt)}{site.liveFileCount !== null
										? ` · ${site.liveFileCount} files · ${formatBytes(site.liveBytes ?? 0)}`
										: ''}"
								>
									<span class="dot dot-live"></span>
									{timeAgo(site.liveAt)}
								</span>
							{:else}
								<span class="text-faint">no deployment</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
