import { error, json } from '@sveltejs/kit';
import {
	buildDashboardData,
	createOctokit,
	fetchIncrementalWorkflowRunsForRepo,
	isGitHubUnauthorizedError
} from '$lib/server/github';
import { getGitHubAccessToken } from '$lib/server/secrets';
import {
	acquireSyncLock,
	getDashboardSnapshot,
	getWorkflowRuns,
	markReconciled,
	reconciliationDue,
	releaseSyncLock,
	setDashboardSnapshot,
	storeWorkflowRuns,
	type ActionsLookback
} from '$lib/server/workflow-runs-cache';
import type { GitHubWorkflowRun } from '$lib/types/github';
import type { DashboardData } from '$lib/types/metrics';
import type { RequestHandler } from './$types';

type SyncMode = 'none' | 'cached-runs' | 'cold' | 'incremental' | 'reconcile' | 'locked';

interface DashboardContext {
	userId: string;
	owner: string;
	repo: string;
	lookback: ActionsLookback;
	days: number | null;
	doraWorkflowIds: number[];
	octokit: ReturnType<typeof createOctokit>;
}

interface SyncCallbacks {
	onFetchProgress?: (fetched: number, total: number, page: number) => void;
	onRepairProgress?: (completed: number, total: number) => void;
	onComputeStart?: () => void;
}

function parseLookback(value: string | null): ActionsLookback {
	if (value === '7' || value === '30' || value === '90' || value === 'all') return value;
	throw error(400, 'days must be one of 7, 30, 90, or all');
}

function createdFilter(days: number | null): string | undefined {
	if (days === null) return undefined;
	return `>=${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}`;
}

async function syncDashboard(
	context: DashboardContext,
	callbacks: SyncCallbacks = {},
	forceCachedRuns = false
): Promise<{ data: DashboardData; sync: SyncMode }> {
	const { userId, owner, repo, lookback, days, doraWorkflowIds, octokit } = context;
	const cachedRuns = await getWorkflowRuns(userId, owner, repo, lookback);
	const due = cachedRuns.length > 0 && (await reconciliationDue(userId, owner, repo, lookback));
	let runs: GitHubWorkflowRun[] | undefined;
	let sync: SyncMode;

	if (cachedRuns.length > 0 && forceCachedRuns) {
		runs = cachedRuns;
		sync = 'cached-runs';
	} else if (cachedRuns.length > 0 && !due) {
		runs = await fetchIncrementalWorkflowRunsForRepo(
			octokit,
			owner,
			repo,
			cachedRuns,
			createdFilter(days),
			callbacks.onFetchProgress
		);
		sync = 'incremental';
	} else {
		sync = cachedRuns.length > 0 ? 'reconcile' : 'cold';
	}

	let fetchedRuns: GitHubWorkflowRun[] = runs ?? [];
	const data = await buildDashboardData(octokit, owner, repo, {
		days,
		cachedRuns: runs,
		doraWorkflowIds,
		cacheUserId: userId,
		onProgress: callbacks.onFetchProgress,
		onRepairProgress: callbacks.onRepairProgress,
		onComputeStart: callbacks.onComputeStart,
		onRunsFetched: (nextRuns) => {
			fetchedRuns = nextRuns;
		}
	});

	await storeWorkflowRuns(userId, owner, repo, lookback, fetchedRuns);
	await setDashboardSnapshot(userId, owner, repo, lookback, data, doraWorkflowIds);
	if (sync === 'cold' || sync === 'reconcile') await markReconciled(userId, owner, repo, lookback);
	return { data, sync };
}

