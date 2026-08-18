<script lang="ts">
	/**
	 * The PageBox mark — the globe in an open box from pagebox.png, redrawn as vector.
	 *
	 * The source is 1240px of hairline art. Scaled down to rail size its strokes average out
	 * to grey (measured, not guessed: at 22px nothing in it reaches even half the ink), and
	 * it would sit as a soft bitmap beside the crisp lucide icons in the same column. So the
	 * mark is rebuilt on lucide's own grid — 24x24, stroke only, round joins, currentColor —
	 * which also means it follows the theme with no second file and no media query.
	 *
	 * The globe's interior runs thinner than its outline. At full weight the equator and the
	 * meridian leave no white between them and the sphere closes up into a dot.
	 *
	 * static/favicon.svg is the same geometry as a standalone file, and every icon in
	 * static/ is rasterised from it. Change one, change the other.
	 */
	let {
		size = 24,
		strokeWidth = 1.75,
		class: className = ''
	}: { size?: number; strokeWidth?: number; class?: string } = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	<circle cx="12" cy="6.6" r="4.6" />
	<g stroke-width={strokeWidth * 0.74}>
		<path d="M7.4 6.6h9.2" />
		<path d="M12 2a7 7 0 0 1 1.8 4.6 7 7 0 0 1-1.8 4.6 7 7 0 0 1-1.8-4.6 7 7 0 0 1 1.8-4.6z" />
	</g>
	<path d="M4.2 11.4 1.4 8.2 5.6 6.2" />
	<path d="m19.8 11.4 2.8-3.2-4.2-2" />
	<path d="M4.2 11.4 12 15.6l7.6-4.2" />
	<path d="M4.2 11.4v6l7.8 4.2 7.6-4.2v-6" />
	<path d="M12 15.6v6" />
</svg>
