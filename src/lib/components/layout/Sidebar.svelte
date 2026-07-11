<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import type { User } from '@supabase/supabase-js';
	import { Tooltip } from 'bits-ui';

	let {
		user,
		githubUser = null
	}: { user: User; githubUser?: { username: string; avatarUrl: string | null } | null } = $props();

	const navItems = [
		{
			href: '/dashboard',
			label: 'Dashboard',
			icon: `<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`
		},
		{
			href: '/pull-requests',
			label: 'Pull requests',
			icon: `<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 6h8M6 8v8a2 2 0 0 0 2 2h8"/></svg>`
		},
		{
			href: '/settings',
			label: 'Settings',
			icon: `<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`
		}
	];
</script>

<aside class="border-sidebar-border bg-sidebar flex h-full w-16 flex-shrink-0 flex-col border-r">
	<!-- Brand -->
	<div class="border-sidebar-border flex h-14 items-center justify-center border-b">
		<img src="/logo.svg" alt="Workflow Metrics" class="size-8 object-contain" />
	</div>

	<!-- Navigation -->
	<nav class="flex-1 space-y-1 py-3">
		{#each navItems as item (item.label)}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<a
							{...props}
							href={item.href}
							class={cn(
								'mx-2 flex items-center justify-center rounded-md py-3 transition-colors',
								page.url.pathname === item.href || page.url.pathname.startsWith(item.href + '/')
									? 'bg-sidebar-accent text-sidebar-primary'
									: 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
							)}
						>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							{@html item.icon}
						</a>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content
						side="right"
						sideOffset={8}
						class="bg-popover text-popover-foreground border-border z-50 rounded-md border px-3 py-1.5 text-sm shadow-md"
					>
						{item.label}
						<Tooltip.Arrow class="fill-popover" />
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		{/each}
	</nav>

	<!-- User footer -->
	<div class="border-sidebar-border border-t p-2">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<div {...props} class="flex items-center justify-center">
						<div
							class="bg-secondary flex size-9 items-center justify-center overflow-hidden rounded-full"
						>
							{#if githubUser?.avatarUrl}
								<img
									src={githubUser.avatarUrl}
									alt={githubUser.username}
									class="size-full object-cover"
								/>
							{:else}
								<svg class="text-muted-foreground size-5" viewBox="0 0 24 24" fill="currentColor">
									<path
										d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"
									/>
								</svg>
							{/if}
						</div>
					</div>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content
					side="right"
					sideOffset={8}
					class="bg-popover text-popover-foreground border-border z-50 rounded-md border px-3 py-2 text-sm shadow-md"
				>
					<p class="font-medium">{githubUser?.username ?? user.email?.split('@')[0] ?? 'User'}</p>
					<p class="text-muted-foreground text-xs">{user.email}</p>
					<Tooltip.Arrow class="fill-popover" />
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>

		<form method="POST" action="/auth/logout" class="mt-2">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="submit"
							class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex w-full items-center justify-center rounded-md py-2 transition-colors"
						>
							<svg
								class="size-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							>
								<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
								<polyline points="16 17 21 12 16 7" />
								<line x1="21" x2="9" y1="12" y2="12" />
							</svg>
						</button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content
						side="right"
						sideOffset={8}
						class="bg-popover text-popover-foreground border-border z-50 rounded-md border px-3 py-1.5 text-sm shadow-md"
					>
						Sign out
						<Tooltip.Arrow class="fill-popover" />
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</form>
	</div>
</aside>
