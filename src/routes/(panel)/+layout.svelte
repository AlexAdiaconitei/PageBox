<script lang="ts">
	import { page } from '$app/state';
	import Globe from '@lucide/svelte/icons/globe';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import Layers from '@lucide/svelte/icons/layers';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import LogOut from '@lucide/svelte/icons/log-out';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import PageboxMark from '$lib/components/PageboxMark.svelte';

	let { data, children } = $props();

	const nav = $derived(
		[
			{ href: '/sites', label: 'Sites', icon: Globe },
			// Groups and Activity are operator surfaces — a viewer-only account has nothing
			// to do with a grant list or an instance-wide audit trail, so both stay out of
			// its nav (and are 404'd server-side too, see hasOperatorAccess).
			...(data.canSeeOps ? [{ href: '/groups', label: 'Groups', icon: Layers }] : []),
			...(data.user.role === 'superadmin'
				? [{ href: '/users', label: 'Users', icon: UsersRound }]
				: []),
			...(data.canSeeOps ? [{ href: '/audit', label: 'Activity', icon: ScrollText }] : [])
		].map((item) => ({
			...item,
			current: page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/')
		}))
	);
</script>

<!--
	One nav, two shapes. Above `md` it is the vertical rail; below, the same links become a
	row of tabs under a slim bar, because a rail stacked on top of a phone screen pushes
	every screen's first row of data below the fold.
-->
{#snippet brand()}
	<PageboxMark size={26} class="shrink-0" />
	<div class="min-w-0">
		<p class="text-[0.95rem] leading-tight font-semibold tracking-tight">PageBox</p>
		<p class="mono text-faint truncate leading-tight">{data.adminHost}</p>
	</div>
{/snippet}

{#snippet account()}
	<a
		class="btn btn-ghost btn-xs"
		href="/account/password"
		title="Account — {data.user.email}"
		aria-label="Account settings for {data.user.email}"
	>
		<KeyRound size={13} strokeWidth={1.75} />
	</a>
	<form method="POST" action="/logout">
		<button class="btn btn-ghost btn-xs" type="submit" title="Sign out" aria-label="Sign out">
			<LogOut size={13} strokeWidth={1.75} />
		</button>
	</form>
{/snippet}

<div class="min-h-dvh md:grid md:grid-cols-[14.5rem_1fr]">
	<!-- Phone and small tablet: a sticky bar, so the nav costs two rows rather than a screen. -->
	<header class="bg-rail border-line sticky top-0 z-30 border-b md:hidden">
		<div class="flex items-center gap-2.5 px-4 py-2.5">
			{@render brand()}
			<div class="ml-auto flex shrink-0 items-center gap-1">{@render account()}</div>
		</div>
		<nav class="scrollbar-none flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Sections">
			{#each nav as item (item.href)}
				<a
					href={item.href}
					class="rail-link rail-link-h"
					aria-current={item.current ? 'page' : undefined}
				>
					<item.icon size={15} strokeWidth={1.75} />
					{item.label}
				</a>
			{/each}
		</nav>
	</header>

	<aside
		class="bg-rail hidden md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:gap-6 md:self-start md:px-4 md:py-5"
	>
		<div class="flex items-center gap-2.5 px-2">{@render brand()}</div>

		<nav class="flex flex-col gap-0.5 md:flex-1" aria-label="Sections">
			{#each nav as item (item.href)}
				<a href={item.href} class="rail-link" aria-current={item.current ? 'page' : undefined}>
					<item.icon size={15} strokeWidth={1.75} />
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="border-line-soft flex items-center justify-between gap-2 border-t px-2 pt-3">
			<a href="/account/password" class="hover:bg-line-soft -mx-1 min-w-0 rounded px-1 py-0.5">
				<p class="truncate text-[0.85rem]">{data.user.email}</p>
				<p class="eyebrow">{data.user.role === 'superadmin' ? 'Superadmin' : 'User'}</p>
			</a>
			<div class="flex items-center gap-1">{@render account()}</div>
		</div>
	</aside>

	<main class="min-w-0 px-4 py-6 sm:px-6 md:px-8 md:py-9 xl:px-12">
		<!-- 64rem, not a pixel width: the measure grows with the root font size, so a large
		     monitor gets a proportionally larger console rather than the same console with
		     the columns pulled further apart. -->
		<div class="mx-auto max-w-5xl">
			{@render children?.()}
		</div>
	</main>
</div>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>
