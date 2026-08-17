<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { zipSync } from 'fflate';
	import CloudUpload from '@lucide/svelte/icons/cloud-upload';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Info from '@lucide/svelte/icons/info';
	import { formatBytes, preflight, type PreflightResult } from '$lib/preflight';

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
		maxBytes
	}: { slug: string; basePath: string; maxFiles: number; maxBytes: number } = $props();

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

			status =
				payload.brokenAssets > 0
					? `Deployed — ${payload.fileCount} files, but ${payload.brokenAssets} referenced asset(s) are missing`
					: `Deployed — ${payload.fileCount} files, live now`;
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
		<div class="min-w-0 flex-1">
			<p class="text-[13.5px] font-medium">Drop a build here</p>
			<p class="text-muted text-[12.5px]">
				A <code class="mono">dist/</code> folder, a <code class="mono">.zip</code>, or a single
				<code class="mono">index.html</code>. Up to {formatBytes(maxBytes)}.
			</p>
		</div>
		<label class="btn btn-ghost cursor-pointer">
			Choose folder
			<input class="hidden" type="file" webkitdirectory multiple onchange={onPick} />
		</label>
	</div>

	{#if status}
		<p class="text-muted mt-3 text-[13px]">{status}</p>
	{/if}
	{#if error}
		<p class="notice mt-3">{error}</p>
	{/if}

	{#if result}
		<div class="border-line-soft mt-4 border-t pt-3">
			<p class="text-[13px]">
				<span class="font-medium">{result.included.length} files</span>
				<span class="text-muted">· {formatBytes(result.totalBytes)}</span>
				{#if result.root}
					<span class="text-muted">· root <code class="mono">{result.root}/</code></span>
				{/if}
			</p>

			{#each [...blocking, ...advisory] as warning (warning.code)}
				<div class="mt-3 flex gap-2 text-[13px]">
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
				<label class="mt-4 flex items-start gap-2 text-[13px]">
					<input type="checkbox" class="mt-1" bind:checked={accepted} />
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
