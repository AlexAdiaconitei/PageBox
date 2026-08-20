<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { zipSync } from 'fflate';
	import CloudUpload from '@lucide/svelte/icons/cloud-upload';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Info from '@lucide/svelte/icons/info';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { formatBytes } from '$lib/format';
	import { preflight, type PreflightResult } from '$lib/preflight';

	/**
	 * Drop a build here: a folder, a .zip, or a lone index.html.
	 *
	 * The archive is built in the browser (store mode, no compression) and sent to the same
	 * endpoint CI uses — one ingestion path, one set of guards. Store mode also keeps the
	 * compressed:uncompressed ratio at 1:1, so a legitimate build never trips the server's
	 * zip-bomb guard.
	 */
	let {
		slug,
		basePath,
		maxFiles,
		maxBytes,
		retention
	}: {
		slug: string;
		basePath: string;
		maxFiles: number;
		maxBytes: number;
		/**
		 * The site's retention rule, and what it will delete when this upload lands. Told
		 * here rather than only in the answer: a deploy that silently removes older builds
		 * is a deploy nobody can undo, and the warning is worth nothing after the fact.
		 */
		retention?: { limit: number | null; prunableBytes: number; prunable: string[] };
	} = $props();

	type Entry = { path: string; size: number; file: File };

	let dragging = $state(false);
	let busy = $state(false);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);
	let entries = $state<Entry[]>([]);
	let result = $state<PreflightResult | null>(null);
	let accepted = $state(false);
	/** A zip dropped as-is: sent untouched, so there is nothing to inspect first. */
	let rawArchive = $state<File | null>(null);

	const willPrune = $derived(retention?.limit ? (retention.prunable ?? []) : []);

	const blocking = $derived(result?.warnings.filter((warning) => warning.blocking) ?? []);
	const advisory = $derived(result?.warnings.filter((warning) => !warning.blocking) ?? []);
	const needsAcceptance = $derived(blocking.length > 0);
	const canDeploy = $derived(
		!busy &&
			(rawArchive !== null || (result !== null && !result.fatal && (!needsAcceptance || accepted)))
	);

	async function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		reset();

		const items = [...(event.dataTransfer?.items ?? [])];
		const singleZip =
			items.length === 1 && items[0].getAsFile()?.name.toLowerCase().endsWith('.zip');

		if (singleZip) {
			rawArchive = items[0].getAsFile();
			status = `${rawArchive!.name} · ${formatBytes(rawArchive!.size)} — sent as is`;
			return;
		}

		busy = true;
		status = 'Reading files…';
		try {
			for (const item of items) {
				const handle = item.webkitGetAsEntry?.();
				if (handle) await walk(handle, '');
				else {
					const file = item.getAsFile();
					if (file) entries.push({ path: file.name, size: file.size, file });
				}
			}
			await runPreflight();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not read what was dropped';
		} finally {
			busy = false;
			status = null;
		}
	}

	async function onPick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		reset();
		busy = true;
		try {
			for (const file of [...(input.files ?? [])]) {
				// webkitRelativePath is set when a directory was chosen.
				const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
				entries.push({ path: path || file.name, size: file.size, file });
			}
			await runPreflight();
		} finally {
			busy = false;
		}
	}

	/** Depth-first walk of a dropped directory, keeping paths relative to the drop. */
	async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) =>
				(entry as FileSystemFileEntry).file(resolve, reject)
			);
			entries.push({ path: prefix + entry.name, size: file.size, file });
			return;
		}

		const reader = (entry as FileSystemDirectoryEntry).createReader();
		for (;;) {
			// readEntries returns at most 100 at a time; an empty batch means the end.
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
				reader.readEntries(resolve, reject)
			);
			if (batch.length === 0) break;
			for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
		}
	}

	async function runPreflight() {
		const htmlSamples: Record<string, string> = {};
		const htmlFiles = entries.filter((entry) => entry.path.endsWith('.html')).slice(0, 10);
		for (const entry of htmlFiles) {
			htmlSamples[entry.path] = await entry.file.text();
		}

		result = preflight({
			files: entries.map(({ path, size }) => ({ path, size })),
			htmlSamples,
			basePath,
			limits: { maxFiles, maxBytes }
		});
		accepted = false;
	}

	async function deploy() {
		busy = true;
		error = null;
		try {
			let body: Blob;
			let warnings: string[] = [];

			if (rawArchive) {
				body = rawArchive;
			} else {
				status = 'Packing…';
				const included = new Set(result!.included.map((file) => file.path));
				const payload: Record<string, Uint8Array> = {};
				for (const entry of entries) {
					const path = result!.root ? entry.path.slice(result!.root.length + 1) : entry.path;
					if (!included.has(path)) continue;
					payload[path] = new Uint8Array(await entry.file.arrayBuffer());
				}
				// level 0: the server never sees a suspicious compression ratio.
				body = new Blob([zipSync(payload, { level: 0 }) as unknown as BlobPart], {
					type: 'application/zip'
				});
				warnings = result!.warnings.map((warning) => warning.code);
			}

			status = 'Uploading…';
			const query = new URLSearchParams();
			if (warnings.length) {
				query.set('warnings', warnings.join(','));
				query.set('acknowledged', '1');
			}

			const response = await fetch(
				`/api/v1/sites/${slug}/deployments${query.size ? `?${query}` : ''}`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/zip',
						'x-deployment-notes': 'panel upload'
					},
					body
				}
			);

			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				error = payload?.error ?? `Upload failed (${response.status})`;
				return;
			}

			// The retention rule reports what it took, by count and by size, in the same line
			// that says the deploy worked — the only moment the person is still looking.
			const pruned = Array.isArray(payload.pruned) ? payload.pruned.length : 0;
			const prunedNote = pruned
				? ` · retention deleted ${pruned} old deployment(s), freeing ${formatBytes(payload.prunedBytes ?? 0)}`
				: '';
			status =
				(payload.brokenAssets > 0
					? `Deployed — ${payload.fileCount} files, but ${payload.brokenAssets} referenced asset(s) are missing`
					: `Deployed — ${payload.fileCount} files, live now`) + prunedNote;
			reset({ keepStatus: true });
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Upload failed';
		} finally {
			busy = false;
		}
	}

	function reset({ keepStatus = false } = {}) {
		entries = [];
		result = null;
		rawArchive = null;
		accepted = false;
		error = null;
		if (!keepStatus) status = null;
	}
