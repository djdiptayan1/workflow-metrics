<script lang="ts">
	import type { PageData } from './$types';
	import type { DashboardData } from '$lib/types/metrics';
	import { goto } from '$app/navigation';
	import MetricCard from '$lib/components/dashboard/MetricCard.svelte';
	import RunHistoryChart from '$lib/components/dashboard/RunHistoryChart.svelte';
	import DurationChart from '$lib/components/dashboard/DurationChart.svelte';
	import MinutesDonutChart from '$lib/components/dashboard/MinutesDonutChart.svelte';
	import MinutesTrendChart from '$lib/components/dashboard/MinutesTrendChart.svelte';
	import RecentRuns from '$lib/components/dashboard/RecentRuns.svelte';
	import WorkflowList from '$lib/components/dashboard/WorkflowList.svelte';
	import DoraWorkflowDialog from '$lib/components/dashboard/DoraWorkflowDialog.svelte';
	import ActionsCostDialog from '$lib/components/dashboard/ActionsCostDialog.svelte';
	import {
		formatDuration,
		formatMinutes,
		successRateColor,
		successRateBorderColor,
		failureRateColor,
		failureRateBorderColor
	} from '$lib/utils';

	let { data }: { data: PageData } = $props();

	// Dashboard data for all history available through the GitHub Actions API.
	let dashboardData = $state<DashboardData | null>(null);
	// True only during the initial load (before we have any data to show)
	let initialLoading = $state(true);
	// True when the data shown is stale (served from cache older than TTL)
	let isStale = $state(false);
	let errorMessage = $state<string | null>(null);
	// Bumped by the Retry button to re-trigger the load effect without changing repo.
	let retryToken = $state(0);

	// Scan view (always-on health check) vs. Details (skip rate, minutes breakdown, efficiency tables)
	let activeTab = $state<'overview' | 'details'>('overview');

	// DORA workflow dialog state
	let showDoraDialog = $state(false);
	let showCostDialog = $state(false);
	let doraRefreshController: AbortController | null = null;

	// Progress state for the SSE loading bar (only used during cache-miss fetches)
	type LoadPhase = 'connecting' | 'fetching' | 'repairing' | 'computing' | null;
	let loadPhase = $state<LoadPhase>(null);
	let progressFetched = $state(0);
	let progressTotal = $state(0);

	// Derived progress percentage (clamped so bar always moves forward)
	const progressPct = $derived(
		progressTotal > 0 ? Math.min(Math.round((progressFetched / progressTotal) * 100), 99) : 0
	);

	// Delay before showing the progress UI — avoids flash for fast cache hits
	let showProgress = $state(false);
	let progressTimer: ReturnType<typeof setTimeout> | null = null;

	function startProgressTimer() {
		progressTimer = setTimeout(() => {
			showProgress = true;
		}, 300);
	}

	function clearProgressTimer() {
		if (progressTimer) {
			clearTimeout(progressTimer);
			progressTimer = null;
		}
		showProgress = false;
	}

	/**
	 * Fetch dashboard data for a given number of days.
	 * Returns { data, isStale } or throws on error.
	 */
	async function fetchDashboardData(
		owner: string,
		name: string,
		days: number | 'all',
		signal: AbortSignal,
		onProgress?: (fetched: number, total: number) => void
	): Promise<{ data: DashboardData; isStale: boolean }> {
		const endpoint = `/api/dashboard/data?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&days=${days}`;

		// Try SSE first for cache-miss case (gives us progress events)
		const res = await fetch(endpoint, {
			signal,
			headers: { Accept: 'text/event-stream' }
		});
		if (res.status === 202) {
			const pending = (await res.json()) as {
				importedRuns?: number;
				expectedRuns?: number;
				retryAfterMs?: number;
			};
			onProgress?.(pending.importedRuns ?? 0, pending.expectedRuns ?? 0);
			await new Promise((resolve) => setTimeout(resolve, pending.retryAfterMs ?? 1_000));
			return fetchDashboardData(owner, name, days, signal, onProgress);
		}

		if (res.status === 401) {
			goto('/auth/login?error=' + encodeURIComponent('Session expired. Please sign in again.'));
			throw new Error('Unauthorized');
		}
		if (!res.ok) {
			let msg = res.statusText;
			try {
				const body = await res.json();
				msg = (body as { message?: string })?.message ?? msg;
			} catch {
				// ignore non-JSON response
			}
			throw new Error(msg);
		}

		const stale = res.headers.get('X-Data-Stale') === 'true';
		const contentType = res.headers.get('Content-Type') ?? '';

		// JSON response (cache hit)
		if (!contentType.includes('text/event-stream')) {
			const d = (await res.json()) as DashboardData;
			return { data: d, isStale: stale };
		}

		// SSE stream (cache miss — parse progress events)
		if (!res.body) throw new Error('No response body for SSE stream');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// Parse complete SSE messages (separated by double newline)
			const messages = buffer.split('\n\n');
			buffer = messages.pop() ?? '';

			for (const msg of messages) {
				if (!msg.trim()) continue;
				const eventMatch = msg.match(/^event:\s*(.+)$/m);
				const dataMatch = msg.match(/^data:\s*(.+)$/m);
				if (!eventMatch || !dataMatch) continue;

				const eventName = eventMatch[1].trim();
				let payload: unknown;
				try {
					payload = JSON.parse(dataMatch[1]);
				} catch {
					continue;
				}

				if (eventName === 'progress') {
					const p = payload as { phase: string; fetched?: number; total?: number };
					if (p.phase === 'fetching' && p.fetched !== undefined && p.total !== undefined) {
						onProgress?.(p.fetched, p.total);
					} else if (p.phase === 'repairing') {
						loadPhase = 'repairing';
					} else if (p.phase === 'computing') {
						loadPhase = 'computing';
					}
				} else if (eventName === 'complete') {
					return { data: payload as DashboardData, isStale: false };
				} else if (eventName === 'continue') {
					const next = payload as {
						importedRuns?: number;
						expectedRuns?: number;
						retryAfterMs?: number;
					};
					onProgress?.(next.importedRuns ?? 0, next.expectedRuns ?? 0);
					await reader.cancel();
					await new Promise((resolve) => setTimeout(resolve, next.retryAfterMs ?? 250));
					return fetchDashboardData(owner, name, days, signal, onProgress);
				} else if (eventName === 'error') {
					const e = payload as { message?: string };
					throw new Error(e.message ?? 'Failed to load dashboard data.');
				}
			}
		}

		throw new Error('SSE stream ended without a complete event');
	}

	$effect(() => {
		const owner = data.selectedRepo.owner;
		const name = data.selectedRepo.name;
		void retryToken; // dependency only — re-runs this effect when Retry is clicked

		initialLoading = true;
		isStale = false;
		errorMessage = null;
		dashboardData = null;
		loadPhase = 'connecting';
		progressFetched = 0;
		progressTotal = 0;
		clearProgressTimer();

		const ac = new AbortController();
		startProgressTimer();

		(async () => {
			try {
				loadPhase = 'connecting';
				const result = await fetchDashboardData(
					owner,
					name,
					data.actionsLookback,
					ac.signal,
					(fetched, total) => {
						loadPhase = 'fetching';
						progressFetched = fetched;
						progressTotal = total;
					}
				);

				// Guard against stale effect (repo changed mid-flight)
				if (data.selectedRepo.owner !== owner || data.selectedRepo.name !== name) return;

				dashboardData = result.data;
				isStale = result.isStale;
				initialLoading = false;
				loadPhase = null;
				clearProgressTimer();
			} catch (e: unknown) {
				if ((e as { name?: string }).name === 'AbortError') return;
				if (data.selectedRepo.owner !== owner || data.selectedRepo.name !== name) return;
				errorMessage = e instanceof Error ? e.message : 'Failed to load dashboard data.';
				initialLoading = false;
				loadPhase = null;
				clearProgressTimer();
			}
		})();

		return () => {
			ac.abort();
			clearProgressTimer();
		};
	});

	function switchRepo(fullName: string) {
		const found = data.repos.find((r) => r.full_name === fullName);
		if (found) {
			goto(`/dashboard?owner=${found.owner}&repo=${found.name}`);
		}
	}

	async function handleSaveDoraWorkflows(selectedIds: number[]) {
		if (!dashboardData) return;

		const workflows = dashboardData.workflowMetrics
			.filter((w) => selectedIds.includes(w.workflowId))
			.map((w) => ({
				workflow_id: w.workflowId,
				workflow_name: w.workflowName,
				workflow_path: w.workflowPath
			}));

		const response = await fetch('/api/dora-workflows', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				repository_id: data.selectedRepo.id,
				workflows
			})
		});

		if (!response.ok) {
			throw new Error('Failed to save DORA workflow selection');
		}

		// Refresh dashboard data to get updated DORA metrics
		doraRefreshController?.abort();
		doraRefreshController = new AbortController();
		const owner = data.selectedRepo.owner;
		const name = data.selectedRepo.name;
		const refreshController = doraRefreshController;
		const result = await fetchDashboardData(
			owner,
			name,
			dashboardData.isAllTime ? 'all' : dashboardData.timeWindowDays,
			refreshController.signal
		);
		if (refreshController.signal.aborted) return;
		if (doraRefreshController !== refreshController) return;
		if (data.selectedRepo.owner !== owner || data.selectedRepo.name !== name) return;
		dashboardData = result.data;
		isStale = result.isStale;
	}

	$effect(() => {
		return () => {
			doraRefreshController?.abort();
		};
	});

	const timeWindowLabel = $derived(
		dashboardData?.isAllTime
			? 'All available history'
			: `Last ${dashboardData?.timeWindowDays ?? 30} days`
	);
	const timeWindowDescription = $derived(
		dashboardData?.isAllTime
			? 'all available history'
			: `the last ${dashboardData?.timeWindowDays ?? 30} days`
	);

	const totalRunsLabel = $derived(
		dashboardData
			? `${dashboardData.totalRuns.toLocaleString()}${dashboardData.totalRunsIsCapped ? '+' : ''}`
			: ''
	);
