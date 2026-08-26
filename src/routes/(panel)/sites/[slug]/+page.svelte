<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import History from '@lucide/svelte/icons/history';
	import Lock from '@lucide/svelte/icons/lock';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Users from '@lucide/svelte/icons/users';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Power from '@lucide/svelte/icons/power';
	import PowerOff from '@lucide/svelte/icons/power-off';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import Dropzone from '$lib/components/Dropzone.svelte';
	import Combobox from '$lib/components/Combobox.svelte';
	import { formatBytes, fullDate, timeAgo } from '$lib/format';
	import { GENERATOR_RECIPES } from '$lib/preflight';

	let { data, form } = $props();

	// The kind rides in its own column rather than being glued onto the label: it reads as a
	// column, and typing "group" narrows to the groups.
	const principalOptions = $derived([
		...data.users.map((person) => ({
			value: `user:${person.id}`,
			label: person.email,
			hint: 'person'
		})),
		...data.groups.map((group) => ({
			value: `group:${group.id}`,
			label: group.slug,
			hint: 'group'
		}))
	]);

	// ULIDs are 26 characters and every one of them is noise in a list: the prefix is
	// enough to tell rows apart, the full value stays in the tooltip and in the API.
	const shortId = (id: string) => id.slice(0, 12);

	// The delete form stays folded away until asked for: it is the one control on this page
	// that nothing undoes, and a page that opens with it showing invites the accident.
	let deleting = $state(false);
	let handingOver = $state(false);

	const liveDeployment = $derived(data.deployments.find((entry) => entry.live));
	const prunableBytes = $derived(
		data.storage.nextPrune.reduce((sum, entry) => sum + entry.totalBytes, 0)
	);

	/**
	 * Step one, per generator, with this site's own path already in it.
	 *
	 * Every tool spells the option differently and disagrees about the slashes, so the thing
	 * worth handing someone is not "set your base path" — it is the line for *their* tool
	 * with *this* site's value in it, and a link to the page that says so officially.
	 * `$lib/preflight` owns the table; the drop area's warning reads the same rows.
	 */
	const recipes = $derived(
		GENERATOR_RECIPES.map((recipe) => ({
			...recipe,
			snippet: recipe.snippet({ basePath: data.site.basePath, url: data.site.url }),
			upload: `# build, then zip what it produced
(cd ${recipe.output} && zip -qr ../site.zip .)

curl -sfS -X POST ${data.adminOrigin}/api/v1/sites/${data.site.slug}/deployments \\
  -H "Authorization: Bearer $PAGEBOX_TOKEN" \\
  -H "Content-Type: application/zip" \\
  --data-binary @site.zip`
		}))
	);

	// The tabs are radio inputs, so the panel switches with no JavaScript at all and the
	// arrow keys work because that is what a radio group already does. Unique per site so
	// two of these on one page could never share a group.
	const tabGroup = $derived(`gen-${data.site.slug}`);
</script>

<svelte:head><title>{data.site.slug} — PageBox</title></svelte:head>