</script>

<div
	class="border-line rounded-md border border-dashed p-5 transition-colors"
	class:border-solid={dragging}
	style={dragging ? 'border-color: var(--pb-accent); background: var(--pb-accent-soft)' : ''}
	ondragover={(event) => {
		event.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
	role="region"
	aria-label="Upload a build"
>
	<div class="flex flex-wrap items-center gap-3">
		<CloudUpload size={18} strokeWidth={1.75} class="text-faint" />
		<!-- basis-56: below that the button cannot sit beside the copy, so it wraps to its
		     own row instead of squeezing the sentence into a column. -->
		<div class="min-w-0 flex-1 basis-56">
			<p class="text-[0.9rem] font-medium">Drop a build here</p>
			<p class="text-muted text-[0.8rem]">
				A <code class="mono">dist/</code> folder, a <code class="mono">.zip</code>, or a single
				<code class="mono">index.html</code>. Up to {formatBytes(maxBytes)}.
			</p>
		</div>
		<label class="btn btn-ghost w-full cursor-pointer sm:w-auto">
			Choose folder
			<input class="hidden" type="file" webkitdirectory multiple onchange={onPick} />
		</label>
	</div>

	{#if willPrune.length > 0}
		<!-- Before the click, not in the receipt: a deploy that quietly deletes older builds
		     is one nobody can undo, so the rule says what it will take while there is still
		     the option of raising the limit instead. -->
		<p class="text-muted mt-3 flex gap-2 text-[0.8rem]">
			<TriangleAlert
				size={14}
				strokeWidth={1.75}
				class="mt-0.5 shrink-0 text-[color:var(--pb-warn)]"
			/>
			<span>
				This site keeps its last {retention?.limit} deployments, so deploying deletes {willPrune.length}
				older one(s) — {formatBytes(retention?.prunableBytes ?? 0)}, never the live one:
				<span class="mono text-faint break-all">{willPrune.join(', ')}</span>
			</span>
		</p>
	{/if}

	{#if status}
		<p class="text-muted mt-3 text-[0.85rem]">{status}</p>
	{/if}
	{#if error}
		<p class="notice mt-3">{error}</p>
	{/if}

	{#if result}
		<div class="border-line-soft mt-4 border-t pt-3">
			<p class="text-[0.85rem]">
				<span class="font-medium">{result.included.length} files</span>
				<span class="text-muted">· {formatBytes(result.totalBytes)}</span>
				{#if result.root}
					<span class="text-muted">· root <code class="mono">{result.root}/</code></span>
				{/if}
			</p>

			{#each [...blocking, ...advisory] as warning (warning.code)}
				<div class="mt-3 flex gap-2 text-[0.85rem]">
					{#if warning.blocking}
						<TriangleAlert
							size={14}
							strokeWidth={1.75}
							class="mt-0.5 shrink-0 text-[color:var(--pb-warn)]"
						/>
					{:else}
						<Info size={14} strokeWidth={1.75} class="text-faint mt-0.5 shrink-0" />
					{/if}
					<div>
						<p class="font-medium">{warning.title}</p>
						<p class="text-muted">{warning.detail}</p>
					</div>
				</div>
			{/each}

			{#if needsAcceptance}
				<!-- PageBox deploys anyway: it does not guess, and it never rewrites HTML. What
				     it keeps is a record of what was said and who accepted it. -->
				<label class="mt-4 flex items-start gap-2 text-[0.85rem]">
					<input class="check mt-0.5" type="checkbox" bind:checked={accepted} />
					<span>
						I understand this build may not work under <code class="mono">{basePath}</code> and that its
						base path is my responsibility.
					</span>
				</label>
			{/if}
		</div>
	{/if}

	{#if result || rawArchive}
		<div class="mt-4 flex items-center gap-2">
			<button class="btn btn-primary" disabled={!canDeploy} onclick={deploy}>
				{busy ? 'Working…' : 'Deploy'}
			</button>
			<button class="btn btn-ghost" disabled={busy} onclick={() => reset()}>Cancel</button>
		</div>
	{/if}
</div>
