<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<!--
		Order matters: a browser takes the last icon link it understands, so the PNGs go first
		as the fallback and the SVG last as the one that wins. The SVG answers the tab strip's
		theme by itself; the PNGs cannot, hence the pair — and both of those carry their own
		ground, because anything falling back this far may also ignore media on an icon link,
		and a dark glyph on a dark tab strip is nothing at all.
	-->
	<link rel="icon" type="image/png" href="/favicon.png" />
	<link rel="icon" type="image/png" href="/favicon-dark.png" media="(prefers-color-scheme: dark)" />
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#f9fafb" media="(prefers-color-scheme: light)" />
	<meta name="theme-color" content="#121417" media="(prefers-color-scheme: dark)" />
</svelte:head>

{@render children?.()}
