<script lang="ts">
	interface Props {
		title: string;
		value: string;
		subtitle?: string;
		trend?: number | null;
		icon?: string;
		/** Optional Tailwind class for the value (e.g. success rate color). */
		valueClass?: string;
		/** Optional description shown in a tooltip when hovering/focusing the help icon. */
		help?: string;
		/** Optional additional classes for the card container. */
		class?: string;
		actionLabel?: string;
		onAction?: () => void;
	}

	let {
		title,
		value,
		subtitle,
		trend,
		icon,
		valueClass,
		help,
		class: className = '',
		actionLabel,
		onAction
	}: Props = $props();

	const trendLabel = $derived(
		trend == null ? null : trend >= 0 ? `+${trend.toFixed(1)}%` : `${trend.toFixed(1)}%`
	);
	const trendPositive = $derived(trend != null && trend >= 0);
</script>

<div class="bg-card border-border space-y-3 rounded-xl border p-5 {className}">
	<div class="flex items-center justify-between">
		<div class="flex min-w-0 items-center gap-1.5">
			<p class="text-muted-foreground text-sm font-medium whitespace-nowrap">{title}</p>
			{#if help}
				<span class="group relative inline-flex flex-shrink-0">
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground focus:ring-ring focus:ring-offset-card rounded-full p-0.5 focus:ring-2 focus:ring-offset-2 focus:outline-none"
						aria-label="What is {title}?"
					>
						<svg
							class="size-3.5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="10" />
							<path d="M12 16v-4m0-4h.01" />
						</svg>
					</button>
					<span
						class="border-border bg-popover text-popover-foreground pointer-events-none absolute top-1/2 left-full z-10 ml-1.5 w-56 -translate-y-1/2 rounded-md border px-3 py-2 text-xs opacity-0 shadow-md transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
						role="tooltip"
					>
						{help}
					</span>
				</span>
			{/if}
		</div>
		{#if onAction && actionLabel}
			<button
				type="button"
				onclick={onAction}
				class="bg-muted text-muted-foreground hover:text-foreground focus:ring-ring rounded-lg px-2 py-1 text-xs font-medium transition-colors focus:ring-2 focus:outline-none"
			>
				{actionLabel}
			</button>
		{:else if icon}
			<div class="bg-muted flex size-8 flex-shrink-0 items-center justify-center rounded-lg">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html icon}
			</div>
		{/if}
	</div>

	<div class="space-y-1">
		<p class="text-2xl font-bold {valueClass ?? 'text-foreground'}">{value}</p>
		<div class="flex items-center gap-2">
			{#if trendLabel}
				<span class="text-xs font-medium {trendPositive ? 'text-success' : 'text-destructive'}">
					{trendLabel}
				</span>
			{/if}
			{#if subtitle}
				<span class="text-muted-foreground text-xs">{subtitle}</span>
			{/if}
		</div>
	</div>
</div>
