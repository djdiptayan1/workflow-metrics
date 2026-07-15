import { redirect, error, isHttpError } from '@sveltejs/kit';
import {
	createOctokit,
	buildWorkflowDetailData,
	fetchIncrementalSingleWorkflowRuns,
	isGitHubUnauthorizedError
} from '$lib/server/github';
import { AI_PROVIDER_LABELS, AI_PROVIDER_MODELS, type AIProvider } from '$lib/server/mistral';
import {
	acquireSyncLock,
	getWorkflowDetailSnapshot,
	getWorkflowRuns,
	releaseSyncLock,
	setWorkflowDetailSnapshot,
	storeSingleWorkflowRuns,
	type ActionsLookback
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
	const actionsLookback = (settings?.actions_lookback ?? '30') as ActionsLookback;
	const refreshInterval = settings?.dashboard_refresh_interval ?? '5';
	const freshnessMs = refreshInterval === 'realtime' ? 0 : Number(refreshInterval) * 60_000;
	const lookbackDays = actionsLookback === 'all' ? undefined : Number(actionsLookback);
	const lookbackLabel = lookbackDays ? `Last ${lookbackDays} days` : 'All available history';
	const lookbackDescription = lookbackDays
		? `the last ${lookbackDays} days`
		: 'all available history';

	const octokit = createOctokit(connection.access_token);

	try {
		const provider = (settings?.ai_provider ?? 'openai') as AIProvider;
		const aiModelLabel = `${AI_PROVIDER_LABELS[provider]} · ${settings?.ai_model ?? AI_PROVIDER_MODELS[provider]}`;
		const snapshot = await getWorkflowDetailSnapshot(
			user.id,
			ownerParam,
			repoParam,
			actionsLookback,
			workflowId,
			freshnessMs
		);
		const response = (detailData: Awaited<ReturnType<typeof buildWorkflowDetailData>>) => ({
			detailData,
			owner: ownerParam,
			repo: repoParam,
			hasAiKey,
			aiModelLabel,
			lookbackLabel,
			lookbackDescription
		});
		if (snapshot && !snapshot.isStale) return response(snapshot.data);

		const buildAndCache = async (refreshRuns: boolean) => {
			const cachedRuns = await getWorkflowRuns(
				user.id,
				ownerParam,
				repoParam,
				actionsLookback,
				workflowId
			);
			const created = lookbackDays
				? `>=${new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10)}`
				: undefined;
			let fetchedRuns =
				refreshRuns && cachedRuns.length > 0
					? await fetchIncrementalSingleWorkflowRuns(
							octokit,
							ownerParam,
							repoParam,
							workflowId,
							cachedRuns,
							created
						)
					: cachedRuns;
			const detailData = await buildWorkflowDetailData(octokit, ownerParam, repoParam, workflowId, {
				days: lookbackDays,
				cachedRuns: fetchedRuns.length > 0 ? fetchedRuns : undefined,
				cacheUserId: user.id,
				onRunsFetched: (runs) => {
					fetchedRuns = runs;
				}
			});
			if (refreshRuns || cachedRuns.length === 0) {
				await storeSingleWorkflowRuns(
					user.id,
					ownerParam,
					repoParam,
					actionsLookback,
					workflowId,
					fetchedRuns
				);
			}
			await setWorkflowDetailSnapshot(
				user.id,
				ownerParam,
				repoParam,
				actionsLookback,
				workflowId,
				detailData
			);
			return detailData;
		};
		const scope = `workflow-${workflowId}`;
		if (snapshot?.isStale) {
			const token = await acquireSyncLock(
				user.id,
				ownerParam,
				repoParam,
				actionsLookback,
				scope
			).catch(() => null);
			if (token) {
				void buildAndCache(true)
					.catch((cause) => console.warn('[workflow-detail] Background refresh failed', cause))
					.finally(() =>
						releaseSyncLock(user.id, ownerParam, repoParam, actionsLookback, token, scope).catch(
							() => {}
						)
					);
			}
			return response(snapshot.data);
		}

		const token = await acquireSyncLock(user.id, ownerParam, repoParam, actionsLookback, scope);
		if (!token) throw error(503, 'Workflow cache is refreshing. Please retry.');
		let detailData;
		try {
			detailData = await buildAndCache(false);
		} finally {
			await releaseSyncLock(user.id, ownerParam, repoParam, actionsLookback, token, scope).catch(
				() => {}
			);
		}
		return {
			...response(detailData)
		};
	} catch (e: unknown) {
		if (isHttpError(e)) throw e;
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
