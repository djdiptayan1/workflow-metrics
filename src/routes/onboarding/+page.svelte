<script lang="ts">
	import { enhance, deserialize, applyAction } from '$app/forms';
	import { SvelteSet } from 'svelte/reactivity';

	let { data } = $props();

	let selectedAccount = $state<string | null>(null);
	let repos = $state<Array<{ id: number; name: string; fullName: string; isPrivate: boolean }>>([]);
	let selectedRepos = new SvelteSet<number>();
	let loadingRepos = $state(false);
	let saving = $state(false);
	let repoError = $state<string | null>(null);
	let repoQuery = $state('');
	const filteredRepos = $derived(
		repos.filter((repo) =>
			`${repo.name} ${repo.fullName}`.toLowerCase().includes(repoQuery.trim().toLowerCase())
		)
	);

	async function selectAccount(account: { login: string; type: string }) {
		selectedAccount = account.login;
		loadingRepos = true;
		repos = [];
		selectedRepos.clear();
		repoError = null;

		const formData = new FormData();
		formData.set('account', account.login);
		formData.set('accountType', account.type);

		try {
			const response = await fetch('?/fetchRepos', { method: 'POST', body: formData });
			const result = deserialize(await response.text());
			applyAction(result);

			if (result.type === 'success' && result.data && 'repos' in result.data) {
				repos = Array.isArray(result.data.repos) ? result.data.repos : [];
			} else if (
				result.type === 'failure' &&
				result.data &&
				typeof result.data === 'object' &&
				'error' in result.data
			) {
				repoError = String((result.data as { error?: unknown }).error);
			}
		} catch (e) {
			repoError = e instanceof Error ? e.message : 'Failed to load repositories';
		} finally {
			loadingRepos = false;
		}
	}

	function toggleRepo(id: number) {
		if (selectedRepos.has(id)) selectedRepos.delete(id);
		else selectedRepos.add(id);
	}

	function toggleSelectAllVisible() {
		const allVisibleSelected = filteredRepos.every((repo) => selectedRepos.has(repo.id));
		for (const repo of filteredRepos) {
			if (allVisibleSelected) selectedRepos.delete(repo.id);
			else selectedRepos.add(repo.id);
		}
	}

	function getSelectedReposData() {
		return repos
			.filter((r) => selectedRepos.has(r.id))
			.map((r) => ({ ...r, owner: selectedAccount! }));
	}
</script>

<svelte:head>
	<title
		>{data.addOrgOnly ? 'Add organization' : 'Select repositories'} · Workflow Metrics</title
	>
</svelte:head>

