<script lang="ts">
	import type { PageData } from './$types';
	import MetricCard from '$lib/components/dashboard/MetricCard.svelte';
	import RecentRuns from '$lib/components/dashboard/RecentRuns.svelte';
	import DurationTrendChart from '$lib/components/dashboard/DurationTrendChart.svelte';
	import JobBreakdownChart from '$lib/components/dashboard/JobBreakdownChart.svelte';
	import MinutesDonutChart from '$lib/components/dashboard/MinutesDonutChart.svelte';
	import MinutesTrendChart from '$lib/components/dashboard/MinutesTrendChart.svelte';
	import OptimizePanel from '$lib/components/dashboard/OptimizePanel.svelte';
	import WorkflowJobGraph from '$lib/components/dashboard/WorkflowJobGraph.svelte';
	import {
		formatDuration,
		formatMinutes,
		failureRateColor,
		failureRateBorderColor,
		successRateColor,
		successRateBorderColor
	} from '$lib/utils';
	import { keyWithIndex } from '$lib/components/dashboard/list-keys';

	let { data }: { data: PageData } = $props();
	let {
		detailData,
		owner,
		repo,
		hasAiKey,
		aiModelLabel,
		lookbackLabel,
		lookbackDescription,
		actionsLookback
	} = $derived(data);
	let metrics = $derived(detailData.metrics);

	let showOptimize = $state(false);
	let showWorkflowFile = $state(false);
	const buildMinutesIcon =
		'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
	const skipRateIcon =
		'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>';

	// Estimated minutes "saved" by skips (median run duration × skipped count)
	const medianDurationMs = $derived(metrics.p50DurationMs);
	const minutesSavedBySkips = $derived(
		metrics.skippedCount > 0 ? Math.round((medianDurationMs * metrics.skippedCount) / 60_000) : 0
	);
</script>

