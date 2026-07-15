<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

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
	let pageSize = $state<(typeof PAGE_SIZE_OPTIONS)[number]>(20);
	let cursors = $state<(string | null)[]>([null]);
	let nextCursor = $state<string | null>(null);
	let hasNextPage = $state(false);
	let counts = $state({ open: 0, closed: 0, merged: 0 });

	const page = $derived(cursors.length);
	const selectedTotal = $derived(counts[filter]);
	const total = $derived(counts.open + counts.closed + counts.merged);
	const totalPages = $derived(Math.max(1, Math.ceil(selectedTotal / pageSize)));
	const startItem = $derived(selectedTotal === 0 ? 0 : (page - 1) * pageSize + 1);
	const endItem = $derived(Math.min(page * pageSize, selectedTotal));

	const filteredPullRequests = $derived(
		pullRequests.filter((pull) => {
			const term = query.trim().replace(/^#/, '').toLowerCase();
			if (term !== '') return `${pull.number} ${pull.title}`.toLowerCase().includes(term);
			return true;
		})
	);

	$effect(() => {
		const { owner, name } = data.selectedRepo;
		const cursor = cursors.at(-1) ?? null;
		const controller = new AbortController();
		loading = true;
		errorMessage = null;

		fetch(
			`/api/pull-requests?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&state=${filter}&pageSize=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
			{
				signal: controller.signal
			}
		)
			.then(async (response) => {
				if (!response.ok)
					throw new Error((await response.json()).message ?? 'Could not load pull requests.');
				return response.json() as Promise<{
					items: PullRequest[];
					counts: { open: number; closed: number; merged: number };
					nextCursor: string | null;
					hasNextPage: boolean;
				}>;
			})
			.then((result) => {
				pullRequests = result.items;
				counts = result.counts;
				nextCursor = result.nextCursor;
				hasNextPage = result.hasNextPage;
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
		if (repo) {
			cursors = [null];
			goto(`/pull-requests?owner=${repo.owner}&repo=${repo.name}`);
		}
	}

	function setFilter(value: typeof filter) {
		filter = value;
		query = '';
		cursors = [null];
	}

	function setPageSize(value: (typeof PAGE_SIZE_OPTIONS)[number]) {
		pageSize = value;
		cursors = [null];
	}

	function nextPage() {
		if (hasNextPage && nextCursor) cursors = [...cursors, nextCursor];
	}

	function previousPage() {
		if (cursors.length > 1) cursors = cursors.slice(0, -1);
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
			<p class="text-muted-foreground mt-1 text-sm">
				{data.selectedRepo.full_name}{total > 0 ? ` · ${total.toLocaleString()} total` : ''}
			</p>
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
			{#each ['open', 'closed', 'merged'] as item (item)}
				<button
					type="button"
					onclick={() => setFilter(item as typeof filter)}
					class={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${filter === item ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
					>{item} {counts[item as keyof typeof counts].toLocaleString()}</button
				>
			{/each}
		</div>
		<div class="flex flex-col items-end gap-1">
			<label class="relative mb-1 block w-full sm:w-72">
				<span class="sr-only">Search pull requests</span>
				<input
					bind:value={query}
					type="search"
					placeholder="Filter this page by PR # or title"
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

	{#if selectedTotal > 0}
		<div class="flex flex-wrap items-center justify-end gap-3">
			<span class="text-muted-foreground text-xs">Show</span>
			<div
				class="border-border bg-muted/30 flex rounded-md border p-0.5"
				role="group"
				aria-label="Pull requests per page"
			>
				{#each PAGE_SIZE_OPTIONS as size (size)}
					<button
						type="button"
						onclick={() => setPageSize(size)}
						class="rounded px-2.5 py-1 text-xs font-medium transition-colors {pageSize === size
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}">{size}</button
					>
				{/each}
			</div>
			<span class="text-muted-foreground text-xs">per page</span>
		</div>
	{/if}

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
			{query.trim() ? `No pull requests match “${query}”.` : `No ${filter} pull requests.`}
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

	{#if selectedTotal > pageSize && query.trim() === ''}
		<div class="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4">
			<p class="text-muted-foreground text-xs">
				Showing {startItem}–{endItem} of {selectedTotal.toLocaleString()}
			</p>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="border-border bg-background text-foreground hover:bg-muted/50 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:pointer-events-none disabled:opacity-50"
					disabled={page <= 1}
					onclick={previousPage}>Previous</button
				>
				<span class="text-muted-foreground px-2 text-xs">Page {page} of {totalPages}</span>
				<button
					type="button"
					class="border-border bg-background text-foreground hover:bg-muted/50 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:pointer-events-none disabled:opacity-50"
					disabled={!hasNextPage}
					onclick={nextPage}>Next</button
				>
			</div>
		</div>
	{/if}
</div>
