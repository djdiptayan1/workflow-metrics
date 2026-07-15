<script lang="ts">
	import type { PageData } from './$types';
	import { formatDuration, formatRelativeTime } from '$lib/utils';
	let { data }: { data: PageData } = $props();
	const failedJob = $derived(data.jobs.find((job) => job.conclusion === 'failure') ?? null);
	const durationMs = $derived(data.durationMs);
	let copyingLog = $state(false);
	let copiedLog = $state(false);
	let analyzing = $state(false);
	let actionError = $state<string | null>(null);
	let analysis = $state<string | null>(null);
	let analysisHtml = $state('');

	async function copyEntireLog() {
		copyingLog = true;
		copiedLog = false;
		actionError = null;
		try {
			const response = await fetch('/api/run-log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ owner: data.owner, repo: data.repo, runId: data.run.id })
			});
			const result = (await response.json()) as { log?: string; message?: string };
			if (!response.ok || !result.log)
				throw new Error(result.message ?? 'Could not fetch the full log.');
			await navigator.clipboard.writeText(result.log);
			copiedLog = true;
			setTimeout(() => (copiedLog = false), 2000);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not copy the log.';
		} finally {
			copyingLog = false;
		}
	}

	async function analyzeFailure() {
		analyzing = true;
		actionError = null;
		try {
			const response = await fetch('/api/run-analysis', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ owner: data.owner, repo: data.repo, runId: data.run.id })
			});
			const result = (await response.json()) as { analysis?: string; message?: string };
			if (!response.ok || !result.analysis)
				throw new Error(result.message ?? 'Could not analyze this failure.');
			analysis = result.analysis;
			const [{ marked }, { default: DOMPurify }] = await Promise.all([
				import('marked'),
				import('dompurify')
			]);
			analysisHtml = DOMPurify.sanitize(marked.parse(result.analysis) as string);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not analyze this failure.';
		} finally {
			analyzing = false;
		}
	}
</script>

<svelte:head><title>Run #{data.run.run_number} · Workflow Metrics</title></svelte:head>