<main class="bg-background flex min-h-screen flex-col items-center justify-center p-4">
	<div class="w-full max-w-2xl space-y-8">
		{#if data.fromSettings}
			<div class="flex w-full justify-start">
				<a
					href="/settings"
					class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-2 rounded-md py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
				>
					<svg
						class="size-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<polyline points="15 18 9 12 15 6" />
					</svg>
					Back to Settings
				</a>
			</div>
		{/if}
		<div class="space-y-2 text-center">
			<div class="flex items-center justify-center gap-2">
				<img src="/logo.svg" alt="" class="size-8 object-contain" />
				<span class="text-xl font-semibold">Workflow Metrics</span>
			</div>
			<h1 class="text-xl font-semibold">
				{data.addOrgOnly ? 'Add repositories from an organization' : 'Select repositories to track'}
			</h1>
			{#if data.addOrgOnly}
				<p class="text-muted-foreground text-sm">
					Choose an organization, then select which repositories to monitor.
				</p>
			{/if}
		</div>

		<!-- Step 1: Select account/org -->
		<div class="bg-card border-border space-y-4 rounded-xl border p-6">
			<h2 class="text-muted-foreground text-sm font-medium tracking-wide uppercase">
				Step 1 · {data.addOrgOnly ? 'Select organization' : 'Select account or organization'}
			</h2>
			{#if data.addOrgOnly && data.accounts.length === 0}
				<p class="text-muted-foreground text-sm">
					GitHub did not return any organizations for this connection. This is not related to
					tracked repositories. Your account may have no visible organization memberships, an
					organization may require OAuth approval, or the token may need to be refreshed.
				</p>
				<a
					href="/auth/login/github?next=%2Fonboarding%3Fadd%3Dorg%26from%3Dsettings"
					class="text-primary inline-flex text-sm font-medium hover:underline"
					>Refresh GitHub organization access</a
				>
			{/if}
			{#if data.addOrgOnly && data.accounts.length > 0}
				<p class="text-muted-foreground text-sm">
					Don't see all your organizations? GitHub only shows orgs you authorized when you signed
					in.
					<a
						href="/auth/login/github?next=/onboarding?add=org"
						class="text-primary font-medium hover:underline"
					>
						Update GitHub permissions
					</a>
					to grant access to more organizations.
				</p>
			{/if}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
				{#each data.accounts as account (account.login)}
					<button
						type="button"
						onclick={() => selectAccount(account)}
						aria-pressed={selectedAccount === account.login}
						class="focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none
							{selectedAccount === account.login
							? 'border-primary bg-primary/10'
							: 'border-border hover:border-muted-foreground/40'}"
					>
						<img src={account.avatarUrl} alt={account.login} class="size-8 rounded-full" />
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{account.login}</p>
							<p class="text-muted-foreground text-xs capitalize">{account.type}</p>
						</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Step 2: Select repos -->
		{#if selectedAccount}
			<div class="bg-card border-border space-y-4 rounded-xl border p-6">
				<div class="flex items-center justify-between">
					<h2 class="text-muted-foreground text-sm font-medium tracking-wide uppercase">
						Step 2 · Select repositories
					</h2>
					{#if selectedRepos.size > 0}
						<span class="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs">
							{selectedRepos.size} selected
						</span>
					{/if}
				</div>

				{#if loadingRepos}
					<div
						class="text-muted-foreground flex items-center justify-center py-8"
						role="status"
						aria-live="polite"
					>
						<svg class="mr-2 size-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<circle
								class="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								stroke-width="4"
							/>
							<path
								class="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
							/>
						</svg>
						Loading repositories...
					</div>
				{:else if repoError}
					<p class="text-destructive py-6 text-center text-sm" role="alert">{repoError}</p>
				{:else if repos.length === 0}
					<p class="text-muted-foreground py-6 text-center text-sm">No repositories found</p>
				{:else}
					<div class="flex items-center gap-2">
						<label class="relative block flex-1">
							<span class="sr-only">Search repositories</span>
							<input
								bind:value={repoQuery}
								type="search"
								placeholder="Search repositories"
								class="border-border bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border py-2 pr-3 pl-9 text-sm focus:ring-2 focus:outline-none"
							/>
							<svg
								class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
							>
						</label>
						<button
							type="button"
							onclick={toggleSelectAllVisible}
							class="border-border text-foreground hover:bg-muted focus-visible:ring-ring min-h-11 shrink-0 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
						>
							{filteredRepos.every((repo) => selectedRepos.has(repo.id)) && filteredRepos.length > 0
								? 'Deselect all'
								: `Select all (${filteredRepos.length})`}
						</button>
					</div>
					<div class="max-h-80 space-y-2 overflow-y-auto">
						{#each filteredRepos as repo (repo.id)}
							<label
								class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors
								{selectedRepos.has(repo.id)
									? 'border-primary bg-primary/5'
									: 'border-border hover:border-muted-foreground/30'}"
							>
								<span class="relative flex size-4 shrink-0">
									<input
										type="checkbox"
										checked={selectedRepos.has(repo.id)}
										onchange={() => toggleRepo(repo.id)}
										class="border-border checked:border-primary checked:bg-primary focus-visible:ring-ring size-4 cursor-pointer appearance-none rounded border bg-background focus-visible:ring-2 focus-visible:outline-none"
									/>
									<svg
										class="text-primary-foreground pointer-events-none absolute inset-0 m-auto size-3 {selectedRepos.has(repo.id) ? 'opacity-100' : 'opacity-0'}"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="3"
										aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
									>
								</span>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{repo.name}</p>
									<p class="text-muted-foreground text-xs">{repo.fullName}</p>
								</div>
								{#if repo.isPrivate}
									<span
										class="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-xs"
									>
										Private
									</span>
								{/if}
							</label>
						{/each}
						{#if filteredRepos.length === 0}
							<p class="text-muted-foreground py-4 text-center text-sm">
								No repositories match “{repoQuery}”.
							</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Step 3: Save -->
		{#if selectedRepos.size > 0}
			<form
				method="POST"
				action="?/saveRepos"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update();
						saving = false;
					};
				}}
			>
				<input type="hidden" name="connectionId" value={data.connectionId} />
				<input type="hidden" name="repos" value={JSON.stringify(getSelectedReposData())} />
				<button
					type="submit"
					disabled={saving}
					class="bg-primary text-primary-foreground hover:bg-primary/90 w-full rounded-lg px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50"
				>
					{saving
						? 'Setting up...'
						: `Track ${selectedRepos.size} ${selectedRepos.size === 1 ? 'repository' : 'repositories'} →`}
				</button>
			</form>
		{/if}
	</div>
</main>
