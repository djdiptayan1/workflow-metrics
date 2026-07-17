<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { applyTheme, loadStoredTheme, type ThemePreference } from '$lib/theme';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let savingSettings = $state(false);
	let savingAiSettings = $state(false);

	let aiProvider = $state<'openai' | 'gemini' | 'mistral'>('openai');
	let aiApiKey = $state('');
	let removeAiApiKey = $state(false);
	let aiModel = $state('');
	let aiModels = $state<string[]>([]);
	let aiSettingsInitialized = false;
	let loadingModels = $state(false);
	let modelsError = $state('');


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

	$effect(() => {
		if (aiSettingsInitialized) return;
		aiProvider = data.settings?.ai_provider ?? 'openai';
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
				body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey.trim() || undefined })
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
				<div class="flex items-center gap-2">
					<label class="text-foreground block text-sm font-medium" for="ai_api_key">
						Replace AI API key
					</label>
					<span
						class={data.aiApiKeyConfigured
							? 'bg-success/10 text-success rounded-full px-2 py-0.5 text-xs font-medium'
							: 'bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium'}
					>
						{data.aiApiKeyConfigured ? 'Configured' : 'Not configured'}
					</span>
				</div>
				<p class="text-muted-foreground text-xs">
					Leave blank to keep the current key. Replacement keys are stored securely and only used
					server-side.
				</p>
				<input
					id="ai_api_key"
					name="ai_api_key"
					type="password"
					bind:value={aiApiKey}
					disabled={removeAiApiKey}
					placeholder="Enter a replacement provider API key..."
					class="bg-background border-input text-foreground focus:ring-ring w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:outline-none disabled:opacity-50"
				/>
				<label class="text-muted-foreground flex items-center gap-2 text-xs">
					<input
						name="remove_ai_api_key"
						type="checkbox"
						value="true"
						bind:checked={removeAiApiKey}
						class="border-input text-primary focus:ring-ring size-4 rounded focus:ring-2"
					/>
					Remove the stored API key
				</label>
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
						{#if aiModels.length === 0}<option value="">Load models with a replacement or stored API key</option>{/if}
						{#each aiModels as model (model)}<option value={model}>{model}</option>{/each}
					</select>
					<button
						type="button"
						onclick={loadAiModels}
						disabled={loadingModels || removeAiApiKey}
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