<div class="mx-auto max-w-5xl space-y-6">
	<a
		href={`/dashboard/workflow/${data.workflowId}?owner=${encodeURIComponent(data.owner)}&repo=${encodeURIComponent(data.repo)}`}
		class="text-primary focus-visible:ring-ring rounded-md text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
		>← Back to workflow</a
	>
	<div>
		<p class="text-muted-foreground text-sm">
			{data.run.name ?? 'Workflow run'} · #{data.run.run_number}
		</p>
		<h1 class="text-foreground mt-1 text-xl font-semibold">
			{data.run.conclusion === 'failure' ? 'Failure investigation' : 'Run details'}
		</h1>
		<p class="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
			{#if data.run.head_branch}<span
					class="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 font-mono"
					>{data.run.head_branch}</span
				>{/if}
			{#if data.run.actor?.login}<span>{data.run.actor.login}</span>{/if}
			{#if durationMs != null}<span>{formatDuration(durationMs)}</span>{/if}
			{#if data.run.run_started_at}<span>{formatRelativeTime(data.run.run_started_at)}</span>{/if}
		</p>
	</div>
	{#if failedJob}
		<section class="border-destructive/40 bg-destructive/10 rounded-xl border p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<h2 class="text-destructive text-sm font-semibold">Failed job: {failedJob.name}</h2>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={copyEntireLog}
						disabled={copyingLog}
						class="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
						>{copyingLog ? 'Copying…' : copiedLog ? 'Copied!' : 'Copy entire log'}</button
					>{#if data.hasAiKey}<button
							type="button"
							onclick={analyzeFailure}
							disabled={analyzing}
							class="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
							>{analyzing ? 'Analyzing…' : 'Explain with AI'}</button
						>{:else}<a
							href="/settings"
							title="Add an OpenAI, Gemini, or Mistral API key in settings to enable AI analysis"
							class="border-border text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
							>Explain with AI</a
						>{/if}
				</div>
			</div>
			{#if data.failureExcerpt}<pre
					role="region"
					aria-label="Failure log excerpt"
					class="text-foreground bg-muted focus-visible:ring-ring mt-4 max-h-96 overflow-auto rounded-md p-4 text-xs leading-5 focus-visible:ring-2 focus-visible:outline-none"><code
						>{data.failureExcerpt}</code
					></pre>{:else}<p class="text-muted-foreground mt-2 text-sm">
					GitHub did not return a readable log excerpt. Review the failed step below or open the
					original run.
				</p>{/if}<a
				href={data.run.html_url}
				target="_blank"
				rel="noreferrer"
				class="text-primary focus-visible:ring-ring mt-4 inline-flex rounded-md text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
				>Open full GitHub log ↗</a
			>
		</section>
	{/if}
	{#if actionError}<p class="text-destructive text-sm" role="alert">{actionError}</p>{/if}
	{#if analysis}<section
			class="border-primary/30 bg-primary/5 rounded-xl border p-5"
			role="status"
			aria-live="polite"
		>
			<h2 class="text-foreground text-sm font-semibold">AI failure analysis</h2>
			<div class="analysis-markdown text-foreground mt-3 text-sm leading-6">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- DOMPurify sanitizes this value above. -->
				{@html analysisHtml}
			</div>
		</section>{/if}
	<section class="border-border bg-card overflow-hidden rounded-xl border">
		<div class="border-border border-b px-5 py-4">
			<h2 class="text-foreground text-sm font-semibold">Jobs and steps</h2>
		</div>
		<div class="divide-border divide-y">
			{#if data.jobs.length === 0}
				<p class="text-muted-foreground p-5 text-sm">
					No jobs were scheduled for this run (it may have been cancelled before starting).
				</p>
			{/if}
			{#each data.jobs as job (job.id)}<div class="p-5">
					<div class="flex items-center justify-between gap-3">
						<p
							class="text-sm font-semibold {job.conclusion === 'failure'
								? 'text-destructive'
								: job.conclusion === 'success'
									? 'text-success'
									: 'text-foreground'}"
						>
							{job.name}
						</p>
						<span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
							>{job.conclusion ?? job.status}</span
						>
					</div>
					{#if job.steps.length > 0}<ol class="mt-4 space-y-0">
							{#each job.steps as step, index (step.number)}<li
									class="relative flex gap-3 pb-4 last:pb-0"
								>
									<span
										class="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold {step.conclusion ===
										'failure'
											? 'bg-destructive text-white'
											: step.conclusion === 'success'
												? 'bg-success text-white'
												: 'bg-muted text-muted-foreground'}"
										aria-hidden="true"
										>{step.conclusion === 'failure'
											? '×'
											: step.conclusion === 'success'
												? '✓'
												: '•'}</span
									><span class="sr-only"
										>{step.conclusion === 'failure'
											? 'Failed: '
											: step.conclusion === 'success'
												? 'Succeeded: '
												: 'Pending: '}</span
									>{#if index < job.steps.length - 1}<span
											class="bg-border absolute top-6 left-3 h-[calc(100%-1rem)] w-px"
										></span>{/if}
									<div class="min-w-0 pt-0.5">
										<p
											class="text-sm {step.conclusion === 'failure'
												? 'text-destructive font-medium'
												: 'text-foreground'}"
										>
											{step.name}
										</p>
										<p class="text-muted-foreground mt-0.5 text-xs">
											Step {step.number}
										</p>
									</div>
								</li>{/each}
						</ol>{/if}
				</div>{/each}
		</div>
	</section>
</div>

<style>
	.analysis-markdown :global(h1),
	.analysis-markdown :global(h2),
	.analysis-markdown :global(h3) {
		margin: 1.25rem 0 0.5rem;
		font-weight: 600;
		color: var(--foreground);
	}
	.analysis-markdown :global(h1) {
		font-size: 1.25rem;
	}
	.analysis-markdown :global(h2) {
		font-size: 0.875rem;
	}
	.analysis-markdown :global(p),
	.analysis-markdown :global(ul),
	.analysis-markdown :global(ol) {
		margin: 0.5rem 0;
	}
	.analysis-markdown :global(ul),
	.analysis-markdown :global(ol) {
		padding-left: 1.25rem;
	}
	.analysis-markdown :global(li) {
		margin: 0.25rem 0;
	}
	.analysis-markdown :global(code) {
		border-radius: 0.375rem;
		background: var(--muted);
		padding: 0.1rem 0.25rem;
		font-size: 0.85em;
	}
</style>