export const GET: RequestHandler = async ({ url, locals, request }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!owner || !repo) throw error(400, 'Missing owner or repo');
	const lookback = parseLookback(url.searchParams.get('days'));
	const days = lookback === 'all' ? null : Number(lookback);

	const [githubAccessToken, { data: repository }, { data: settings }] = await Promise.all([
		getGitHubAccessToken(user.id),
		locals.supabase
			.from('repositories')
			.select('id')
			.eq('user_id', user.id)
			.eq('owner', owner)
			.eq('name', repo)
			.single(),
		locals.supabase
			.from('user_settings')
			.select('dashboard_refresh_interval')
			.eq('user_id', user.id)
			.single()
	]);
	if (!githubAccessToken) throw error(401, 'GitHub connection not found');
	if (!repository) throw error(403, 'Repository not found or access denied');

	const { data: doraWorkflows } = await locals.supabase
		.from('dora_workflows')
		.select('workflow_id')
		.eq('user_id', user.id)
		.eq('repository_id', repository.id);
	const doraWorkflowIds = doraWorkflows?.map((workflow) => workflow.workflow_id) ?? [];
	const refreshInterval = settings?.dashboard_refresh_interval ?? '5';
	const freshnessMs = refreshInterval === 'realtime' ? 0 : Number(refreshInterval) * 60_000;

	let snapshot;
	try {
		snapshot = await getDashboardSnapshot(
			user.id,
			owner,
			repo,
			lookback,
			freshnessMs,
			doraWorkflowIds
		);
	} catch (cause) {
		console.error('[api/dashboard/data] Redis read failed', cause);
		return unavailable();
	}

	const context: DashboardContext = {
		userId: user.id,
		owner,
		repo,
		lookback,
		days,
		doraWorkflowIds,
		octokit: createOctokit(githubAccessToken)
	};
	const respond = (data: DashboardData, cache: 'fresh' | 'stale' | 'miss', sync: SyncMode) =>
		json(data, {
			headers: {
				'X-Data-Cache': cache,
				'X-Data-Sync': sync,
				...(cache === 'stale' ? { 'X-Data-Stale': 'true' } : {})
			}
		});

	if (snapshot && !snapshot.isStale) return respond(snapshot.dashboardData, 'fresh', 'none');

	if (snapshot?.isStale) {
		const token = await acquireSyncLock(user.id, owner, repo, lookback).catch(() => null);
		if (token) {
			void syncDashboard(context)
				.catch((cause) => console.warn('[api/dashboard/data] Background refresh failed', cause))
				.finally(() => releaseSyncLock(user.id, owner, repo, lookback, token).catch(() => {}));
		}
		return respond(snapshot.dashboardData, 'stale', token ? 'incremental' : 'locked');
	}

	const token = await acquireSyncLock(user.id, owner, repo, lookback).catch(() => null);
	if (!token) return unavailable();

	const cachedRuns = await getWorkflowRuns(user.id, owner, repo, lookback).catch(() => []);
	const forceCachedRuns = cachedRuns.length > 0;
	if (request.headers.get('Accept') === 'text/event-stream') {
		return streamDashboard(context, token, forceCachedRuns);
	}

	try {
		const result = await syncDashboard(context, {}, forceCachedRuns);
		return respond(result.data, 'miss', result.sync);
	} catch (cause) {
		return handleGitHubError(cause);
	} finally {
		await releaseSyncLock(user.id, owner, repo, lookback, token).catch(() => {});
	}
};

type SseEvent =
	| { event: 'progress'; data: { phase: 'fetching'; fetched: number; total: number; page: number } }
	| { event: 'progress'; data: { phase: 'repairing'; completed: number; total: number } }
	| { event: 'progress'; data: { phase: 'computing' } }
	| { event: 'complete'; data: DashboardData }
	| { event: 'error'; data: { message: string } };

function streamDashboard(
	context: DashboardContext,
	token: string,
	forceCachedRuns: boolean
): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const write = (value: SseEvent) =>
		writer.write(encoder.encode(`event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`));
	const writeProgress = (value: Extract<SseEvent, { event: 'progress' }>) => {
		void write(value).catch(() => {
			// The client may navigate away while a cold import continues under the Redis lock.
		});
	};

	void (async () => {
		try {
			const result = await syncDashboard(
				context,
				{
					onFetchProgress: (fetched, total, page) => {
						writeProgress({
							event: 'progress',
							data: { phase: 'fetching', fetched, total, page }
						});
					},
					onRepairProgress: (completed, total) => {
						writeProgress({ event: 'progress', data: { phase: 'repairing', completed, total } });
					},
					onComputeStart: () => {
						writeProgress({ event: 'progress', data: { phase: 'computing' } });
					}
				},
				forceCachedRuns
			);
			await write({ event: 'complete', data: result.data });
		} catch (cause) {
			const message = isGitHubUnauthorizedError(cause)
				? 'GitHub token expired. Please sign in again.'
				: 'Failed to fetch GitHub Actions data. Please retry.';
			await write({ event: 'error', data: { message } }).catch(() => {});
		} finally {
			await releaseSyncLock(
				context.userId,
				context.owner,
				context.repo,
				context.lookback,
				token
			).catch(() => {});
			await writer.close().catch(() => {});
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Data-Cache': 'miss',
			'X-Data-Sync': forceCachedRuns ? 'cached-runs' : 'cold'
		}
	});
}

function unavailable(): Response {
	return json(
		{ message: 'Workflow data cache is temporarily unavailable. Please retry.', retryable: true },
		{ status: 503, headers: { 'Retry-After': '3' } }
	);
}

function handleGitHubError(cause: unknown): never {
	if (isGitHubUnauthorizedError(cause))
		throw error(401, 'GitHub token expired. Please sign in again.');
	console.error('[api/dashboard/data] Sync failed', cause);
	throw error(500, 'Failed to fetch GitHub Actions data. Please check your permissions.');
}
