<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';

	/**
	 * A password field with a reveal toggle — the only password field in PageBox.
	 *
	 * Typing a credential you cannot read is how a password gets set to something nobody
	 * can reproduce, and "repeat it below" only catches the same typo twice when it is a
	 * different typo. The toggle is a button, not a checkbox: it never submits, and it is
	 * reachable from the keyboard between the field and the next one.
	 *
	 * `visible` starts true for a credential being *handed over* rather than kept — the
	 * temporary password a superadmin types for someone else, which they have to read back
	 * out loud anyway.
	 */
	let {
		name,
		autocomplete = 'current-password',
		visible = $bindable(false),
		required = false,
		minlength,
		mono = false,
		id,
		value = $bindable('')
	}: {
		name: string;
		autocomplete?: 'current-password' | 'new-password' | 'off';
		visible?: boolean;
		required?: boolean;
		minlength?: number;
		mono?: boolean;
		id?: string;
		value?: string;
	} = $props();
</script>

<div class="input-affix">
	<!-- Two inputs would be simpler than swapping `type`, and would also hand the browser
	     two fields to autofill and a password manager two entries to argue about. -->
	<input
		class="input"
		class:mono
		type={visible ? 'text' : 'password'}
		{name}
		{id}
		{autocomplete}
		{required}
		{minlength}
		bind:value
	/>
	<button
		class="affix-btn"
		type="button"
		onclick={() => (visible = !visible)}
		title={visible ? 'Hide password' : 'Show password'}
		aria-label={visible ? 'Hide password' : 'Show password'}
		aria-pressed={visible}
	>
		{#if visible}
			<EyeOff size={15} strokeWidth={1.75} />
		{:else}
			<Eye size={15} strokeWidth={1.75} />
		{/if}
	</button>
</div>