</script>

<svelte:head>
	<title>{data.selectedRepo.full_name} · Workflow Metrics</title>
</svelte:head>

<div class="space-y-6">
	<!-- Repo selector + header (always visible) -->
	<div class="flex items-center justify-between">
		<div class="space-y-1">
			<h1 class="text-foreground text-xl font-semibold">{data.selectedRepo.full_name}</h1>
			<div class="flex items-center gap-2">
				<p class="text-muted-foreground text-sm">GitHub Actions · {timeWindowLabel}</p>
				{#if isStale}
					<span
						class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
					>
						<span class="size-1.5 animate-pulse rounded-full bg-amber-400"></span>
						Updating…
					</span>
				{/if}
			</div>
		</div>
		<div class="flex items-center gap-3">
			<div class="relative inline-block">
				<select
					value={data.selectedRepo.full_name}
					onchange={(e) => switchRepo((e.target as HTMLSelectElement).value)}
					class="bg-card border-border text-foreground focus:ring-ring min-w-[12rem] cursor-pointer appearance-none rounded-lg border py-2 pr-10 pl-3 text-sm focus:ring-2 focus:outline-none"
				>
					{#each data.repos as repo (repo.full_name)}
						<option value={repo.full_name}>{repo.full_name}</option>
					{/each}
				</select>
				<span
					class="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
					aria-hidden="true"
				>
					<svg
						class="size-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{#if dashboardData}
				<button
					type="button"
					onclick={() => (showDoraDialog = true)}
					class="text-muted-foreground hover:text-foreground hover:bg-accent focus:ring-ring rounded-lg p-2 transition-colors focus:ring-2 focus:outline-none"
					aria-label="Configure DORA workflows"
					title="Configure DORA workflows"
				>
					<svg
						class="size-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
						/>
						<circle cx="12" cy="12" r="3" />
					</svg>
				</button>
			{/if}
		</div>
	</div>

	{#if errorMessage}
		<div
			class="border-destructive/50 bg-destructive/10 text-destructive flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm"
			role="alert"
		>
			<span>{errorMessage}</span>
			<button
				type="button"
				onclick={() => retryToken++}
				class="border-destructive/40 hover:bg-destructive/10 shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
			>
				Retry
			</button>
		</div>
	{:else if initialLoading || !dashboardData}
		<!-- Loading skeleton -->
		<div class="flex flex-wrap gap-4">
			{#each [1, 2, 3, 4, 5] as i (i)}
				<div class="bg-muted/60 h-24 min-w-[140px] flex-1 animate-pulse rounded-lg"></div>
			{/each}
		</div>
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-5">
			<div class="bg-muted/60 h-64 animate-pulse rounded-lg lg:col-span-3"></div>
			<div class="bg-muted/60 h-64 animate-pulse rounded-lg lg:col-span-2"></div>
		</div>
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<div class="bg-muted/60 h-48 animate-pulse rounded-lg"></div>
			<div class="bg-muted/60 h-48 animate-pulse rounded-lg"></div>
		</div>

		<!-- Progress indicator (shown after 300ms delay to avoid flash on fast loads) -->
		{#if showProgress && loadPhase}
			<div class="space-y-2" role="status" aria-live="polite">
				<div class="text-muted-foreground flex items-center justify-between text-xs">
					<span>
						{#if loadPhase === 'connecting'}
							Connecting to GitHub…
						{:else if loadPhase === 'fetching'}
							{data.actionsLookback === 'all' ? 'Imported' : 'Loading workflow runs'} · {progressFetched.toLocaleString()}
							/ {progressTotal.toLocaleString()} runs
						{:else if loadPhase === 'repairing'}
							Repairing workflow timing data…
						{:else if loadPhase === 'computing'}
							Analyzing metrics…
						{/if}
					</span>
					{#if loadPhase === 'fetching' && progressTotal > 0}
						<span class="tabular-nums">{progressPct}%</span>
					{/if}
				</div>
				<div class="bg-muted h-1.5 w-full overflow-hidden rounded-full">
					{#if loadPhase === 'fetching' && progressTotal > 0}
						<!-- Determinate progress bar -->
						<div
							class="bg-primary h-full rounded-full transition-all duration-300 ease-out"
							style="width: {progressPct}%"
							role="progressbar"
							aria-valuenow={progressPct}
							aria-valuemin={0}
							aria-valuemax={100}
						></div>
					{:else}
						<!-- Indeterminate bar for connecting / computing phases -->
						<div
							class="bg-primary h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full"
						></div>
					{/if}
				</div>
			</div>
		{:else if !showProgress}
			<!-- Minimal spinner before the 300ms delay -->
			<div class="text-muted-foreground flex items-center gap-2 text-sm">
				<svg
					class="size-4 animate-spin"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
					></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					></path>
				</svg>
				<span>Loading workflow data…</span>
			</div>
		{/if}
	{:else}
		{#if dashboardData.timingDataQuality.excludedRuns > 0}
			<div
				class="text-foreground rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
				role="status"
			>
				Duration and minutes metrics are partial: {dashboardData.timingDataQuality.excludedRuns.toLocaleString()}
				completed {dashboardData.timingDataQuality.excludedRuns === 1 ? 'run was' : 'runs were'}
				excluded because GitHub did not provide a valid completion time. Counts and rates still include
				{dashboardData.timingDataQuality.excludedRuns === 1 ? 'it' : 'them'}.
			</div>
		{/if}
		<!-- Metric cards -->
		<div class="flex flex-wrap gap-4">
			<MetricCard
				class="min-w-[140px] flex-1"
				title="Total Runs"
				value={totalRunsLabel}
				subtitle={timeWindowDescription}
				help="Total number of workflow runs triggered across {timeWindowDescription}, including success, failure, and cancelled.{dashboardData.totalRunsIsCapped
					? ' GitHub caps results at 1,000 runs, so the real total may be higher.'
					: ''}"
				icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'}
			/>
			<MetricCard
				class="min-w-[140px] flex-1 {successRateBorderColor(dashboardData.successRate)}"
				title="Success Rate"
				value="{dashboardData.successRate.toFixed(1)}%"
				subtitle="of runs that executed"
				valueClass={successRateColor(dashboardData.successRate)}
				help="Percentage of runs that actually executed (success or failure). Skipped and cancelled runs are excluded so the rate reflects real failures, not condition-not-met skips."
				icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5L20 7"/></svg>'}
			/>
			<MetricCard
				class="min-w-[140px] flex-1"
				title="Avg Duration"
				value={formatDuration(dashboardData.avgDurationMs)}
				subtitle={dashboardData.averageDurationWindow === 'recent_14_days'
					? 'last 14 days'
					: 'last 150 runs'}
				help="Average time from run start to completion across {dashboardData.averageDurationWindow ===
				'recent_14_days'
					? 'runs started in the last 14 days'
					: 'the most recent 150 completed runs'}."
				icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'}
			/>
			<MetricCard
				class="min-w-[140px] flex-1"
				title="Build Minutes"
				value={formatMinutes(dashboardData.totalMinutes30d)}
				subtitle={dashboardData.actionsCostEstimate
					? `$${dashboardData.actionsCostEstimate.grossCostUsd.toFixed(2)} on-demand estimate`
					: 'Cost estimate unavailable'}
				help="Raw minutes consumed across {timeWindowDescription}. Open the cost estimate for runner pricing, included-minute context, and coverage limitations."
				icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'}
				actionLabel={dashboardData.actionsCostEstimate ? 'View cost' : undefined}
				onAction={() => (showCostDialog = true)}
			/>
			<MetricCard
				class="min-w-[140px] flex-1"
				title="Skip Rate"
				value="{dashboardData.skipRate.toFixed(1)}%"
				subtitle="of triggered runs skipped"
				help="Percentage of workflow runs that were skipped (e.g. condition not met). High skip rates can indicate overly broad triggers or useful conditional logic."
				icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>'}
			/>
		</div>

		<!-- DORA metrics -->
		{#if dashboardData.dora}
			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<p class="text-muted-foreground text-sm font-medium">
						DORA metrics · {timeWindowLabel}
					</p>
					<button
						type="button"
						onclick={() => (showDoraDialog = true)}
						class="text-muted-foreground hover:text-foreground hover:bg-accent focus:ring-ring rounded-full p-1 transition-colors focus:ring-2 focus:outline-none"
						aria-label="Configure DORA workflows"
						title="Configure DORA workflows"
					>
						<svg
							class="size-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path
								d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
							/>
							<circle cx="12" cy="12" r="3" />
						</svg>
					</button>
					<span class="group relative inline-flex flex-shrink-0">
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground focus:ring-ring focus:ring-offset-background rounded-full p-0.5 focus:ring-2 focus:ring-offset-2 focus:outline-none"
							aria-label="What are DORA metrics?"
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
							class="border-border bg-popover text-popover-foreground pointer-events-none absolute top-1/2 left-full z-10 ml-1.5 w-72 -translate-y-1/2 rounded-md border px-3 py-2 text-xs opacity-0 shadow-md transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
							role="tooltip"
						>
							Four key DevOps Research and Assessment (DORA) metrics that measure delivery
							performance: how often you ship, how fast changes go live, how often deployments fail,
							and how quickly you recover from failures.
						</span>
					</span>
				</div>
				{#if !dashboardData.hasDoraWorkflowsSelected}
					<div class="border-border bg-card rounded-lg border border-dashed p-6 text-center">
						<p class="text-muted-foreground mb-3 text-sm">
							Please select production workflows to view accurate DORA metrics.
						</p>
						<button
							type="button"
							onclick={() => (showDoraDialog = true)}
							class="text-foreground bg-secondary hover:bg-secondary/80 focus:ring-ring inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus:ring-2 focus:outline-none"
						>
							<svg
								class="size-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path
									d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
								/>
								<circle cx="12" cy="12" r="3" />
							</svg>
							Configure Production Workflows
						</button>
					</div>
				{:else}
					<div class="flex flex-wrap gap-4">
						<MetricCard
							class="min-w-[140px] flex-1 border-indigo-500/40 bg-indigo-500/[0.03]"
							title="Deployment Frequency"
							value="{dashboardData.dora.deploymentFrequency.perWeek.toFixed(1)} / week"
							subtitle="successful runs"
							help="How often successful workflow runs complete per week. Higher values indicate more frequent delivery. One of four DORA metrics."
							icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>'}
						/>
						<MetricCard
							class="min-w-[140px] flex-1 border-indigo-500/40 bg-indigo-500/[0.03]"
							title="Lead Time for Changes"
							value={formatDuration(dashboardData.dora.leadTimeForChangesMs)}
							subtitle={dashboardData.dora.leadTimeFromCommit
								? 'median commit → run end'
								: 'median trigger → run end'}
							help="Median time from code commit (or workflow trigger) to run completion. Shorter is better. Shown as commit→end when GitHub provides commit time; otherwise trigger→end."
							icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'}
						/>
						<MetricCard
							class="min-w-[140px] flex-1 {failureRateBorderColor(
								dashboardData.dora.changeFailureRate
							)}"
							title="Change Failure Rate"
							value="{dashboardData.dora.changeFailureRate.toFixed(1)}%"
							subtitle="of completed runs"
							valueClass={failureRateColor(dashboardData.dora.changeFailureRate)}
							help="Percentage of completed runs that failed (excluding cancelled/skipped). Lower is better. DORA elite teams typically keep this under 15%."
							icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/></svg>'}
						/>
						<MetricCard
							class="min-w-[140px] flex-1 border-indigo-500/40 bg-indigo-500/[0.03]"
							title="Mean Time to Recovery"
							value={formatDuration(dashboardData.dora.meanTimeToRecoveryMs)}
							subtitle={dashboardData.dora.meanTimeToRecoveryMs != null
								? 'avg time to next success after failure'
								: 'no failures'}
							help="Average time from a failed run finishing until the next successful run completes. Shorter is better. Shown only when there are failures followed by a success."
							icon={'<svg class="size-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>'}
						/>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Charts row -->
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-5">
			<div class="lg:col-span-3">
				<RunHistoryChart
					data={dashboardData.runTrend}
					commits={dashboardData.workflowFileCommits ?? []}
					windowLabel={timeWindowLabel}
				/>
			</div>
			<div class="lg:col-span-2">
				<DurationChart
					metrics={dashboardData.workflowMetrics}
					owner={dashboardData.owner}
					repo={dashboardData.repo}
				/>
			</div>
		</div>

		<!-- Overview / Details tabs -->
		<div class="border-border flex gap-1 border-b" role="tablist">
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'overview'}
				onclick={() => (activeTab = 'overview')}
				class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'overview'
					? 'border-primary text-foreground'
					: 'text-muted-foreground hover:text-foreground border-transparent'}"
			>
				Overview
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'details'}
				onclick={() => (activeTab = 'details')}
				class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'details'
					? 'border-primary text-foreground'
					: 'text-muted-foreground hover:text-foreground border-transparent'}"
			>
				Details
			</button>
		</div>

		{#if activeTab === 'details'}
			<!-- Top skipped workflows -->
			{#if dashboardData.workflowMetrics.filter((m) => m.skippedCount > 0).length > 0}
				{@const topSkipped = [...dashboardData.workflowMetrics]
					.filter((m) => m.skippedCount > 0)
					.sort((a, b) => b.skippedCount - a.skippedCount)
					.slice(0, 8)}
				<div class="bg-card border-border overflow-hidden rounded-xl border">
					<div class="border-border border-b px-5 py-4">
						<h2 class="text-foreground text-sm font-semibold">Top Skipped Workflows</h2>
						<p class="text-muted-foreground mt-0.5 text-xs">
							Workflows with the most skipped runs (condition not met, path filters, etc.)
						</p>
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-xs">
							<thead>
								<tr class="border-border bg-muted/30 border-b">
									<th class="text-muted-foreground px-5 py-2.5 text-left font-medium">Workflow</th>
									<th class="text-muted-foreground px-4 py-2.5 text-right font-medium">Skip rate</th
									>
									<th class="text-muted-foreground px-4 py-2.5 text-right font-medium">Skipped</th>
									<th class="text-muted-foreground px-4 py-2.5 text-right font-medium">Executed</th>
								</tr>
							</thead>
							<tbody>
								{#each topSkipped as row (row.workflowId)}
									<tr class="border-border/50 hover:bg-muted/30 border-b transition-colors">
										<td class="px-5 py-2.5">
											<a
												href={`/dashboard/workflow/${row.workflowId}?owner=${encodeURIComponent(dashboardData.owner)}&repo=${encodeURIComponent(dashboardData.repo)}`}
												class="text-foreground block max-w-48 truncate font-medium hover:underline"
												title={row.workflowName}
											>
												{row.workflowName}
											</a>
										</td>
										<td class="text-muted-foreground px-4 py-2.5 text-right tabular-nums">
											{row.skipRate.toFixed(1)}%
										</td>
										<td class="text-muted-foreground px-4 py-2.5 text-right tabular-nums">
											{row.skippedCount.toLocaleString()}
										</td>
										<td class="text-foreground px-4 py-2.5 text-right font-medium tabular-nums">
											{(row.successCount + row.failureCount).toLocaleString()}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/if}

			<!-- Minutes charts row -->
			{#if dashboardData.totalMinutes30d > 0}
				<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
					<MinutesDonutChart
						data={dashboardData.minutesByWorkflow}
						title="Minutes by Workflow"
						subtitle="Breakdown of build time consumed per workflow"
						totalMinutes={dashboardData.totalMinutes30d}
						totalLabel="raw mins"
					/>
					<MinutesTrendChart
						data={dashboardData.minutesTrend}
						title="Daily Build Minutes"
						subtitle="Raw minutes consumed per day across {timeWindowDescription}"
					/>
				</div>

				<!-- Efficiency insights -->
				<div class="space-y-3">
					<h2 class="text-muted-foreground text-sm font-medium">Efficiency Insights</h2>
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<!-- CFR Alert (shown when > 15%) -->
						{#if dashboardData.dora && dashboardData.dora.changeFailureRate > 15}
							<div class="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/[0.05] p-4">
								<p class="text-muted-foreground text-xs">Change Failure Rate</p>
								<p class="text-sm font-semibold text-amber-500">
									{dashboardData.dora.changeFailureRate.toFixed(1)}%
								</p>
								<p class="text-muted-foreground text-xs">Exceeds 15% DORA elite threshold</p>
							</div>
						{/if}

						<!-- Most expensive workflow -->
						{#if dashboardData.minutesByWorkflow.length > 0}
							{@const top = dashboardData.minutesByWorkflow[0]}
							<div class="bg-card border-border space-y-1 rounded-xl border p-4">
								<p class="text-muted-foreground text-xs">Most Expensive Workflow</p>
								<p class="text-foreground truncate text-sm font-semibold" title={top.workflowName}>
									{top.workflowName}
								</p>
								<p class="text-muted-foreground text-xs">
									{formatMinutes(top.minutes)} raw · {top.percentage}% of total
								</p>
							</div>
						{/if}

						<!-- Wasted minutes -->
						<div class="bg-card border-border space-y-1 rounded-xl border p-4">
							<p class="text-muted-foreground text-xs">Wasted on Failures</p>
							<p
								class="text-sm font-semibold {dashboardData.wastedMinutes > 0
									? 'text-destructive'
									: 'text-green-500'}"
							>
								{formatMinutes(dashboardData.wastedMinutes)}
							</p>
							<p class="text-muted-foreground text-xs">
								{dashboardData.totalMinutes30d > 0
									? Math.round((dashboardData.wastedMinutes / dashboardData.totalMinutes30d) * 100)
									: 0}% of total minutes
							</p>
						</div>

						<!-- Top branch -->
						{#if dashboardData.topBranchByMinutes}
							<div class="bg-card border-border space-y-1 rounded-xl border p-4">
								<p class="text-muted-foreground text-xs">Costliest Branch</p>
								<p
									class="text-foreground truncate font-mono text-sm font-semibold"
									title={dashboardData.topBranchByMinutes.branch}
								>
									{dashboardData.topBranchByMinutes.branch}
								</p>
								<p class="text-muted-foreground text-xs">
									{formatMinutes(dashboardData.topBranchByMinutes.minutes)} consumed
								</p>
							</div>
						{/if}

						<!-- Avg minutes per run -->
						<div class="bg-card border-border space-y-1 rounded-xl border p-4">
							<p class="text-muted-foreground text-xs">Avg per Run</p>
							<p class="text-foreground text-sm font-semibold">
								{dashboardData.totalRuns > 0
									? formatMinutes(
											Math.round(dashboardData.totalMinutes30d / dashboardData.totalRuns)
										)
									: '—'}
							</p>
							<p class="text-muted-foreground text-xs">
								across {totalRunsLabel} runs
							</p>
						</div>
					</div>

					<!-- Run frequency × duration table -->
					{#if dashboardData.workflowMetrics.filter((m) => m.totalRuns > 0).length > 0}
						{@const tableRows = [...dashboardData.workflowMetrics]
							.filter((m) => m.totalRuns > 0)
							.map((m) => {
								const runsPerDay = m.totalRuns / (dashboardData?.timeWindowDays ?? 30);
								const avgMins = Math.ceil(m.avgDurationMs / 60_000);
								const dailyMins = Math.round(runsPerDay * avgMins);
								return { ...m, runsPerDay, dailyMins };
							})
							.sort((a, b) => b.dailyMins - a.dailyMins)
							.slice(0, 8)}
						{@const maxDailyMins = Math.max(...tableRows.map((r) => r.dailyMins), 1)}
						<div class="bg-card border-border overflow-hidden rounded-xl border">
							<div class="border-border border-b px-5 py-4">
								<h2 class="text-foreground text-sm font-semibold">Frequency × Duration</h2>
								<p class="text-muted-foreground mt-0.5 text-xs">
									Workflows sorted by estimated daily minutes consumed
								</p>
							</div>
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-border bg-muted/30 border-b">
											<th class="text-muted-foreground px-5 py-2.5 text-left font-medium"
												>Workflow</th
											>
											<th class="text-muted-foreground px-4 py-2.5 text-right font-medium"
												>Runs / day</th
											>
											<th class="text-muted-foreground px-4 py-2.5 text-right font-medium"
												>Avg duration</th
											>
											<th class="text-muted-foreground px-4 py-2.5 text-right font-medium"
												>Est. daily mins</th
											>
										</tr>
									</thead>
									<tbody>
										{#each tableRows as row (row.workflowId)}
											<tr class="border-border/50 hover:bg-muted/30 border-b transition-colors">
												<td
													class="text-foreground max-w-48 truncate px-5 py-2.5 font-medium"
													title={row.workflowName}
												>
													{row.workflowName}
												</td>
												<td class="text-muted-foreground px-4 py-2.5 text-right tabular-nums">
													{row.runsPerDay.toFixed(1)}
												</td>
												<td class="text-muted-foreground px-4 py-2.5 text-right tabular-nums">
													{formatDuration(row.avgDurationMs)}
												</td>
												<td class="px-4 py-2.5">
													<div class="flex items-center justify-end gap-2">
														<span class="text-foreground font-medium tabular-nums">
															{row.dailyMins > 0 ? formatMinutes(row.dailyMins) : '<1m'}
														</span>
														<div
															class="bg-muted h-1.5 w-16 flex-shrink-0 overflow-hidden rounded-full"
														>
															<div
																class="bg-primary/60 h-full rounded-full"
																style="width: {(row.dailyMins / maxDailyMins) * 100}%"
															></div>
														</div>
													</div>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/if}
		<!-- Workflow inventory stays near the top so active failures are immediately visible. -->
		<WorkflowList
			metrics={dashboardData.workflowMetrics}
			owner={dashboardData.owner}
			repo={dashboardData.repo}
		/>
		<!-- Recent runs -->
		<RecentRuns
			owner={dashboardData.owner}
			repo={dashboardData.repo}
			serverPagination
			lookback={data.actionsLookback}
		/>
	{/if}
</div>

<!-- DORA Workflow Selection Dialog -->
{#if showDoraDialog && dashboardData}
	<DoraWorkflowDialog
		workflows={dashboardData.workflowMetrics}
		selectedIds={dashboardData.doraWorkflowIds ?? []}
		onSave={handleSaveDoraWorkflows}
		onClose={() => (showDoraDialog = false)}
	/>
{/if}

{#if showCostDialog && dashboardData?.actionsCostEstimate}
	<ActionsCostDialog
		estimate={dashboardData.actionsCostEstimate}
		windowLabel={timeWindowLabel}
		onClose={() => (showCostDialog = false)}
	/>
{/if}

<style>
	@keyframes shimmer {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(400%);
		}
	}
</style>
