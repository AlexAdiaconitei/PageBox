<script lang="ts">
	/**
	 * A `<select>` stops being usable once the option list is a user or group directory —
	 * scrolling a few hundred emails to find one is not a serious way to pick a person.
	 *
	 * This used to be a native `<datalist>`, which is worse than it looks: the browser draws
	 * that list, so it arrives as an OS popup in the wrong font on the wrong surface, it
	 * cannot say what kind of thing each row is, and it will happily leave a half-typed name
	 * in the box with nothing resolved behind it — the form then posts an empty principal and
	 * fails on the server. So: the same idea built from ordinary elements. It filters as you
	 * type, moves with the arrow keys, shares the app's menu surface with the styled
	 * `<select>` picker, and refuses to submit until a real id sits in the hidden field.
	 *
	 * It is an *enhancement*, not a requirement. The server renders a plain `<select>` over
	 * the same options and the search box replaces it once the component has mounted. Built
	 * the other way round, the page's only rendered control was a text input that nothing
	 * could resolve without JavaScript, which left granting access impossible — and left the
	 * options out of the HTML entirely, since the list only exists while it is open.
	 */
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';

	type Option = { value: string; label: string; hint?: string };

	let {
		name,
		options,
		placeholder = 'Search…'
	}: { name: string; options: Option[]; placeholder?: string } = $props();

	const listId = `cb-${Math.random().toString(36).slice(2, 10)}`;

	let text = $state('');
	let value = $state('');
	let open = $state(false);
	let active = $state(0);
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLUListElement>();

	/**
	 * False through SSR and true once the component is running in a browser — `$effect`
	 * never runs on the server, which is the signal wanted here. Everything below the fold
	 * of this flag is the enhancement; everything above it is what a plain HTML form gets.
	 */
	let enhanced = $state(false);
	$effect(() => {
		enhanced = true;
	});

	/**
	 * The fallback `<select>` groups by hint rather than gluing it onto each label: the kind
	 * of thing a row is ("person", "group") is a heading over a block, not part of anybody's
	 * name — and an option whose text is exactly the label is the one an operator can scan.
	 */
	const grouped = $derived.by(() => {
		const groups = new Map<string, Option[]>();
		for (const option of options) {
			const key = option.hint ?? '';
			groups.set(key, [...(groups.get(key) ?? []), option]);
		}
		return [...groups];
	});

	// Picking fills the box with the option's own label. Treating that state as "no query"
	// keeps the whole directory reachable on reopen, instead of the one row already chosen.
	const matches = $derived.by(() => {
		const query = text.trim().toLowerCase();
		const chosen = options.find((option) => option.value === value);
		if (!query || chosen?.label === text) return options;
		// The hint is searchable too, so typing "group" narrows to the groups.
		return options.filter((option) =>
			`${option.label} ${option.hint ?? ''}`.toLowerCase().includes(query)
		);
	});

	// The hidden field is what the form submits; the visible one is where the browser can
	// report that it is empty, so the complaint is attached there. Guarded: this runs once
	// before the enhanced branch has rendered anything to bind to.
	$effect(() => {
		input?.setCustomValidity(value ? '' : 'Pick one of the suggestions.');
	});

	// Arrow keys have to keep the highlighted row on screen in a directory-length list.
	$effect(() => {
		if (open) list?.children[active]?.scrollIntoView({ block: 'nearest' });
	});

	function choose(option: Option) {
		value = option.value;
		text = option.label;
		open = false;
	}

	function clear() {
		value = '';
		text = '';
		open = true;
		input?.focus();
	}

	function onInput() {
		open = true;
		active = 0;
		const exact = options.find((option) => option.label === text);
		value = exact ? exact.value : '';
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) {
				open = true;
			} else if (matches.length > 0) {
				const step = event.key === 'ArrowDown' ? 1 : -1;
				active = (active + step + matches.length) % matches.length;
			}
		} else if (event.key === 'Enter' && open && matches[active]) {
			// Only swallow Enter when it lands on a row; otherwise it submits the form.
			event.preventDefault();
			choose(matches[active]);
		} else if (event.key === 'Escape' && open) {
			// Stop it here so Escape closes the list rather than whatever encloses it.
			event.stopPropagation();
			open = false;
		}
	}

	// Closing on blur would fire before a click on a row lands; focusout with relatedTarget
	// lets focus move inside the widget (to the clear button) without collapsing it.
	function onFocusout(event: FocusEvent & { currentTarget: HTMLElement }) {
		const next = event.relatedTarget;
		if (!(next instanceof Node) || !event.currentTarget.contains(next)) open = false;
	}
</script>

{#if enhanced}
	<div class="relative" onfocusout={onFocusout}>
		<input
			bind:this={input}
			class="input input-search"
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-controls={listId}
			aria-autocomplete="list"
			aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
			autocomplete="off"
			spellcheck="false"
			{placeholder}
			bind:value={text}
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={() => (open = true)}
			required
		/>

		{#if text}
			<button class="cb-clear" type="button" onclick={clear} aria-label="Clear">
				<X size={14} strokeWidth={2} />
			</button>
		{/if}

		{#if open}
			<ul bind:this={list} id={listId} role="listbox" class="menu absolute z-20 mt-1 w-full">
				{#each matches as option, index (option.value)}
					<li
						id="{listId}-{index}"
						class="menu-item"
						role="option"
						aria-selected={option.value === value}
						data-active={index === active}
						onmousedown={(event) => {
							// Ahead of blur, so the row is chosen instead of the list vanishing.
							event.preventDefault();
							choose(option);
						}}
						onmouseenter={() => (active = index)}
					>
						<span class="flex-1 truncate">{option.label}</span>
						{#if option.hint}
							<span class="text-faint shrink-0 text-[0.72rem]">{option.hint}</span>
						{/if}
						<Check
							size={13}
							strokeWidth={2}
							class="shrink-0 {option.value === value ? '' : 'opacity-0'}"
						/>
					</li>
				{:else}
					<li class="menu-empty">No match</li>
				{/each}
			</ul>
		{/if}

		<input type="hidden" {name} {value} />
	</div>
{:else}
	<!-- What the server renders, and what a browser without JavaScript keeps. Same `name`,
	     same values: a long list is a poor control, and a poor control beats none. -->
	<select class="select" {name} required>
		<option value="" disabled selected>{placeholder}</option>
		{#each grouped as [hint, entries] (hint)}
			{#if hint}
				<optgroup label={hint}>
					{#each entries as option (option.value)}<option value={option.value}
							>{option.label}</option
						>{/each}
				</optgroup>
			{:else}
				{#each entries as option (option.value)}<option value={option.value}>{option.label}</option
					>{/each}
			{/if}
		{/each}
	</select>
{/if}
