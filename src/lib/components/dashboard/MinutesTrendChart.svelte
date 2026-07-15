<script lang="ts">
	import type { MinutesDataPoint } from '$lib/types/metrics';
	import { formatMinutes } from '$lib/utils';

	let {
		data,
		title = 'Minutes Consumed',
		subtitle = ''
	}: {
		data: MinutesDataPoint[];
		title?: string;
		subtitle?: string;
	} = $props();

	const CHART_HEIGHT = 120;

	const maxMinutes = $derived(Math.max(...data.map((d) => d.minutes), 1));

	function formatDate(dateStr: string): string {
		const d = new Date(dateStr + 'T00:00:00');
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	// Keep long all-history charts readable with roughly twelve labels.
	function showLabel(index: number, total: number): boolean {
		if (total <= 12) return true;
		const interval = Math.ceil((total - 1) / 11);
		return index % interval === 0 || index === total - 1;
	}

	// Tooltip
	let hoveredIndex = $state<number | null>(null);
	let tooltipX = $state(0);
	let chartRef = $state<HTMLDivElement | null>(null);

	function onBarEnter(index: number, e: MouseEvent) {
		hoveredIndex = index;
		if (chartRef) {
			const rect = chartRef.getBoundingClientRect();
			tooltipX = e.clientX - rect.left;
		}
	}

	function onBarLeave() {
		hoveredIndex = null;
	}

	const hoveredPoint = $derived(hoveredIndex !== null ? data[hoveredIndex] : null);
	const totalMinutes = $derived(data.reduce((sum, d) => sum + d.minutes, 0));
</script>

<div class="bg-card border-border space-y-4 rounded-xl border p-5">
	<div class="flex items-start justify-between">
		<div>
			<h2 class="text-foreground text-sm font-semibold">{title}</h2>
			{#if subtitle}
				<p class="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
			{/if}
		</div>
		<span class="text-muted-foreground text-xs tabular-nums"
			>{formatMinutes(totalMinutes)} total</span
		>
	</div>

	{#if data.length === 0 || totalMinutes === 0}
		<div
			class="text-muted-foreground flex items-center justify-center text-sm"
			style="height: {CHART_HEIGHT + 20}px;"
		>
			No data available
		</div>
	{:else}
		<div class="relative" bind:this={chartRef}>
			<!-- Tooltip -->
			{#if hoveredPoint}
				<div
					class="border-border bg-popover text-popover-foreground pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
					style="left: {tooltipX}px;"
				>
					<p class="font-medium">{formatDate(hoveredPoint.date)}</p>
					<p class="text-muted-foreground">{formatMinutes(hoveredPoint.minutes)}</p>
				</div>
			{/if}

			<!-- Bar chart -->
			<div
				class="flex w-full items-end gap-0.5"
				style="height: {CHART_HEIGHT}px;"
				role="img"
				aria-label={title}
			>
				{#each data as point, i (point.date)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="flex flex-1 cursor-pointer flex-col justify-end"
						style="height: 100%;"
						onmouseenter={(e) => onBarEnter(i, e)}
						onmouseleave={onBarLeave}
					>
						<div
							class="bg-primary w-full rounded-t-sm transition-all duration-150"
							class:opacity-100={hoveredIndex === null || hoveredIndex === i}
							class:opacity-40={hoveredIndex !== null && hoveredIndex !== i}
							style="height: {point.minutes > 0
								? Math.max((point.minutes / maxMinutes) * CHART_HEIGHT, 2)
								: 0}px;"
						></div>
					</div>
				{/each}
			</div>

			<!-- X-axis labels -->
			<div class="mt-1.5 flex w-full" aria-hidden="true">
				{#each data as point, i (point.date)}
					<div class="flex flex-1 justify-center">
						{#if showLabel(i, data.length)}
							<span class="text-muted-foreground text-[10px] whitespace-nowrap">
								{new Date(point.date + 'T00:00:00').toLocaleDateString('en-US', {
									month: 'short',
									day: 'numeric'
								})}
							</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
