<script lang="ts">
	import { page } from '$app/state';
	import Globe from '@lucide/svelte/icons/globe';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import Layers from '@lucide/svelte/icons/layers';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import LogOut from '@lucide/svelte/icons/log-out';
	import UserRound from '@lucide/svelte/icons/user-round';
	import PageboxMark from '$lib/components/PageboxMark.svelte';
	import { REPO_URL, VERSION } from '$lib/meta';

	let { data, children } = $props();

	const nav = $derived(
		[
			{ href: '/sites', label: 'Sites', icon: Globe },
			// Groups and Activity are operator surfaces — a viewer-only account has nothing
			// to do with a grant list or an instance-wide audit trail, so both stay out of
			// its nav (and are 404'd server-side too, see hasOperatorAccess).
			...(data.canSeeOps ? [{ href: '/groups', label: 'Groups', icon: Layers }] : []),
			// Users is for the tiers that issue accounts. An admin sees only the accounts it
			// issued there, which is the boundary itself rather than a filter on the page.
			...(data.canAdminister ? [{ href: '/users', label: 'Users', icon: UsersRound }] : []),
			...(data.canSeeOps ? [{ href: '/audit', label: 'Activity', icon: ScrollText }] : [])
		].map((item) => ({
			...item,
			current: page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/')
		}))
	);

	const onAccount = $derived(page.url.pathname.startsWith('/account'));

	const roleLabel = $derived(
		data.user.role === 'superadmin' ? 'Superadmin' : data.user.role === 'admin' ? 'Admin' : 'User'
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

<!--
	Sign out, and nothing else. The account itself is a destination in the rail below and in
	the phone tab row — it used to be reachable two ways from the same corner, the name and a
	key icon beside it, which read as two different things and were one.
-->
{#snippet signOut()}
	<form method="POST" action="/logout">
		<button class="btn btn-ghost btn-xs" type="submit" title="Sign out" aria-label="Sign out">
			<LogOut size={13} strokeWidth={1.75} />
		</button>
	</form>
{/snippet}

<!--
	The project and the build, in the corner where an operator looks for them. An instance
	outlives whoever deployed it: the version is the first thing anyone reporting a problem
	is asked for, and the repository is where they go with it.
-->
{#snippet repo(labelled: boolean)}
	<a
		href={REPO_URL}
		target="_blank"
		rel="noreferrer"
		class="btn btn-ghost btn-xs text-faint"
		title="PageBox v{VERSION} on GitHub"
	>
		<!-- Lucide dropped its brand icons, and a generic link glyph beside a version number
		     reads as "release notes" rather than "the source". Inline mark instead. -->
		<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
			<path
				d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
			/>
		</svg>
		{#if labelled}<span class="mono">v{VERSION}</span>{/if}
	</a>
{/snippet}

<div class="min-h-dvh md:grid md:grid-cols-[14.5rem_1fr]">
	<!-- Phone and small tablet: a sticky bar, so the nav costs two rows rather than a screen. -->
	<header class="bg-rail border-line sticky top-0 z-30 border-b md:hidden">
		<div class="flex items-center gap-2.5 px-4 py-2.5">
			{@render brand()}
			<div class="ml-auto flex shrink-0 items-center gap-1">
				{@render repo(false)}{@render signOut()}
			</div>
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
			<!-- Last in the row, the way it is last in the rail: there is no room for a
			     footer on a phone, so the account joins the sections it sits below on a
			     desktop rather than becoming an icon in the bar. -->
			<a
				href="/account/password"
				class="rail-link rail-link-h"
				aria-current={onAccount ? 'page' : undefined}
			>
				<UserRound size={15} strokeWidth={1.75} />
				Account
			</a>
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
			<!-- The name *is* the link to the account view, and the only one: whoever wants to
			     change their password looks for themselves, not for an icon. -->
			<a
				href="/account/password"
				class="hover:bg-line-soft -mx-1 min-w-0 flex-1 rounded px-1 py-0.5"
				aria-current={onAccount ? 'page' : undefined}
				title="Account settings for {data.user.email}"
			>
				<p class="truncate text-[0.85rem]" class:font-medium={onAccount}>{data.user.email}</p>
				<p class="eyebrow">{roleLabel}</p>
			</a>
			<div class="flex shrink-0 items-center gap-1">{@render signOut()}</div>
		</div>

		<div class="-mt-4 flex items-center px-1">{@render repo(true)}</div>
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
