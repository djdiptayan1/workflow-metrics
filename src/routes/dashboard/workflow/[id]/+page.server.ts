import { redirect, error } from '@sveltejs/kit';
import {
	createOctokit,
	buildWorkflowDetailData,
	isGitHubUnauthorizedError
} from '$lib/server/github';
import { createSupabaseAdminClient } from '$lib/server/supabase';
import { AI_PROVIDER_LABELS, type AIProvider } from '$lib/server/mistral';
import {
	getCachedWorkflowDetailRuns,
	setCachedWorkflowDetailRuns
} from '$lib/server/workflow-runs-cache';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, params }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw redirect(303, '/auth/login');

	const workflowId = parseInt(params.id, 10);
	if (isNaN(workflowId)) throw error(400, 'Invalid workflow ID');

	const ownerParam = url.searchParams.get('owner');
	const repoParam = url.searchParams.get('repo');
	if (!ownerParam || !repoParam) throw redirect(303, '/dashboard');

	const { data: connection } = await locals.supabase
		.from('github_connections')
		.select('access_token')
		.eq('user_id', user.id)
		.single();

	if (!connection) throw redirect(303, '/auth/login');

	// Check user has access to this repo
	const { data: repo } = await locals.supabase
		.from('repositories')
		.select('id')
		.eq('user_id', user.id)
		.eq('owner', ownerParam)
		.eq('name', repoParam)
		.single();

	if (!repo) throw error(403, 'Repository not found or access denied');

	const { data: settings } = await locals.supabase
		.from('user_settings')
		.select('ai_provider, ai_api_key, ai_model, actions_lookback, dashboard_refresh_interval')
		.eq('user_id', user.id)
		.single();

	const hasAiKey = !!settings?.ai_api_key;
	const actionsLookback = settings?.actions_lookback ?? '30';
	const refreshInterval = settings?.dashboard_refresh_interval ?? '5';
	const freshnessMs = refreshInterval === 'realtime' ? 0 : Number(refreshInterval) * 60_000;
	const lookbackDays = actionsLookback === 'all' ? undefined : Number(actionsLookback);
	const windowStart = lookbackDays
		? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
		: '1970-01-01';
	const lookbackLabel = lookbackDays ? `Last ${lookbackDays} days` : 'All available history';
	const lookbackDescription = lookbackDays
		? `the last ${lookbackDays} days`
		: 'all available history';

	const cachedResult =
		refreshInterval === 'realtime'
			? null
			: await getCachedWorkflowDetailRuns(
					locals.supabase,
					user.id,
					ownerParam,
					repoParam,
					workflowId,
					windowStart,
					freshnessMs
				);

	const octokit = createOctokit(connection.access_token);

	try {
		const provider = (settings?.ai_provider ?? 'openai') as AIProvider;
		const aiModelLabel = `${AI_PROVIDER_LABELS[provider]} · ${settings?.ai_model ?? (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini')}`;

		const detailData = await buildWorkflowDetailData(octokit, ownerParam, repoParam, workflowId, {
			days: lookbackDays,
			cachedRuns: cachedResult?.runs,
			onRunsFetched: async (runs) => {
				try {
					const admin = createSupabaseAdminClient();
					const supabaseForWrite = admin ?? locals.supabase;
					const result = await setCachedWorkflowDetailRuns(
						supabaseForWrite,
						user.id,
						ownerParam,
						repoParam,
						workflowId,
						windowStart,
						runs
					);
					if (!result.ok) {
						console.warn('[workflow-detail] Cache write failed:', result.error);
					}
				} catch (e) {
					console.error('[workflow-detail] Cache write error:', e);
				}
			}
		});
		return {
			detailData,
			owner: ownerParam,
			repo: repoParam,
			hasAiKey,
			aiModelLabel,
			lookbackLabel,
			lookbackDescription
		};
	} catch (e: unknown) {
		if (isGitHubUnauthorizedError(e)) {
			throw redirect(
				303,
				'/auth/login?error=' +
					encodeURIComponent('GitHub token expired. Please sign in again to reconnect.')
			);
		}
		console.error('Failed to fetch workflow detail:', e);
		throw error(500, 'Failed to fetch workflow data');
	}
};
