<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { applyTheme, loadStoredTheme, type ThemePreference } from '$lib/theme';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showAiKey = $state(false);
	let savingSettings = $state(false);
	let savingAiSettings = $state(false);
	let syncing = $state(false);
	let aiProvider = $state<'openai' | 'gemini' | 'mistral'>('openai');
	let aiApiKey = $state('');
	let aiModel = $state('');
	let aiModels = $state<string[]>([]);
	let aiSettingsInitialized = false;
	let loadingModels = $state(false);
	let modelsError = $state('');
	let workflowModes = $derived<Record<string, 'personal' | 'shared'>>({
		...(data.workflowModes ?? {})
	});
	let workflowModeError = $state<string | null>(null);
	let savingWorkflowMode = $state<string | null>(null);

	// Single source of truth for every field either save form submits, so saving one
	// form never reverts unsaved edits made in the other (both forms bind to these).
	let theme = $state<ThemePreference>('dark');
	let actionsLookback = $state('30');
	let dashboardRefreshInterval = $state('5');
	let preferencesInitialized = false;
	$effect(() => {
		if (preferencesInitialized) return;
		theme = loadStoredTheme();
		actionsLookback = data.settings?.actions_lookback ?? '30';
		dashboardRefreshInterval = data.settings?.dashboard_refresh_interval ?? '5';
		preferencesInitialized = true;
	});

	function onThemeChange(next: ThemePreference) {
		theme = next;
		applyTheme(next);
	}

	async function setWorkflowMode(
		repo: { id: string; owner: string; name: string },
		mode: 'personal' | 'shared'
	) {
		savingWorkflowMode = repo.id;
		workflowModeError = null;
		try {
			const response = await fetch('/api/workflow-preferences', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ owner: repo.owner, repo: repo.name, mode })
			});
			if (!response.ok)
				throw new Error(
					mode === 'shared'
						? 'Only GitHub repository admins can enable shared workflow preferences.'
						: 'Unable to update workflow preference mode.'
				);
			workflowModes = { ...workflowModes, [repo.id]: mode };
		} catch (error) {
			workflowModeError =
				error instanceof Error ? error.message : 'Unable to update workflow preference mode.';
		} finally {
			savingWorkflowMode = null;
		}
	}
	$effect(() => {
		if (aiSettingsInitialized) return;
		aiProvider = data.settings?.ai_provider ?? 'openai';
		aiApiKey = data.settings?.ai_api_key ?? '';
		aiModel = data.settings?.ai_model ?? '';
		aiModels = aiModel ? [aiModel] : [];
		aiSettingsInitialized = true;
	});

	async function loadAiModels() {
		loadingModels = true;
		modelsError = '';
		try {
			const response = await fetch('/api/ai/models', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey })
			});
			const result = (await response.json()) as { models?: string[]; message?: string };
			if (!response.ok) throw new Error(result.message ?? 'Could not load models.');
			aiModels = result.models ?? [];
			if (!aiModels.includes(aiModel)) aiModel = aiModels[0] ?? '';
		} catch (e) {
			modelsError = e instanceof Error ? e.message : 'Could not load models.';
		} finally {
			loadingModels = false;
		}
	}

	// Local state for default repo so the select doesn’t reset when the form re-renders before submit
	let defaultRepoId = $state('');
	let lastServerDefaultRepoId = $state<string | null>(null);
	$effect(() => {
		const v = data.settings?.default_repo_id ?? '';
		// Only sync from server when the server value actually changed (e.g. after save), so we don’t overwrite the user’s selection
		if (v !== lastServerDefaultRepoId) {
			lastServerDefaultRepoId = v;
			defaultRepoId = v;
		}
	});
</script>

<svelte:head>
	<title>Settings · Workflow Metrics</title>
</svelte:head>

