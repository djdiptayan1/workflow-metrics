<script lang="ts">
	import { onMount } from 'svelte';
	import type { WorkflowMetrics } from '$lib/types/metrics';
	import { formatDuration, formatRelativeTime, successRateColor } from '$lib/utils';

	type Environment = 'production' | 'development' | 'unknown';
	type Preference = { workflow_id: number; is_pinned: boolean; environment: Environment };
	type EnvFilter = 'all' | Environment | 'historical';
	type SortMode = 'last-run' | 'name';
	const HISTORICAL_CUTOFF_MS = 60 * 24 * 60 * 60 * 1000;

	const ENV_LABEL: Record<Environment, string> = {
		production: 'Production',
		development: 'Development',
		unknown: 'Unclassified'
	};
	// Cycle order for the click-to-classify badge.
	const ENV_CYCLE: Environment[] = ['production', 'development', 'unknown'];

	let { metrics, owner, repo }: { metrics: WorkflowMetrics[]; owner: string; repo: string } =
		$props();
	let preferences = $state<Preference[]>([]);
	let query = $state('');
	let showAll = $state(false);
	let envFilter = $state<EnvFilter>('all');
	let sortMode = $state<SortMode>('last-run');
	let savingId = $state<number | null>(null);
	let errorFor = $state<{ workflowId: number; message: string } | null>(null);

	function inferredEnvironment(metric: WorkflowMetrics): Environment {
		const signal = `${metric.workflowName} ${metric.workflowPath}`.toLowerCase();
		if (/\b(prod|production|deploy|release)\b/.test(signal)) return 'production';
		if (/\b(dev|development|test|staging|ci)\b/.test(signal)) return 'development';
		return 'unknown';
	}

	function preferenceFor(workflowId: number) {
		return preferences.find((preference) => preference.workflow_id === workflowId);
	}

	function isDormantHistorical(metric: WorkflowMetrics) {
		if (!metric.workflowPath.startsWith('historical/')) return false;
		const lastRunAt = metric.lastRunAt ? Date.parse(metric.lastRunAt) : NaN;
		return !Number.isFinite(lastRunAt) || lastRunAt < Date.now() - HISTORICAL_CUTOFF_MS;
	}

	function lastRunTimestamp(metric: WorkflowMetrics) {
		const timestamp = metric.lastRunAt ? Date.parse(metric.lastRunAt) : NaN;
		return Number.isFinite(timestamp) ? timestamp : 0;
	}

	const workflows = $derived(
		metrics
			.map((metric) => {
				const preference = preferenceFor(metric.workflowId);
				return {
					...metric,
					isPinned: preference?.is_pinned ?? false,
					environment: preference?.environment ?? inferredEnvironment(metric),
					isHistorical: isDormantHistorical(metric)
				};
			})
			.sort(
				(a, b) =>
					Number(b.isPinned) - Number(a.isPinned) ||
					(sortMode === 'last-run'
						? lastRunTimestamp(b) - lastRunTimestamp(a)
						: a.workflowName.localeCompare(b.workflowName)) ||
					a.workflowName.localeCompare(b.workflowName) ||
					a.workflowId - b.workflowId
			)
	);

	const envCounts = $derived.by(() => {
		const counts: Record<EnvFilter, number> = {
			all: 0,
			production: 0,
			development: 0,
			unknown: 0,
			historical: 0
		};
		for (const workflow of workflows) {
			if (workflow.isHistorical) counts.historical++;
			else {
				counts.all++;
				counts[workflow.environment]++;
			}
		}
		return counts;
	});

	const filteredWorkflows = $derived(
		workflows.filter((workflow) => {
			if (envFilter === 'historical') {
				if (!workflow.isHistorical) return false;
			} else {
				if (workflow.isHistorical) return false;
				if (envFilter !== 'all' && workflow.environment !== envFilter) return false;
			}
			const term = query.trim().toLowerCase();
			return (
				term === '' ||
				`${workflow.workflowName} ${workflow.workflowPath}`.toLowerCase().includes(term)
			);
		})
	);
	const pinnedWorkflows = $derived(filteredWorkflows.filter((workflow) => workflow.isPinned));
	const remainingWorkflows = $derived(filteredWorkflows.filter((workflow) => !workflow.isPinned));
	const visibleWorkflows = $derived(
		query.trim() || showAll
			? filteredWorkflows
			: [...pinnedWorkflows, ...remainingWorkflows.slice(0, 8)]
	);
	const latestFailure = $derived(
		workflows
			.filter((workflow) => !workflow.isHistorical && workflow.lastConclusion === 'failure')
			.sort((a, b) => lastRunTimestamp(b) - lastRunTimestamp(a))[0] ?? null
	);

	onMount(async () => {
		try {
			const response = await fetch(
				`/api/workflow-preferences?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
			);
			if (!response.ok) return;
			const data = (await response.json()) as { preferences: Preference[] };
			preferences = data.preferences;
		} catch {
			// Preferences are additive; inventory still works with deterministic classification.
		}
	});

	async function savePreference(
		workflowId: number,
		isPinned: boolean,
		environment: Environment,
		actionLabel: string
	) {
		const workflow = workflows.find((item) => item.workflowId === workflowId);
		if (!workflow) return;
		savingId = workflowId;
		errorFor = null;
		try {
			const response = await fetch('/api/workflow-preferences', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ owner, repo, workflowId, isPinned, environment })
			});
			if (!response.ok)
				throw new Error(`Unable to update ${actionLabel} for ${workflow.workflowName}.`);
			preferences = [
				...preferences.filter((item) => item.workflow_id !== workflowId),
				{ workflow_id: workflowId, is_pinned: isPinned, environment }
			];
		} catch (error) {
			errorFor = {
				workflowId,
				message:
					error instanceof Error
						? error.message
						: `Unable to update ${actionLabel} for ${workflow.workflowName}.`
			};
		} finally {
			savingId = null;
		}
	}

	function togglePin(workflowId: number) {
		const preference = preferenceFor(workflowId);
		const workflow = workflows.find((item) => item.workflowId === workflowId);
		if (!workflow) return;
		return savePreference(
			workflowId,
			!(preference?.is_pinned ?? false),
			preference?.environment ?? inferredEnvironment(workflow),
			'pin'
		);
	}

	function cycleEnvironment(workflowId: number) {
		const workflow = workflows.find((item) => item.workflowId === workflowId);
		if (!workflow) return;
		const next = ENV_CYCLE[(ENV_CYCLE.indexOf(workflow.environment) + 1) % ENV_CYCLE.length];
		return savePreference(workflowId, workflow.isPinned, next, 'environment');
	}
</script>

<section class="space-y-3">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-foreground text-sm font-semibold">Workflow inventory</h2>
			<p class="text-muted-foreground mt-0.5 text-xs">
				Search, pin, and triage every workflow in this repository.
			</p>
		</div>
		<div class="flex w-full gap-2 sm:w-auto">
			<label>
				<span class="sr-only">Sort workflows</span>
				<select
					bind:value={sortMode}
					class="border-border bg-card text-foreground focus:ring-ring h-full rounded-md border px-3 text-sm focus:ring-2 focus:outline-none"
				>
					<option value="last-run">Last run</option>
					<option value="name">Name</option>
				</select>
			</label>
			<label class="relative block min-w-0 flex-1 sm:w-72">
				<span class="sr-only">Search workflows</span>
				<input
					bind:value={query}
					type="search"
					placeholder="Search workflows"
					class="border-border bg-card text-foreground placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border py-2 pr-3 pl-9 text-sm focus:ring-2 focus:outline-none"
				/>
				<svg
					class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
				>
			</label>
		</div>
	</div>

	<div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter by environment">
		{#each ['all', 'production', 'development', 'unknown', 'historical'] as const as filter (filter)}
			<button
				type="button"
				onclick={() => (envFilter = filter)}
				aria-pressed={envFilter === filter}
				class="focus:ring-ring rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:ring-2 focus:outline-none {envFilter ===
				filter
					? 'border-primary bg-primary/10 text-primary'
					: 'border-border text-muted-foreground hover:bg-muted'}"
			>
				{filter === 'all' ? 'All' : filter === 'historical' ? 'Historical' : ENV_LABEL[filter]} ({envCounts[
					filter
				]})
			</button>
		{/each}
	</div>

	{#if latestFailure}
		<div
			class="rounded-lg border {latestFailure.environment === 'production'
				? 'border-destructive/40 bg-destructive/10'
				: 'border-amber-500/40 bg-amber-500/10'} p-3"
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<p class="text-foreground text-sm font-medium">
					<span
						class={latestFailure.environment === 'production'
							? 'text-destructive'
							: 'text-amber-600'}
						>{latestFailure.environment === 'production'
							? 'Production workflow failed'
							: 'Workflow failed'}</span
					>
					· {latestFailure.workflowName}
				</p>
				<a
					class="text-foreground hover:bg-card/60 rounded-md border border-current px-3 py-1.5 text-xs font-medium"
					href={`/dashboard/workflow/${latestFailure.workflowId}?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`}
					>Investigate failure</a
				>
			</div>
		</div>
	{/if}

	{#if visibleWorkflows.length === 0}
		<div
			class="border-border bg-card text-muted-foreground rounded-xl border p-6 text-center text-sm"
		>
			{workflows.length === 0
				? 'No workflows found in this repository.'
				: query.trim()
					? `No workflows match “${query}”.`
					: `No ${envFilter === 'all' ? '' : envFilter === 'historical' ? 'historical ' : ENV_LABEL[envFilter as Environment].toLowerCase() + ' '}workflows to show.`}
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
			{#each visibleWorkflows as workflow (workflow.workflowId)}
				<div class="border-border bg-card rounded-xl border p-4">
					<div class="flex items-start gap-3">
						<span
							class="mt-1.5 size-2 shrink-0 rounded-full {workflow.lastConclusion === 'failure'
								? 'bg-destructive'
								: workflow.lastConclusion === 'success'
									? 'bg-success'
									: 'bg-muted-foreground'}"
						></span>
						<a
							href={`/dashboard/workflow/${workflow.workflowId}?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`}
							class="min-w-0 flex-1"
						>
							<div class="flex min-w-0 items-center gap-1.5">
								<p class="text-foreground truncate text-sm font-medium">{workflow.workflowName}</p>
								{#if workflow.environment === 'production'}
									<span
										class="border-primary/40 text-primary shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium"
										>Production</span
									>
								{/if}
							</div>
							<p class="text-muted-foreground truncate font-mono text-xs">
								{workflow.workflowPath}
							</p>
						</a>
						<button
							type="button"
							onclick={() => togglePin(workflow.workflowId)}
							disabled={savingId === workflow.workflowId}
							class="focus:ring-ring shrink-0 rounded-md border px-2 py-1 text-xs font-medium transition-colors focus:ring-2 focus:outline-none disabled:opacity-50 {workflow.isPinned
								? 'border-primary/40 bg-primary/10 text-primary'
								: 'border-border text-muted-foreground hover:bg-muted'}"
							aria-pressed={workflow.isPinned}>{workflow.isPinned ? 'Pinned' : 'Pin'}</button
						>
					</div>
					<div
						class="border-border/50 mt-3 flex items-center justify-between gap-2 border-t pt-3 text-xs"
					>
						<button
							type="button"
							onclick={() => cycleEnvironment(workflow.workflowId)}
							disabled={savingId === workflow.workflowId}
							aria-label={`Environment for ${workflow.workflowName}: ${ENV_LABEL[workflow.environment]}. Click to change.`}
							class="focus:ring-ring rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:ring-2 focus:outline-none disabled:opacity-50 {workflow.environment ===
							'production'
								? 'border-primary/40 text-primary hover:bg-primary/10'
								: workflow.environment === 'development'
									? 'border-border text-foreground hover:bg-muted'
									: 'border-border text-muted-foreground hover:bg-muted'}"
						>
							{ENV_LABEL[workflow.environment]}
						</button>
						<span class="text-muted-foreground tabular-nums">
							{workflow.totalRuns.toLocaleString()} run{workflow.totalRuns === 1 ? '' : 's'}
						</span>
						<span class={successRateColor(workflow.successRate)}
							>{workflow.totalRuns === 0
								? 'N/A'
								: `${workflow.successRate.toFixed(0)}% success`}</span
						>
						<span class="text-muted-foreground"
							>{formatDuration(workflow.avgDurationMs)} · {formatRelativeTime(
								workflow.lastRunAt
							)}</span
						>
					</div>
					{#if errorFor?.workflowId === workflow.workflowId}
						<p class="text-destructive mt-2 text-xs" role="alert">{errorFor.message}</p>
					{/if}
				</div>
			{/each}
		</div>
		{#if query.trim() === '' && remainingWorkflows.length > 8}
			<button
				type="button"
				onclick={() => (showAll = !showAll)}
				aria-expanded={showAll}
				class="text-primary text-sm font-medium hover:underline"
				>{showAll
					? 'Show fewer workflows'
					: `Show ${remainingWorkflows.length - 8} more workflows`}</button
			>
		{/if}
	{/if}
</section>
