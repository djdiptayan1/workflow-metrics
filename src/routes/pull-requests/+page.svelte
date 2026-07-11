<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	type PullRequest = {
		number: number;
		title: string;
		state: 'open' | 'closed';
		mergedAt: string | null;
		draft: boolean;
		author: { login: string; avatarUrl: string | null };
		additions: number | null;
		deletions: number | null;
	};

	let { data }: { data: PageData } = $props();
	let pullRequests = $state<PullRequest[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let filter = $state<'open' | 'closed' | 'merged'>('open');
	let query = $state('');

	const filteredPullRequests = $derived(
		pullRequests.filter((pull) => {
			const matchesState =
				filter === 'merged'
					? Boolean(pull.mergedAt)
					: filter === 'open'
						? pull.state === 'open'
						: pull.state === 'closed' && !pull.mergedAt;
			const term = query.trim().replace(/^#/, '').toLowerCase();
			return (
				matchesState && (term === '' || `${pull.number} ${pull.title}`.toLowerCase().includes(term))
			);
		})
	);

	$effect(() => {
		const { owner, name } = data.selectedRepo;
		const controller = new AbortController();
		loading = true;
		errorMessage = null;

		fetch(
			`/api/pull-requests?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}`,
			{
				signal: controller.signal
			}
		)
			.then(async (response) => {
				if (!response.ok)
					throw new Error((await response.json()).message ?? 'Could not load pull requests.');
				return response.json() as Promise<{ pullRequests: PullRequest[] }>;
			})
			.then((result) => {
				pullRequests = result.pullRequests;
			})
			.catch((cause: unknown) => {
				if ((cause as { name?: string }).name !== 'AbortError')
					errorMessage = cause instanceof Error ? cause.message : 'Could not load pull requests.';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});

		return () => controller.abort();
	});

	function switchRepo(fullName: string) {
		const repo = data.repos.find((item) => item.full_name === fullName);
		if (repo) goto(`/pull-requests?owner=${repo.owner}&repo=${repo.name}`);
	}

	function openPullRequest(number: number) {
		goto(
			`/pull-requests/${number}?owner=${data.selectedRepo.owner}&repo=${data.selectedRepo.name}`
		);
	}
</script>

<svelte:head><title>Pull requests · Workflow Metrics</title></svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between gap-4">
		<div>
			<h1 class="text-foreground text-xl font-semibold">Pull requests</h1>
			<p class="text-muted-foreground mt-1 text-sm">{data.selectedRepo.full_name}</p>
		</div>
		<select
			value={data.selectedRepo.full_name}
			onchange={(event) => switchRepo((event.target as HTMLSelectElement).value)}
			class="bg-card border-border text-foreground rounded-lg border px-3 py-2 text-sm"
		>
			{#each data.repos as repo (repo.full_name)}<option value={repo.full_name}
					>{repo.full_name}</option
				>{/each}
		</select>
	</div>

	<div class="border-border flex flex-wrap items-end justify-between gap-3 border-b">
		<div class="flex gap-2">
			{#each ['open', 'closed', 'merged'] as item}
				<button
					type="button"
					onclick={() => (filter = item as typeof filter)}
					class={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${filter === item ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
					>{item}</button
				>
			{/each}
		</div>
		<label class="relative mb-1 block w-full sm:w-72">
			<span class="sr-only">Search pull requests</span>
			<input
				bind:value={query}
				type="search"
				placeholder="Search PR # or title"
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

	{#if loading}
		<p class="text-muted-foreground text-sm">Loading pull requests…</p>
	{:else if errorMessage}
		<p
			class="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm"
		>
			{errorMessage}
		</p>
	{:else if filteredPullRequests.length === 0}
		<p class="border-border text-muted-foreground rounded-lg border p-6 text-sm">
			No {filter} pull requests{query.trim() ? ` matching “${query}”` : ''}.
		</p>
	{:else}
		<div class="border-border bg-card overflow-hidden rounded-xl border">
			{#each filteredPullRequests as pull, index (pull.number)}
				<button
					type="button"
					onclick={() => openPullRequest(pull.number)}
					class={`hover:bg-accent/50 flex w-full items-center gap-4 px-5 py-4 text-left ${index > 0 ? 'border-border border-t' : ''}`}
				>
					{#if pull.author.avatarUrl}<img
							src={pull.author.avatarUrl}
							alt=""
							class="size-8 rounded-full"
						/>{:else}<div class="bg-muted size-8 rounded-full"></div>{/if}
					<div class="min-w-0 flex-1">
						<p class="text-foreground truncate text-sm font-medium">{pull.title}</p>
						<p class="text-muted-foreground mt-1 text-xs">
							#{pull.number} · {pull.author.login}{pull.draft ? ' · draft' : ''}
						</p>
					</div>
					<span class="font-mono text-xs text-emerald-500">+{pull.additions ?? '—'}</span>
					<span class="text-destructive font-mono text-xs">−{pull.deletions ?? '—'}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