<header class="mb-7">
	<a class="text-muted text-[0.85rem] hover:underline" href="/sites">Sites</a>
	<div class="mt-1 flex flex-wrap items-center gap-3">
		<h1 class="text-[1.75rem] font-semibold tracking-tight">{data.site.name}</h1>
		{#if data.site.visibility === 'private'}
			<span class="tag tag-private"><Lock size={10} strokeWidth={2} /> Private</span>
		{:else}
			<span class="tag">Public</span>
		{/if}
		{#if data.site.disabled}
			<span class="tag" style="color: var(--pb-danger)">
				<PowerOff size={10} strokeWidth={2} /> Disabled
			</span>
		{/if}
	</div>
	<p class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.85rem]">
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

{#if data.site.disabled}
	<!-- The one thing that explains every other panel on this screen: the deployment list
	     says "live", the address is a link, and neither of them is serving a byte. -->
	<div class="notice mb-5">
		<p class="font-medium">This site is switched off</p>
		<p class="text-muted mt-1 text-[0.85rem]">
			Every request answers 404, for everyone — visibility and grants do not enter into it. Nothing
			was deleted: turning it back on serves the same build.
			{#if data.site.disabledReason}
				<span class="block">Reason: {data.site.disabledReason}</span>
			{/if}
			{#if data.site.disabledAt}
				<span class="block">Off since {fullDate(data.site.disabledAt)}.</span>
			{/if}
		</p>
	</div>
{/if}

{#if form?.token}
	<div class="notice notice-ok mb-5">
		<p class="font-medium">Token “{form.tokenName}” created — copy it now</p>
		<p class="mono mt-1 break-all">{form.token}</p>
		<p class="text-muted mt-1 text-[0.78rem]">
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
			retention={{
				limit: data.site.retentionLimit,
				prunableBytes,
				prunable: data.storage.nextPrune.map((entry) => shortId(entry.id))
			}}
			quotaRemaining={data.quota?.remaining ?? null}
		/>
	</section>
{/if}

<!-- What the site weighs, which is not what it serves: the live build is one of the
     copies under "Stored", and the gap between the two is what the retention limit is for. -->
<div class="figures mb-6">
	<div class="figure">
		<span class="eyebrow">Stored</span>
		<span class="figure-value">{formatBytes(data.storage.bytes)}</span>
	</div>
	<div class="figure">
		<span class="eyebrow">Deployments</span>
		<span class="figure-value">{data.storage.deployments}</span>
	</div>
	<div class="figure">
		<span class="eyebrow">Live build</span>
		<span class="figure-value">{formatBytes(liveDeployment?.totalBytes ?? 0)}</span>
	</div>
	<div
		class="figure"
		title={data.site.retentionLimit
			? `Each upload deletes what falls past the newest ${data.site.retentionLimit}`
			: 'Every deployment is kept until somebody deletes it'}
	>
		<span class="eyebrow">Keeping</span>
		<span class="figure-value">{data.site.retentionLimit ?? 'all'}</span>
	</div>
	{#if data.quota}
		<!-- Charged to the site's owner, not to whoever deploys: a deployer granted access to
		     somebody else's site spends that owner's allowance, because it is their bucket
		     space the build sits in. -->
		<div
			class="figure"
			title="{data.owner?.email} has {formatBytes(data.quota.used)} of {formatBytes(
				data.quota.limit
			)} in use across every site they own"
		>
			<span class="eyebrow">Owner's room</span>
			<span class="figure-value" class:text-[color:var(--pb-danger)]={data.quota.over}>
				{formatBytes(data.quota.remaining)}
			</span>
		</div>
	{/if}
</div>

{#if data.quota?.over}
	<p class="notice mb-5">
		<span class="font-medium">{data.owner?.email} is over their storage quota</span> —
		{formatBytes(data.quota.used)} held against {formatBytes(data.quota.limit)}. Everything keeps
		serving and nothing has been deleted, but uploads to their sites are refused until they are back
		under it: delete old deployments, or lower a retention limit.
	</p>
{/if}

<section class="section">
	<div class="mb-3 flex items-center gap-2">
		<History size={15} strokeWidth={1.75} class="text-faint" />
		<h2 class="text-[1.05rem] font-semibold">Deployments</h2>
	</div>

	{#if data.deployments.length === 0}
		<p class="text-muted text-[0.85rem]">Nothing deployed yet — the recipe is below.</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="table table-stack sm:min-w-[44rem]">
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
							<td class="stack-drop">
								<span
									class="dot"
									class:dot-live={deployment.live}
									class:dot-failed={deployment.status === 'failed'}
									class:dot-uploading={deployment.status === 'uploading'}
								></span>
							</td>
							<td data-label="Deployment">
								<!-- Id and state travel together: as a flex row they wrap as a group rather
							     than dropping a lone "Live" onto the next line. -->
								<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
									<span class="mono" title={deployment.id}>{shortId(deployment.id)}</span>
									{#if deployment.live}<span class="tag tag-live">Live</span>{/if}
									{#if deployment.status !== 'ready'}
										<span class="tag">{deployment.status}</span>
									{/if}
									{#if deployment.brokenAssetCount}
										<span
											class="tag"
											style="color: var(--pb-warn)"
											title="Assets referenced by index.html that are not in this deployment"
										>
											{deployment.brokenAssetCount} broken
										</span>
									{/if}
									{#if deployment.notes}
										<span class="text-faint text-[0.78rem]">{deployment.notes}</span>
									{/if}
								</span>
							</td>
							<td
								class="text-muted whitespace-nowrap"
								data-label="Created"
								title={fullDate(deployment.createdAt)}
							>
								{timeAgo(deployment.createdAt)}
							</td>
							<td class="text-muted whitespace-nowrap" data-label="Source">{deployment.source}</td>
							<td class="num whitespace-nowrap" data-label="Files">{deployment.fileCount}</td>
							<td class="num whitespace-nowrap" data-label="Size">
								{formatBytes(deployment.totalBytes)}
							</td>
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
		</div>
	{/if}
</section>

<details class="mt-5">
	<summary class="text-muted cursor-pointer text-[0.85rem]">How to deploy to this site</summary>

	<div class="gen-tabs mt-4">
		<!--
			One radio per generator, all of them before the labels and panels so the CSS can
			match `input:nth-of-type(n):checked ~ …`. Visually hidden but focusable: a tab strip
			you cannot reach with the keyboard is a tab strip half the people cannot use.
		-->
		{#each recipes as recipe, index (recipe.id)}
			<input
				class="gen-radio"
				type="radio"
				name={tabGroup}
				id="{tabGroup}-{recipe.id}"
				checked={index === 0}
			/>
		{/each}

		<div class="gen-list" role="tablist" aria-label="Site generator">
			{#each recipes as recipe (recipe.id)}
				<label class="gen-tab" for="{tabGroup}-{recipe.id}">{recipe.label}</label>
			{/each}
		</div>

		<div class="gen-panels">
			{#each recipes as recipe (recipe.id)}
				<section class="gen-panel">
					<p class="text-muted text-[0.82rem]">
						<span class="font-medium">1. Build against this site's path.</span>
						{#if recipe.aka}
							<span class="text-faint">Same option for {recipe.aka}.</span>
						{/if}
					</p>
					<p class="text-faint mt-1 text-[0.78rem]">
						In <span class="mono">{recipe.file}</span> —
						<a class="hover:underline" href={recipe.docs} target="_blank" rel="noreferrer noopener">
							{recipe.option} docs
							<ArrowUpRight size={11} strokeWidth={1.75} class="inline align-[-1px]" />
						</a>
					</p>
					<pre class="gen-code">{recipe.snippet}</pre>

					<p class="text-muted mt-3 text-[0.82rem]">
						<span class="font-medium">2. Zip the output and upload it.</span>
						<span class="text-faint">
							{recipe.build} writes to <span class="mono">{recipe.output}/</span>.
						</span>
					</p>
					<pre class="gen-code">{recipe.upload}</pre>

					{#if recipe.manual}
						<!--
							The half that costs an afternoon. Setting the option is necessary and not
							sufficient in every one of these tools, and each draws the line somewhere
							else — so the site half-works: pages navigate, images 404. Saying it here,
							beside the config that causes it, is cheaper than saying it in a bug report.
						-->
						<p class="text-muted mt-3 text-[0.82rem]">
							<span class="font-medium">3. Mind what the option does not cover.</span>
						</p>
						<div class="gen-split">
							<p>
								<span class="gen-split-key">Prefixed for you</span>
								{recipe.handled}
							</p>
							<p>
								<span class="gen-split-key gen-split-warn">Yours to wrap</span>
								{recipe.manual.what} — use
								<span class="mono">{recipe.manual.helper}</span>.
							</p>
						</div>
					{/if}
				</section>
			{/each}
		</div>
	</div>

	<p class="text-faint mt-3 text-[0.78rem]">
		Whatever the tool, the value above is this site's own
		<span class="mono">{data.site.basePath}</span> — the slashes differ between them, and getting them
		wrong is what makes a build work locally and 404 every asset here.
	</p>
</details>

{#if data.canManage}
	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<Users size={15} strokeWidth={1.75} class="text-faint" />
			<h2 class="text-[1.05rem] font-semibold">Access</h2>
		</div>
		<p class="text-muted mb-3 text-[0.85rem]">
			{data.site.visibility === 'private'
				? 'Only the people and groups below can read this site.'
				: 'This site is public to read; grants below control who can deploy and manage it.'}
		</p>

		{#if data.grants.length > 0}
			<table class="table table-stack mb-4">
				<thead>
					<tr><th>Principal</th><th>Kind</th><th>Role</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.grants as grant (grant.id)}
						<tr>
							<td class="mono" data-label="Principal">{grant.principalName}</td>
							<td class="text-muted" data-label="Kind">{grant.principalType}</td>
							<td data-label="Role">{grant.role}</td>
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

		{#if principalOptions.length === 0}
			<!-- Reachable: a plain user granted `owner` manages the site but administers no
			     accounts, so there is nobody they could name here. Saying so beats an empty
			     picker that refuses to submit. -->
			<p class="notice text-[0.85rem]">
				You manage this site, but access is handed out by whoever administers the accounts — an
				admin, or the superadmin. Ask them to grant the people you need.
			</p>
		{:else}
			<form method="POST" action="?/addGrant" class="flex flex-wrap items-end gap-3">
				<label class="field w-80 max-w-full">
					Person or group
					<Combobox
						name="principal"
						options={principalOptions}
						placeholder="Search people or groups…"
					/>
				</label>
				<label class="field w-44 max-w-full">
					Role
					<select class="select" name="role">
						<option value="viewer">viewer — read</option>
						<option value="deployer">deployer — read + deploy</option>
						<option value="owner">owner — everything</option>
					</select>
				</label>
				<button class="btn btn-ghost" type="submit">Grant access</button>
			</form>
		{/if}
	</section>

	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<KeyRound size={15} strokeWidth={1.75} class="text-faint" />
			<h2 class="text-[1.05rem] font-semibold">Deploy tokens</h2>
		</div>

		{#if data.tokens.length > 0}
			<div class="mb-4 overflow-x-auto">
				<table class="table table-stack sm:min-w-[42rem]">
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
								<td data-label="Name">{token.name}</td>
								<td class="mono text-muted" data-label="Starts with">{token.prefix}…</td>
								<td class="text-muted" data-label="Last used" title={fullDate(token.lastUsedAt)}>
									{token.lastUsedAt ? timeAgo(token.lastUsedAt) : 'never used'}
								</td>
								<td class="num text-muted" data-label="Requests">{token.requestCount}</td>
								<td class="text-muted" data-label="Expires">
									{token.expiresAt ? fullDate(token.expiresAt) : 'never'}
								</td>
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
			</div>
		{/if}

		<form method="POST" action="?/createToken" class="flex flex-wrap items-end gap-3">
			<label class="field w-80 max-w-full">
				Name
				<input class="input" name="name" placeholder="github actions" />
			</label>
			<label class="field w-44 max-w-full">
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
		<h2 class="mb-3 text-[1.05rem] font-semibold">Settings</h2>
		<form method="POST" action="?/settings" class="flex flex-wrap items-end gap-3">
			<label class="field w-80 max-w-full">
				Name
				<input class="input" name="name" value={data.site.name} />
			</label>
			<label class="field w-52 max-w-full">
				Visibility
				<select class="select" name="visibility">
					<option value="private" selected={data.site.visibility === 'private'}>Private</option>
					<option value="public" selected={data.site.visibility === 'public'}>Public</option>
				</select>
			</label>
			<label class="field w-52 max-w-full">
				Keep last N deployments
				<input
					class="input"
					type="number"
					name="retentionLimit"
					min={data.retentionBounds.min}
					max={data.retentionBounds.max}
					placeholder="all"
					inputmode="numeric"
					value={data.site.retentionLimit ?? ''}
				/>
			</label>
			<label class="text-muted flex items-center gap-2 pb-1.5 text-[0.85rem]">
				<input class="check" type="checkbox" name="spaFallback" checked={data.site.spaFallback} />
				SPA fallback
			</label>
			<button class="btn btn-ghost" type="submit">Save</button>
		</form>
		<p class="text-muted mt-2 text-[0.8rem]">
			Deployments are full copies of the build. A limit deletes the oldest ones past it on every
			upload — never the live one — and saving a lower limit here applies it immediately.
		</p>
	</section>

	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			{#if data.site.disabled}
				<PowerOff size={15} strokeWidth={1.75} class="text-faint" />
			{:else}
				<Power size={15} strokeWidth={1.75} class="text-faint" />
			{/if}
			<h2 class="text-[1.05rem] font-semibold">Serving</h2>
		</div>
		<p class="text-muted mb-3 text-[0.85rem]">
			{data.site.disabled
				? 'The site is off. Nothing has been deleted — enabling it serves the same build again.'
				: 'A site with a deployment serves it. Switch it off to take it down without deleting anything: every request then answers 404, and its history, grants and tokens stay as they are.'}
		</p>
		<form method="POST" action="?/serving" class="flex flex-wrap items-end gap-3">
			<input type="hidden" name="disabled" value={data.site.disabled ? 'false' : 'true'} />
			{#if !data.site.disabled}
				<label class="field w-80 max-w-full">
					Reason <span class="text-faint">(optional)</span>
					<input class="input" name="reason" placeholder="rebuilding, contract ended…" />
				</label>
			{/if}
			<button class="btn {data.site.disabled ? 'btn-primary' : 'btn-danger'}" type="submit">
				{#if data.site.disabled}
					<Power size={14} strokeWidth={2} /> Enable serving
				{:else}
					<PowerOff size={14} strokeWidth={2} /> Disable serving
				{/if}
			</button>
		</form>
	</section>
{/if}

{#if data.transferTargets.length > 0}
	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<ArrowLeftRight size={15} strokeWidth={1.75} class="text-faint" />
			<h2 class="text-[1.05rem] font-semibold">Owner</h2>
		</div>
		<p class="text-muted mb-3 text-[0.85rem]">
			This site belongs to <span class="mono">{data.owner?.email ?? 'nobody'}</span>, and the
			{formatBytes(data.storage.bytes)} it holds counts against their quota. Handing it over moves both.
			An admin cannot be demoted while they still own sites, so this is how their work gets passed on
			rather than deleted.
		</p>

		{#if !handingOver}
			<button class="btn btn-ghost" onclick={() => (handingOver = true)}>
				<ArrowLeftRight size={14} strokeWidth={2} />
				Transfer to another admin
			</button>
		{:else}
			<form method="POST" action="?/transferSite" class="flex flex-wrap items-end gap-3">
				<label class="field w-80 max-w-full">
					New owner
					<select class="select" name="ownerUserId" required>
						<option value="" disabled selected>Pick an admin…</option>
						{#each data.transferTargets as target (target.id)}
							<!-- Room is shown, not just enforced, so the refusal is never a surprise. -->
							<option value={target.id} disabled={!target.fits}>
								{target.email} — {formatBytes(target.free)} free{target.fits ? '' : ' (too small)'}
							</option>
						{/each}
					</select>
				</label>
				<button class="btn btn-ghost" type="submit">Transfer</button>
				<button class="btn btn-ghost" type="button" onclick={() => (handingOver = false)}>
					Cancel
				</button>
			</form>
		{/if}
	</section>
{/if}

{#if data.canDelete}
	<section class="section">
		<div class="mb-3 flex items-center gap-2">
			<TriangleAlert size={15} strokeWidth={1.75} class="text-[color:var(--pb-danger)]" />
			<h2 class="text-[1.05rem] font-semibold">Delete this site</h2>
		</div>
		<p class="text-muted mb-3 text-[0.85rem]">
			Removes the site and everything under it: {data.storage.deployments} deployment(s),
			{formatBytes(data.storage.bytes)} of stored builds, every grant and every deploy token. Nothing
			here comes back, and the slug
			<span class="mono">{data.site.slug}</span> becomes free again. To take the site off the air without
			losing any of it, disable serving above.
		</p>

		{#if !deleting}
			<button class="btn btn-danger" onclick={() => (deleting = true)}>
				<TriangleAlert size={14} strokeWidth={2} />
				Delete site
			</button>
		{:else}
			<form method="POST" action="?/deleteSite" class="flex flex-wrap items-end gap-3">
				<label class="field w-72 max-w-full">
					<!-- Typing the slug is the confirmation. A dialog is dismissed by reflex; a name
					     has to be read off the page and copied, which is the pause this needs. -->
					Type <span class="mono">{data.site.slug}</span> to confirm
					<input class="input mono" name="confirm" autocomplete="off" required />
				</label>
				<button class="btn btn-danger" type="submit">Delete permanently</button>
				<button class="btn btn-ghost" type="button" onclick={() => (deleting = false)}>
					Cancel
				</button>
			</form>
		{/if}
	</section>
{/if}