<div class="max-w-2xl space-y-8">
	<div>
		<h1 class="text-foreground text-xl font-semibold">Settings</h1>
		<p class="text-muted-foreground mt-1 text-sm">
			Manage your account, integrations, and preferences
		</p>
	</div>

	<!-- GitHub Connections -->
	<section class="bg-card border-border overflow-hidden rounded-xl border">
		<div class="border-border border-b p-5">
			<h2 class="text-foreground text-sm font-semibold">GitHub Account</h2>
			<p class="text-muted-foreground mt-0.5 text-xs">Connected GitHub accounts</p>
		</div>
		<div class="divide-border divide-y">
			{#each data.connections as conn (conn.id)}
				<div class="flex items-center gap-4 px-5 py-4">
					<div
						class="bg-secondary flex size-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
					>
						{#if conn.avatar_url}
							<img src={conn.avatar_url} alt={conn.github_username} class="size-full" />
						{:else}
							<svg class="text-muted-foreground size-5" viewBox="0 0 24 24" fill="currentColor">
								<path
									d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
								/>
							</svg>
						{/if}
					</div>
					<div class="flex-1">
						<p class="text-foreground text-sm font-medium">{conn.github_username}</p>
						<p class="text-muted-foreground text-xs">
							Connected {new Date(conn.created_at).toLocaleDateString()}
						</p>
					</div>
					<span
						class="bg-success/10 text-success border-success/20 rounded-full border px-2 py-0.5 text-xs"
					>
						Active
					</span>
				</div>
			{/each}

			{#if data.connections.length === 0}
				<div class="text-muted-foreground px-5 py-6 text-center text-sm">
					No GitHub account connected
				</div>
			{/if}
			<div class="border-border bg-muted/30 border-t px-5 py-3">
				<p class="text-muted-foreground text-xs">
					Missing an organization? GitHub only shows orgs you authorized at sign-in.
					<a
						href="/auth/login/github?next=/onboarding?add=org"
						class="text-primary font-medium hover:underline"
					>
						Update GitHub permissions
					</a>
					to grant access to more organizations.
				</p>
			</div>
		</div>
	</section>

	<!-- Repositories -->
	<section class="bg-card border-border overflow-hidden rounded-xl border">
		<div class="border-border flex items-center justify-between border-b p-5">
			<div>
				<h2 class="text-foreground text-sm font-semibold">Tracked Repositories</h2>
				<p class="text-muted-foreground mt-0.5 text-xs">Repositories you're monitoring</p>
			</div>
			<div class="flex items-center gap-2">
				<form method="POST" action="?/addOrg">
					<button
						type="submit"
						class="border-border text-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-xs transition-colors"
					>
						Add organization
					</button>
				</form>
				<form method="POST" action="?/addRepo">
					<button
						type="submit"
						class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs transition-colors"
					>
						Add repository
					</button>
				</form>
			</div>
		</div>
		<div class="divide-border divide-y">
			{#if workflowModeError}
				<p class="text-destructive px-5 py-3 text-xs" role="alert">{workflowModeError}</p>
			{/if}
			{#each data.repos as repo (repo.id)}
				<div class="flex items-center gap-4 px-5 py-3">
					<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<p class="text-foreground truncate text-sm font-medium">{repo.full_name}</p>
						{#if repo.is_private}
							<span
								class="border-border bg-muted/80 text-muted-foreground shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium"
								>Private</span
							>
						{/if}
						{#if !repo.is_active}
							<span
								class="border-warning/30 bg-warning/10 text-warning shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium"
								>Inactive</span
							>
						{/if}
					</div>
					{#if repo.is_active}
						<form
							method="POST"
							action="?/removeRepo"
							use:enhance={({ cancel }) => {
								if (!confirm(`Stop tracking ${repo.full_name}? You can add it back later.`))
									cancel();
							}}
						>
							<input type="hidden" name="repo_id" value={repo.id} />
							<button
								type="submit"
								class="text-muted-foreground hover:text-destructive min-h-11 px-2 text-xs transition-colors"
							>
								Remove
							</button>
						</form>
					{/if}
					<div
						class="border-border bg-muted/30 flex shrink-0 items-center rounded-md border p-0.5 text-xs"
						role="group"
						aria-label={`Workflow preference mode for ${repo.full_name}`}
					>
						<button
							type="button"
							onclick={() => setWorkflowMode(repo, 'personal')}
							disabled={savingWorkflowMode === repo.id}
							aria-pressed={workflowModes[repo.id] !== 'shared'}
							class="min-h-11 rounded px-2 py-1 {workflowModes[repo.id] !== 'shared'
								? 'bg-card text-foreground shadow-sm'
								: 'text-muted-foreground'}">Personal</button
						>
						<button
							type="button"
							onclick={() => setWorkflowMode(repo, 'shared')}
							disabled={savingWorkflowMode === repo.id}
							aria-pressed={workflowModes[repo.id] === 'shared'}
							title="Requires GitHub repository admin access"
							class="min-h-11 rounded px-2 py-1 {workflowModes[repo.id] === 'shared'
								? 'bg-card text-foreground shadow-sm'
								: 'text-muted-foreground'}">Shared</button
						>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- AI Optimisation -->
	<section class="bg-card border-border overflow-hidden rounded-xl border">
		<div class="border-border border-b p-5">
			<h2 class="text-foreground text-sm font-semibold">AI Optimisation</h2>
			<p class="text-muted-foreground mt-0.5 text-xs">Configure AI-powered workflow optimisation</p>
		</div>

		<!-- GitHub App — required for "Apply as PR" -->
		<div class="border-border space-y-3 border-b px-5 py-4">
			<div class="flex items-start justify-between gap-4">
				<div class="space-y-0.5">
					<p class="text-foreground text-sm font-medium">GitHub App (AI optimisation)</p>
					<p class="text-muted-foreground text-xs">
						Install the Workflow Metrics GitHub App on accounts or organizations to enable the
						"Apply as PR" feature. The app only requests write access to the repositories you
						choose.
					</p>
				</div>
				{#if data.installations.length > 0}
					<span
						class="border-success/20 bg-success/10 text-success flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
					>
						<svg
							class="size-3"
							viewBox="0 0 12 12"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"><path d="M2 6l3 3 5-5" /></svg
						>
						Installed
					</span>
				{:else}
					<span
						class="border-warning/20 bg-warning/10 text-warning flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
					>
						<svg
							class="size-3"
							viewBox="0 0 12 12"
							fill="none"
							stroke="currentColor"
							stroke-width="2"><circle cx="6" cy="6" r="5" /><path d="M6 4v2.5M6 8h.01" /></svg
						>
						Not installed
					</span>
				{/if}
			</div>

			{#if data.appError}
				<p class="text-destructive text-xs">{data.appError}</p>
			{/if}
			{#if data.appSuccess}
				<p class="text-success text-xs">GitHub App installed successfully.</p>
			{/if}
			{#if form?.syncError}
				<p class="text-destructive text-xs">{form.syncError}</p>
			{/if}
			{#if form?.syncResult}
				{#if form.syncResult.added > 0 || form.syncResult.removed > 0}
					<p class="text-success text-xs">
						{form.syncResult.added > 0 && form.syncResult.removed > 0
							? `Synced: ${form.syncResult.added} added, ${form.syncResult.removed} removed.`
							: form.syncResult.added > 0
								? `Synced ${form.syncResult.added} installation${form.syncResult.added > 1 ? 's' : ''}.`
								: `${form.syncResult.removed} installation${form.syncResult.removed > 1 ? 's' : ''} removed.`}
					</p>
				{:else if form.syncResult.notFound}
					<p class="text-warning text-xs">
						No installations found on GitHub matching your accounts. Make sure you installed the app
						on the right account or organization.
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">Already up to date.</p>
				{/if}
			{/if}

			<!-- List of existing installations -->
			{#if data.installations.length > 0}
				<div class="space-y-2">
					{#each data.installations as inst (inst.id)}
						<div
							class="border-success/20 bg-success/5 flex items-center justify-between rounded-lg border px-3 py-2"
						>
							<div class="flex min-w-0 items-center gap-3">
								{#if inst.account_avatar_url}
									<img
										src={inst.account_avatar_url}
										alt=""
										class="bg-muted size-9 shrink-0 rounded-full object-cover"
										width="36"
										height="36"
									/>
								{:else}
									<div
										class="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium"
										aria-hidden="true"
									>
										{(inst.account_name || inst.account_login).charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="min-w-0 space-y-0.5">
									<p class="text-foreground truncate text-xs font-medium">
										{inst.account_name || `@${inst.account_login}`}
										{#if inst.account_name}
											<span class="text-muted-foreground font-normal">(@{inst.account_login})</span>
										{/if}
										<span class="text-muted-foreground ml-1 font-normal">({inst.account_type})</span
										>
									</p>
									<p class="text-muted-foreground text-xs">
										Installed {new Date(inst.created_at).toLocaleDateString()}
									</p>
								</div>
							</div>
							<a
								href={inst.account_type === 'Organization'
									? `https://github.com/organizations/${encodeURIComponent(inst.account_login)}/settings/installations`
									: 'https://github.com/settings/installations'}
								target="_blank"
								rel="noopener noreferrer"
								class="text-muted-foreground hover:text-destructive ml-4 shrink-0 text-xs transition-colors"
							>
								Uninstall on GitHub
							</a>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Install / add more + sync -->
			{#if data.hasGitHubApp}
				<div
					class="border-border bg-muted/20 flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
				>
					<div class="min-w-0 space-y-0.5">
						<p class="text-foreground text-xs font-medium">
							{data.installations.length > 0
								? 'Add another account or organization'
								: 'Install GitHub App'}
						</p>
						<p class="text-muted-foreground text-xs">
							Opens GitHub in a new tab. Use <strong>Refresh</strong> after changing installations on
							GitHub.
						</p>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<!-- Install link — opens in new tab so the user keeps their place -->
						<a
							href="/auth/github-app"
							target="_blank"
							rel="noopener noreferrer"
							class="bg-foreground text-background hover:bg-foreground/90 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
						>
							<svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor"
								><path
									d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
								/></svg
							>
							Install on GitHub
						</a>

						<form
							method="POST"
							action="?/syncInstallations"
							use:enhance={() => {
								syncing = true;
								return async ({ update }) => {
									await update();
									syncing = false;
								};
							}}
						>
							<button
								type="submit"
								disabled={syncing}
								title="Refresh list from GitHub"
								class="border-border text-foreground hover:bg-muted flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50"
							>
								<svg
									class="size-3.5 {syncing ? 'animate-spin' : ''}"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
									<path d="M21 3v5h-5" />
								</svg>
								{syncing ? 'Refreshing…' : 'Refresh'}
							</button>
						</form>
					</div>
				</div>
			{:else}
				<p class="text-muted-foreground text-xs">
					The GitHub App is not configured on this server. Set <span
						class="bg-muted rounded px-1 font-mono">GITHUB_APP_ID</span
					>,
					<span class="bg-muted rounded px-1 font-mono">GITHUB_APP_PRIVATE_KEY</span>, and
					<span class="bg-muted rounded px-1 font-mono">GITHUB_APP_SLUG</span> to enable it.
				</p>
			{/if}
		</div>

		<form
			method="POST"
			action="?/updateSettings"
			class="space-y-6 p-5"
			use:enhance={() => {
				savingAiSettings = true;
				return async ({ update }) => {
					await update();
					savingAiSettings = false;
				};
			}}
		>
			{#if form?.error}
				<div
					class="bg-destructive/10 border-destructive/20 text-destructive rounded-lg border px-4 py-3 text-sm"
				>
					{form.error}
				</div>
			{/if}
			{#if form?.success}
				<div
					class="border-success/20 bg-success/10 text-success rounded-lg border px-4 py-3 text-sm"
				>
					Settings saved successfully.
				</div>
			{/if}
			<input type="hidden" name="theme" value={theme} />
			<input type="hidden" name="default_repo_id" value={defaultRepoId} />
			<input type="hidden" name="actions_lookback" value={actionsLookback} />
			<input type="hidden" name="dashboard_refresh_interval" value={dashboardRefreshInterval} />
			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="ai_provider"
					>AI provider</label
				>
				<select
					id="ai_provider"
					name="ai_provider"
					bind:value={aiProvider}
					onchange={() => {
						aiModel = '';
						aiModels = [];
					}}
					class="bg-background border-input text-foreground focus:ring-ring rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
				>
					<option value="openai">OpenAI</option>
					<option value="gemini">Google Gemini</option>
					<option value="mistral">Mistral AI</option>
				</select>
			</div>
			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="ai_api_key">
					AI API Key
					<span class="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
				</label>
				<p class="text-muted-foreground text-xs">
					Use the API key issued by the selected provider. Keys are stored securely and only used
					server-side.
				</p>
				<div class="flex gap-2">
					<input
						id="ai_api_key"
						name="ai_api_key"
						type={showAiKey ? 'text' : 'password'}
						bind:value={aiApiKey}
						placeholder="Enter your provider API key..."
						class="bg-background border-input text-foreground focus:ring-ring flex-1 rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
					/>
					<button
						type="button"
						onclick={() => (showAiKey = !showAiKey)}
						aria-label={showAiKey ? 'Hide API key' : 'Show API key'}
						aria-pressed={showAiKey}
						class="border-border text-muted-foreground hover:text-foreground min-h-11 rounded-lg border px-3 py-2 transition-colors"
					>
						{#if showAiKey}
							<svg
								class="size-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							>
								<path
									d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
								/>
								<line x1="1" x2="23" y1="1" y2="23" />
							</svg>
						{:else}
							<svg
								class="size-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							>
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
						{/if}
					</button>
				</div>
			</div>
			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="ai_model">Model</label>
				<div class="flex gap-2">
					<select
						id="ai_model"
						name="ai_model"
						bind:value={aiModel}
						disabled={aiModels.length === 0}
						class="bg-background border-input text-foreground focus:ring-ring flex-1 rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none disabled:opacity-50"
					>
						{#if aiModels.length === 0}<option value="">Load models using your API key</option>{/if}
						{#each aiModels as model (model)}<option value={model}>{model}</option>{/each}
					</select>
					<button
						type="button"
						onclick={loadAiModels}
						disabled={loadingModels || !aiApiKey.trim()}
						class="border-border text-foreground hover:bg-muted rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-50"
					>
						{loadingModels ? 'Loading…' : 'Load models'}
					</button>
				</div>
				{#if modelsError}<p class="text-destructive text-xs">{modelsError}</p>{/if}
			</div>
			<div class="pt-2">
				<button
					type="submit"
					disabled={savingAiSettings}
					class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
				>
					{savingAiSettings ? 'Saving...' : 'Save AI settings'}
				</button>
			</div>
		</form>
	</section>

	<!-- Preferences -->
	<section class="bg-card border-border overflow-hidden rounded-xl border">
		<div class="border-border border-b p-5">
			<h2 class="text-foreground text-sm font-semibold">Preferences</h2>
			<p class="text-muted-foreground mt-0.5 text-xs">Configure your Workflow Metrics experience</p>
		</div>
		<form
			method="POST"
			action="?/updateSettings"
			class="space-y-6 p-5"
			use:enhance={() => {
				savingSettings = true;
				return async ({ update }) => {
					await update();
					savingSettings = false;
				};
			}}
		>
			{#if form?.error}
				<div
					class="bg-destructive/10 border-destructive/20 text-destructive rounded-lg border px-4 py-3 text-sm"
				>
					{form.error}
				</div>
			{/if}
			{#if form?.success}
				<div
					class="border-success/20 bg-success/10 text-success rounded-lg border px-4 py-3 text-sm"
				>
					Settings saved successfully.
				</div>
			{/if}
			<input type="hidden" name="ai_provider" value={aiProvider} />
			<input type="hidden" name="ai_api_key" value={aiApiKey} />
			<input type="hidden" name="ai_model" value={aiModel} />
			<!-- Theme -->
			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="theme">Theme</label>
				<select
					id="theme"
					name="theme"
					value={theme}
					onchange={(event) =>
						onThemeChange((event.currentTarget as HTMLSelectElement).value as ThemePreference)}
					class="bg-background border-input text-foreground focus:ring-ring rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
				>
					<option value="dark">Dark (default)</option>
					<option value="light">Light</option>
					<option value="system">System</option>
				</select>
			</div>

			<!-- Actions history -->
			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="actions_lookback">
					Actions history
				</label>
				<select
					id="actions_lookback"
					name="actions_lookback"
					bind:value={actionsLookback}
					class="bg-background border-input text-foreground focus:ring-ring rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
				>
					<option value="7">Last 7 days</option>
					<option value="30">Last 30 days</option>
					<option value="90">Last 90 days</option>
					<option value="all">All available history</option>
				</select>
				<p class="text-muted-foreground text-xs">
					Controls the history used by dashboard metrics, charts, and workflow details.
				</p>
			</div>

			<div class="space-y-2">
				<label class="text-foreground block text-sm font-medium" for="dashboard_refresh_interval">
					Dashboard refresh
				</label>
				<select
					id="dashboard_refresh_interval"
					name="dashboard_refresh_interval"
					bind:value={dashboardRefreshInterval}
					class="bg-background border-input text-foreground focus:ring-ring rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
				>
					<option value="realtime">Realtime (fetch on every visit)</option>
					<option value="5">Every 5 minutes</option>
					<option value="10">Every 10 minutes</option>
					<option value="15">Every 15 minutes</option>
				</select>
				<p class="text-muted-foreground text-xs">
					Controls how long dashboard data is served from cache before GitHub is refreshed.
				</p>
			</div>

			<!-- Default repo -->
			{#if data.repos.length > 0}
				<div class="space-y-2">
					<label class="text-foreground block text-sm font-medium" for="default_repo_id">
						Default Repository
					</label>
					<select
						id="default_repo_id"
						name="default_repo_id"
						bind:value={defaultRepoId}
						class="bg-background border-input text-foreground focus:ring-ring rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
					>
						{#each data.repos.filter((r) => r.is_active) as repo (repo.id)}
							<option value={repo.id}>{repo.full_name}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="pt-2">
				<button
					type="submit"
					disabled={savingSettings}
					class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
				>
					{savingSettings ? 'Saving...' : 'Save settings'}
				</button>
			</div>
		</form>
	</section>

	<!-- Danger zone -->
	<section class="bg-card border-border overflow-hidden rounded-xl border">
		<div class="border-border border-b p-5">
			<h2 class="text-foreground text-sm font-semibold">Account</h2>
		</div>
		<div class="flex items-center justify-between p-5">
			<div>
				<p class="text-foreground text-sm font-medium">Sign out</p>
				<p class="text-muted-foreground text-xs">Sign out of your Workflow Metrics account</p>
			</div>
			<form method="POST" action="/auth/logout">
				<button
					type="submit"
					class="border-border text-foreground hover:bg-muted rounded-lg border px-4 py-2 text-sm transition-colors"
				>
					Sign out
				</button>
			</form>
		</div>
	</section>
</div>
