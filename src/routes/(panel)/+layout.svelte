<script lang="ts">
	import { page } from '$app/state';
	import Globe from '@lucide/svelte/icons/globe';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import Layers from '@lucide/svelte/icons/layers';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import LogOut from '@lucide/svelte/icons/log-out';

	let { data, children } = $props();

	const nav = $derived(
		[
			{ href: '/sites', label: 'Sites', icon: Globe },
			{ href: '/groups', label: 'Groups', icon: Layers },
			...(data.user.role === 'superadmin'
				? [{ href: '/users', label: 'Users', icon: UsersRound }]
				: []),
			{ href: '/audit', label: 'Activity', icon: ScrollText }
		].map((item) => ({
			...item,
			current: page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/')
		}))
	);
</script>

<div class="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
	<aside class="bg-rail flex flex-col gap-6 px-4 py-5 md:min-h-dvh">
		<div class="px-2">
			<p class="text-[15px] font-semibold tracking-tight">PageBox</p>
			<p class="mono text-faint truncate">{data.adminHost}</p>
		</div>

		<nav class="flex flex-col gap-0.5 md:flex-1">
			{#each nav as item (item.href)}
				<a href={item.href} class="rail-link" aria-current={item.current ? 'page' : undefined}>
					<item.icon size={15} strokeWidth={1.75} />
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="border-line-soft flex items-center justify-between gap-2 border-t px-2 pt-3">
			<div class="min-w-0">
				<p class="truncate text-[13px]">{data.user.email}</p>
				<p class="eyebrow">{data.user.role === 'superadmin' ? 'Superadmin' : 'User'}</p>
			</div>
			<form method="POST" action="/logout">
				<button class="btn btn-ghost btn-xs" type="submit" title="Sign out">
					<LogOut size={13} strokeWidth={1.75} />
				</button>
			</form>
		</div>
	</aside>

	<main class="min-w-0 px-5 py-6 md:px-9 md:py-8">
		<div class="mx-auto max-w-5xl">
			{@render children?.()}
		</div>
	</main>
</div>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>
