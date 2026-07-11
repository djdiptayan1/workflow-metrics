<script lang="ts">
	import { page } from '$app/state';

	type PullRequest = {
		number: number;
		title: string;
		additions: number | null;
		deletions: number | null;
	};
	type Action = {
		workflowId: number;
		workflowName: string;
		runId: number;
		runNumber: number;
		status: string | null;
		conclusion: string | null;
		updatedAt: string;
	};
	let pullRequest = $state<PullRequest | null>(null);
	let actions = $state<Action[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	const owner = $derived(page.url.searchParams.get('owner'));
	const repo = $derived(page.url.searchParams.get('repo'));
	const number = $derived(page.params.number);

	function actionState(action: Action) {
		return action.conclusion ?? action.status ?? 'queued';
	}

	$effect(() => {
		if (!owner || !repo) {
			errorMessage = 'Missing repository.';
			loading = false;
			return;
		}
		const controller = new AbortController();
		fetch(
			`/api/pull-requests?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&number=${number}`,
			{ signal: controller.signal }
		)
			.then(async (response) => {
				if (!response.ok)
					throw new Error((await response.json()).message ?? 'Could not load pull request.');
				return response.json() as Promise<{ pullRequest: PullRequest; actions: Action[] }>;
			})
			.then((result) => {
				pullRequest = result.pullRequest;
				actions = result.actions;
			})
			.catch((cause: unknown) => {
				if ((cause as { name?: string }).name !== 'AbortError')
					errorMessage = cause instanceof Error ? cause.message : 'Could not load pull request.';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});
</script>

<svelte:head><title>Pull request checks · Workflow Metrics</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6">
	<a
		href={`/pull-requests?owner=${owner}&repo=${repo}`}
		class="text-muted-foreground hover:text-foreground text-sm">← All pull requests</a
	>
	{#if loading}<p class="text-muted-foreground text-sm">Loading checks…</p>
	{:else if errorMessage}<p
			class="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm"
		>
			{errorMessage}
		</p>
	{:else if pullRequest}
		<div>
			<h1 class="text-foreground text-xl font-semibold">
				#{pullRequest.number} · {pullRequest.title}
			</h1>
			<p class="mt-2 font-mono text-sm">
				<span class="text-emerald-500">+{pullRequest.additions ?? '—'}</span>
				<span class="text-destructive">−{pullRequest.deletions ?? '—'}</span> lines changed
			</p>
		</div>
		<section class="border-border bg-card overflow-hidden rounded-xl border">
			<div class="border-border border-b px-5 py-4">
				<h2 class="text-foreground font-semibold">Actions</h2>
			</div>
			{#if actions.length === 0}<p class="text-muted-foreground px-5 py-6 text-sm">
					No GitHub Actions runs found for this pull request.
				</p>
			{:else}{#each actions as action, index (action.workflowId)}
					<a
						href={`/dashboard/workflow/${action.workflowId}/run/${action.runId}?owner=${owner}&repo=${repo}`}
						class={`hover:bg-accent/50 flex items-center justify-between gap-4 px-5 py-4 ${index > 0 ? 'border-border border-t' : ''}`}
					>
						<div>
							<p class="text-foreground text-sm font-medium">{action.workflowName}</p>
							<p class="text-muted-foreground mt-1 text-xs">Run #{action.runNumber}</p>
						</div>
						<span
							class={`rounded-full px-2.5 py-1 text-xs font-medium ${actionState(action) === 'success' ? 'bg-emerald-500/10 text-emerald-500' : actionState(action) === 'failure' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
							>{actionState(action)}</span
						>
					</a>
				{/each}{/if}
		</section>
	{/if}
</div>
