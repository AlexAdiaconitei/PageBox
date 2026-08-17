<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import History from '@lucide/svelte/icons/history';
	import Lock from '@lucide/svelte/icons/lock';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Users from '@lucide/svelte/icons/users';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Dropzone from '$lib/components/Dropzone.svelte';

	let { data, form } = $props();

	const bytes = (n: number) => {
		const units = ['B', 'KB', 'MB', 'GB'];
		let value = n;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${Math.round(value * 10) / 10} ${units[unit]}`;
	};

	// ULIDs are 26 characters and every one of them is noise in a list: the prefix is
	// enough to tell rows apart, the full value stays in the tooltip and in the API.
	const shortId = (id: string) => id.slice(0, 12);

	// Written out with this site's own slug and base path, so it can be pasted as is.
	const deployRecipe = $derived(`# 1. build against the base path this site is served under
#    Docusaurus baseUrl · Next basePath + assetPrefix · Vite/Astro base · SvelteKit paths.base
SITE_BASE_PATH=${data.site.basePath} npm run build

# 2. zip the output and upload it
(cd dist && zip -qr ../site.zip .)
curl -sfS -X POST ${data.adminOrigin}/api/v1/sites/${data.site.slug}/deployments \\
  -H "Authorization: Bearer $PAGEBOX_TOKEN" \\
  -H "Content-Type: application/zip" \\
  --data-binary @site.zip`);

	const when = (value: string | Date | null) =>
		value
			? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
			: '—';
</script>

<svelte:head><title>{data.site.slug} — PageBox</title></svelte:head>

<header class="mb-7">
	<a class="text-muted text-[13px] hover:underline" href="/sites">Sites</a>
	<div class="mt-1 flex flex-wrap items-center gap-3">
		<h1 class="text-[22px] font-semibold tracking-tight">{data.site.name}</h1>
		{#if data.site.visibility === 'private'}
			<span class="tag tag-private"><Lock size={10} strokeWidth={2} /> Private</span>
		{:else}
			<span class="tag">Public</span>
		{/if}
	</div>
	<p class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
		<a
			class="mono inline-flex items-center gap-1 hover:underline"
			href={data.site.url}
			target="_blank"
			rel="noreferrer"
		>
			{data.site.url}
			<ArrowUpRight size={12} strokeWidth={1.75} />
		</a>
		<span class="text-muted">
			build with base path <span class="mono">{data.site.basePath}</span>
		</span>
	</p>
</header>

{#if form?.message}
	<p class="notice notice-ok mb-5">{form.message}</p>
{/if}

{#if form?.token}
	<div class="notice notice-ok mb-5">
		<p class="font-medium">Token “{form.tokenName}” created — copy it now</p>
		<p class="mono mt-1 break-all">{form.token}</p>
		<p class="text-muted mt-1 text-[12px]">
			Only its hash is stored. If it is lost, issue a new one.
		</p>
	</div>
{/if}

{#if data.canDeploy}
	<section class="section">
		<Dropzone
			slug={data.site.slug}
			basePath={data.site.basePath}
			maxFiles={data.limits.maxFiles}
			maxBytes={data.limits.maxBrowserBytes}
		/>
	</section>
{/if}

<section class="section">
	<div class="mb-3 flex items-center gap-2">
		<History size={15} strokeWidth={1.75} class="text-faint" />
		<h2 class="text-[15px] font-semibold">Deployments</h2>
	</div>

	{#if data.deployments.length === 0}
		<p class="text-muted text-[13px]">Nothing deployed yet — the recipe is below.</p>
	{:else}
		<table class="table">
			<thead>
				<tr>
					<th></th>
					<th>Deployment</th>
					<th>Created</th>
					<th>Source</th>
					<th class="num">Files</th>
					<th class="num">Size</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.deployments as deployment (deployment.id)}
					<tr>
						<td>
							<span
								class="dot"
								class:dot-live={deployment.live}
								class:dot-failed={deployment.status === 'failed'}
								class:dot-uploading={deployment.status === 'uploading'}
							></span>
						</td>
						<td>
							<span class="mono" title={deployment.id}>{shortId(deployment.id)}</span>
							{#if deployment.live}<span class="tag tag-live ml-2">Live</span>{/if}
							{#if deployment.status !== 'ready'}
								<span class="tag ml-2">{deployment.status}</span>
							{/if}
							{#if deployment.notes}
								<span class="text-faint ml-2 text-[12px]">{deployment.notes}</span>
							{/if}
							{#if deployment.brokenAssetCount}
								<span
									class="tag ml-2"
									style="color: var(--pb-warn)"
									title="Assets referenced by index.html that are not in this deployment"
								>
									{deployment.brokenAssetCount} broken
								</span>
							{/if}
						</td>
						<td class="text-muted">{when(deployment.createdAt)}</td>
						<td class="text-muted">{deployment.source}</td>
						<td class="num">{deployment.fileCount}</td>
						<td class="num">{bytes(deployment.totalBytes)}</td>
						<td class="num">
							<div class="flex justify-end gap-1">
								{#if !deployment.live && deployment.status === 'ready'}
									<form method="POST" action="?/activate">
										<input type="hidden" name="deploymentId" value={deployment.id} />
										<button class="btn btn-ghost btn-xs" type="submit">Make live</button>
									</form>
								{/if}
								{#if !deployment.live}
									<form method="POST" action="?/deleteDeployment">
										<input type="hidden" name="deploymentId" value={deployment.id} />
										<button class="btn btn-danger btn-xs" type="submit" title="Delete">
											<Trash2 size={12} strokeWidth={1.75} />
										</button>
									</form>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<details class="mt-5">
	<summary class="text-muted cursor-pointer text-[13px]">How to deploy to this site</summary>
	<pre
		class="mono border-line text-muted mt-3 overflow-x-auto rounded border p-3 text-[12px] leading-relaxed">{deployRecipe}</pre>
</details>

{#if data.canManage}
	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<Users size={15} strokeWidth={1.75} class="text-faint" />
			<h2 class="text-[15px] font-semibold">Access</h2>
		</div>
		<p class="text-muted mb-3 text-[13px]">
			{data.site.visibility === 'private'
				? 'Only the people and groups below can read this site.'
				: 'This site is public to read; grants below control who can deploy and manage it.'}
		</p>

		{#if data.grants.length > 0}
			<table class="table mb-4">
				<thead>
					<tr><th>Principal</th><th>Kind</th><th>Role</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.grants as grant (grant.id)}
						<tr>
							<td class="mono">{grant.principalName}</td>
							<td class="text-muted">{grant.principalType}</td>
							<td>{grant.role}</td>
							<td class="num">
								<form method="POST" action="?/removeGrant">
									<input type="hidden" name="grantId" value={grant.id} />
									<button class="btn btn-danger btn-xs" type="submit">Remove</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<form method="POST" action="?/addGrant" class="flex flex-wrap items-end gap-3">
			<label class="field w-80 max-w-full">
				Person or group
				<select class="select" name="principal">
					{#each data.users as person (person.id)}
						<option value="user:{person.id}">{person.email}</option>
					{/each}
					{#each data.groups as group (group.id)}
						<option value="group:{group.id}">group · {group.slug}</option>
					{/each}
				</select>
			</label>
			<label class="field w-44">
				Role
				<select class="select" name="role">
					<option value="viewer">viewer — read</option>
					<option value="deployer">deployer — read + deploy</option>
					<option value="owner">owner — everything</option>
				</select>
			</label>
			<button class="btn btn-ghost" type="submit">Grant access</button>
		</form>
	</section>

	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<KeyRound size={15} strokeWidth={1.75} class="text-faint" />
			<h2 class="text-[15px] font-semibold">Deploy tokens</h2>
		</div>

		{#if data.tokens.length > 0}
			<table class="table mb-4">
				<thead>
					<tr>
						<th>Name</th>
						<th>Starts with</th>
						<th>Last used</th>
						<th class="num">Requests</th>
						<th>Expires</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.tokens as token (token.id)}
						<tr>
							<td>{token.name}</td>
							<td class="mono text-muted">{token.prefix}…</td>
							<td class="text-muted">{when(token.lastUsedAt)}</td>
							<td class="num text-muted">{token.requestCount}</td>
							<td class="text-muted">{token.expiresAt ? when(token.expiresAt) : 'never'}</td>
							<td class="num">
								<form method="POST" action="?/revokeToken">
									<input type="hidden" name="tokenId" value={token.id} />
									<button class="btn btn-danger btn-xs" type="submit">Revoke</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<form method="POST" action="?/createToken" class="flex flex-wrap items-end gap-3">
			<label class="field w-80 max-w-full">
				Name
				<input class="input" name="name" placeholder="github actions" />
			</label>
			<label class="field w-44">
				Expires in
				<select class="select" name="expiresInDays">
					<option value="0">never</option>
					<option value="90">90 days</option>
					<option value="365">a year</option>
				</select>
			</label>
			<button class="btn btn-ghost" type="submit">Issue token</button>
		</form>
	</section>

	<section class="section">
		<h2 class="mb-3 text-[15px] font-semibold">Settings</h2>
		<form method="POST" action="?/settings" class="flex flex-wrap items-end gap-3">
			<label class="field w-80 max-w-full">
				Name
				<input class="input" name="name" value={data.site.name} />
			</label>
			<label class="field w-52">
				Visibility
				<select class="select" name="visibility">
					<option value="private" selected={data.site.visibility === 'private'}>Private</option>
					<option value="public" selected={data.site.visibility === 'public'}>Public</option>
				</select>
			</label>
			<label class="text-muted flex items-center gap-2 pb-1.5 text-[13px]">
				<input type="checkbox" name="spaFallback" checked={data.site.spaFallback} />
				SPA fallback
			</label>
			<button class="btn btn-ghost" type="submit">Save</button>
		</form>
	</section>
{/if}