<svelte:head>
	<title>{detailData.workflowName} · {owner}/{repo} · Workflow Metrics</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="space-y-1">
			<h1 class="text-foreground text-xl font-semibold">{detailData.workflowName}</h1>
			<p class="text-muted-foreground font-mono text-xs">{detailData.workflowPath}</p>
			<p class="text-muted-foreground text-xs">
				{lookbackLabel}:
				<span class="text-foreground font-medium">{metrics.totalRuns.toLocaleString()}</span>
				triggered ·
				<span class="text-foreground font-medium"
					>{(metrics.successCount + metrics.failureCount).toLocaleString()}</span
				>
				executed ·
				<span class="text-foreground font-medium">{metrics.skippedCount.toLocaleString()}</span> skipped
			</p>
		</div>
		{#if hasAiKey}
			<button
				onclick={() => (showOptimize = !showOptimize)}
				class="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
			>
				<i class="fa-solid fa-wand-magic-sparkles size-4 shrink-0" aria-hidden="true"></i>
				Optimize with AI
			</button>
		{:else}
			<a
				href="/settings"
				class="border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors"
				title="Add an OpenAI or Gemini API key in settings to enable AI optimization"
			>
				<i class="fa-solid fa-wand-magic-sparkles size-4 shrink-0" aria-hidden="true"></i>
				Optimize with AI
			</a>
		{/if}
	</div>

	{#if detailData.timingDataQuality.excludedRuns > 0}
		<div
			class="text-foreground rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
			role="status"
		>
			Duration and minutes metrics are partial: {detailData.timingDataQuality.excludedRuns.toLocaleString()}
			completed {detailData.timingDataQuality.excludedRuns === 1 ? 'run was' : 'runs were'}
			excluded because GitHub did not provide a valid completion time. Counts and rates remain complete.
		</div>
	{/if}

	{#if detailData.latestFailure}
		<section class="border-destructive/40 bg-destructive/10 rounded-xl border p-4" role="alert">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p class="text-destructive text-sm font-semibold">Latest workflow run failed</p>
					<p class="text-foreground mt-1 text-sm">
						Run #{detailData.latestFailure.runNumber}
						{#if detailData.latestFailure.jobName}
							· {detailData.latestFailure.jobName}{/if}
						{#if detailData.latestFailure.stepName}
							· {detailData.latestFailure.stepName}{/if}
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<a
						href={`/dashboard/workflow/${detailData.workflowId}/run/${detailData.latestFailure.runId}?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`}
						class="bg-destructive hover:bg-destructive/90 rounded-md px-3 py-2 text-sm font-medium text-white"
					>
						Investigate failure
					</a>
					<a
						href={detailData.latestFailure.htmlUrl}
						target="_blank"
						rel="noreferrer"
						class="border-destructive/40 text-destructive hover:bg-destructive/10 rounded-md border px-3 py-2 text-sm font-medium"
					>
						Open on GitHub
					</a>
				</div>
			</div>
		</section>
	{/if}

	{#if detailData.workflowContent}
		<section class="border-border bg-card rounded-xl border">
			<button
				type="button"
				class="flex w-full items-center justify-between px-5 py-4 text-left"
				onclick={() => (showWorkflowFile = !showWorkflowFile)}
				aria-expanded={showWorkflowFile}
			>
				<span
					><span class="text-foreground block text-sm font-semibold">Workflow file</span><span
						class="text-muted-foreground mt-0.5 block text-xs">{detailData.workflowPath}</span
					></span
				>
				<span class="text-primary text-sm font-medium">{showWorkflowFile ? 'Hide' : 'Preview'}</span
				>
			</button>
			{#if showWorkflowFile}
				<pre
					class="border-border bg-muted/30 text-foreground max-h-96 overflow-auto border-t p-4 text-xs leading-5"><code
						>{detailData.workflowContent}</code
					></pre>
			{/if}
		</section>
	{/if}

	<!-- AI Optimization Panel -->
	{#if showOptimize && hasAiKey}
		<OptimizePanel
			workflowId={detailData.workflowId}
			workflowName={detailData.workflowName}
			workflowPath={detailData.workflowPath}
			{metrics}
			{owner}
			{repo}
			{aiModelLabel}
			onclose={() => (showOptimize = false)}
		/>
	{/if}

	<!-- Metric cards -->
	<div class="flex flex-wrap gap-4">
		<MetricCard
			class="min-w-[140px] flex-1 {metrics.totalRuns === 0
				? ''
				: successRateBorderColor(metrics.successRate)}"
			title="Success Rate"
			value={metrics.totalRuns === 0 ? 'N/A' : `${metrics.successRate.toFixed(1)}%`}
			subtitle={metrics.successCount + metrics.failureCount > 0
				? `${metrics.successCount} of ${metrics.successCount + metrics.failureCount} runs that executed`
				: metrics.totalRuns === 0
					? 'no workflow runs found'
					: `${metrics.successCount} of ${metrics.totalRuns} runs`}
			valueClass={metrics.totalRuns === 0
				? 'text-muted-foreground'
				: successRateColor(metrics.successRate)}
			help="Percentage of runs that actually executed (success or failure). Skipped and cancelled runs are excluded."
		/>
		<MetricCard
			class="min-w-[140px] flex-1"
			title="Avg Duration"
			value={formatDuration(metrics.avgDurationMs)}
			subtitle="P50: {formatDuration(metrics.p50DurationMs)} · P95: {formatDuration(
				metrics.p95DurationMs
			)}"
			help="P50 is the median: half of runs finish faster. P95 means 95% of runs finish faster, highlighting the slower tail."
		/>
		<MetricCard
			class="min-w-[140px] flex-1"
			title="Total Runs"
			value={metrics.totalRuns.toLocaleString()}
			subtitle={lookbackDescription}
		/>
		<MetricCard
			class="min-w-[140px] flex-1 {failureRateBorderColor(metrics.failureRate)}"
			title="Failures"
			value={metrics.failureCount.toLocaleString()}
			subtitle={metrics.skippedCount > 0
				? `${metrics.failureRate.toFixed(1)}% failure rate · ${metrics.skippedCount.toLocaleString()} skipped`
				: `${metrics.failureRate.toFixed(1)}% failure rate`}
			valueClass={failureRateColor(metrics.failureRate)}
			help="Runs that ended in failure. Skipped runs (e.g. condition not met) are not counted as failures."
		/>
		<MetricCard
			class="min-w-[140px] flex-1"
			title="Build Minutes"
			value={formatMinutes(detailData.totalMinutes30d)}
			subtitle={`${formatMinutes(detailData.billableMinutes30d)} billable${
				detailData.billableMinutes30d !== detailData.totalMinutes30d
					? ' (mixed runners)'
					: ' (Linux ×1)'
			}`}
			help={`Raw minutes consumed across ${lookbackDescription}. Billable minutes are estimated by applying the runner OS multiplier (Linux ×1, Windows ×2, macOS ×10) from the last 5 sampled runs.`}
			icon={buildMinutesIcon}
		/>
		<MetricCard
			class="min-w-[140px] flex-1"
			title="Skip Rate"
			value={`${metrics.skipRate.toFixed(1)}%`}
			subtitle={`${metrics.skippedCount.toLocaleString()} skipped`}
			help="Percentage of triggered runs that were skipped (e.g. condition not met). High skip rate can mean useful conditional logic or overly broad triggers."
			icon={skipRateIcon}
		/>
	</div>

	<!-- Workflow Structure - Full Width -->
	{#if detailData.jobGraphNodes.length > 0}
		<WorkflowJobGraph nodes={detailData.jobGraphNodes} edges={detailData.jobGraphEdges} />
	{/if}

	<!-- Duration Trend - Full Width -->
	<DurationTrendChart data={detailData.durationTrend} />

	<!-- Job Breakdown + Cost Efficiency - Half Width Pair -->
	{#if detailData.totalMinutes30d > 0}
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<JobBreakdownChart jobs={detailData.jobBreakdown} />

			<!-- Failure cost card (Cost Efficiency) -->
			<div class="bg-card border-border space-y-4 rounded-xl border p-5">
				<div>
					<h2 class="text-foreground text-sm font-semibold">Cost Efficiency</h2>
					<p class="text-muted-foreground mt-0.5 text-xs">
						Where build time is going across {lookbackDescription}
					</p>
				</div>
				<div class="space-y-3">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Total raw minutes</span>
						<div class="text-right">
							<span class="text-foreground font-semibold tabular-nums"
								>{formatMinutes(detailData.totalMinutes30d)}</span
							>
							{#if detailData.billableMinutes30d !== detailData.totalMinutes30d}
								<p class="text-muted-foreground text-xs tabular-nums">
									{formatMinutes(detailData.billableMinutes30d)} billable
								</p>
							{/if}
						</div>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Wasted on failures</span>
						<span
							class="font-semibold tabular-nums {detailData.wastedMinutes > 0
								? 'text-destructive'
								: 'text-success'}"
						>
							{formatMinutes(detailData.wastedMinutes)}
							{#if detailData.totalMinutes30d > 0}
								<span class="text-muted-foreground ml-1 text-xs font-normal">
									({Math.round((detailData.wastedMinutes / detailData.totalMinutes30d) * 100)}%)
								</span>
							{/if}
						</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Successful runs</span>
						<span class="text-success font-semibold tabular-nums">
							{formatMinutes(detailData.totalMinutes30d - detailData.wastedMinutes)}
							{#if detailData.totalMinutes30d > 0}
								<span class="text-muted-foreground ml-1 text-xs font-normal">
									({100 -
										Math.round((detailData.wastedMinutes / detailData.totalMinutes30d) * 100)}%)
								</span>
							{/if}
						</span>
					</div>
					{#if minutesSavedBySkips > 0}
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Avoided by skips (est.)</span>
							<span
								class="text-muted-foreground font-semibold tabular-nums"
								title="Median run duration × skipped count"
							>
								{formatMinutes(minutesSavedBySkips)}
							</span>
						</div>
					{/if}
					<div class="border-border border-t pt-2">
						<!-- Waste bar -->
						<div class="bg-muted h-2 overflow-hidden rounded-full">
							<div
								class="bg-destructive h-full rounded-full transition-all"
								style="width: {detailData.totalMinutes30d > 0
									? (detailData.wastedMinutes / detailData.totalMinutes30d) * 100
									: 0}%"
							></div>
						</div>
						<p class="text-muted-foreground mt-1.5 text-xs">
							{detailData.wastedMinutes === 0
								? 'No minutes wasted on failures — excellent!'
								: 'Reducing failure rate would save these minutes.'}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Minutes by Job + Daily Build Minutes - Half Width Pair -->
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<MinutesDonutChart
				data={detailData.minutesByJob}
				title="Minutes by Job"
				subtitle="Based on last 5 completed runs"
				totalMinutes={detailData.minutesByJob.reduce((s, j) => s + j.minutes, 0)}
				totalBillableMinutes={detailData.minutesByJob.reduce((s, j) => s + j.billableMinutes, 0)}
				totalLabel="sampled"
				billableIsEstimate={false}
			/>
			<MinutesTrendChart
				data={detailData.minutesTrend}
				title="Daily Build Minutes"
				subtitle="Raw minutes consumed per day for this workflow"
			/>
		</div>

		<!-- Step breakdown for slowest job - Half Width (paired if present) -->
		{#if detailData.stepBreakdown.length > 0 && detailData.slowestJobName}
			{@const maxStepMs = Math.max(...detailData.stepBreakdown.map((s) => s.avgDurationMs), 1)}
			<div
				class="bg-card border-border space-y-4 rounded-xl border p-5 lg:max-w-[50%] lg:min-w-[50%]"
			>
				<div>
					<h2 class="text-foreground text-sm font-semibold">Step Breakdown</h2>
					<p class="text-muted-foreground mt-0.5 text-xs">
						Slowest job: <span class="font-mono">{detailData.slowestJobName}</span> · based on last 5
						runs
					</p>
				</div>
				<div class="space-y-3">
					{#each detailData.stepBreakdown as step, i (keyWithIndex('step', step.stepName, i))}
						<div class="space-y-1">
							<div class="flex items-center justify-between text-xs">
								<span class="text-foreground max-w-52 truncate font-medium" title={step.stepName}>
									{step.stepName}
								</span>
								<span class="text-muted-foreground ml-2 flex-shrink-0 tabular-nums">
									{formatDuration(step.avgDurationMs)} avg
								</span>
							</div>
							<div class="bg-muted h-2 overflow-hidden rounded-full">
								<div
									class="bg-primary h-full rounded-full transition-all"
									style="width: {(step.avgDurationMs / maxStepMs) * 100}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Recent runs -->
	<RecentRuns
		runs={detailData.recentRuns}
		{owner}
		{repo}
		serverPagination
		lookback={actionsLookback}
		workflowId={detailData.workflowId}
	/>
</div>
