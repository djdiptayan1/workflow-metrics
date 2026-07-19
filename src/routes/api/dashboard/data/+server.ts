import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { waitUntil } from '@vercel/functions';
import {
	buildDashboardData,
	createOctokit,
	fetchIncrementalWorkflowRunsForRepo,
	fetchWorkflowRunPageChunk,
	isGitHubUnauthorizedError
} from '$lib/server/github';
import { getGitHubAccessToken } from '$lib/server/secrets';
import {
	acquireSyncLock,
	appendWorkflowRuns,
	clearAllTimeImportCheckpoint,
	clearWorkflowRunIndexes,
	getAllTimeImportCheckpoint,
	getDashboardSnapshot,
	getWorkflowRuns,
	markReconciled,
	reconciliationDue,
	releaseSyncLock,
	renewSyncLock,
	setAllTimeImportCheckpoint,
	setDashboardSnapshot,
	storeWorkflowRuns,
	type ActionsLookback
} from '$lib/server/workflow-runs-cache';
import type { GitHubWorkflowRun } from '$lib/types/github';
import type { AverageDurationWindow, DashboardData, GitHubPlan } from '$lib/types/metrics';
import { calculateActionsCostEstimate } from '$lib/actions-cost';
import { getGitHubOwnerPlan } from '$lib/server/github-billing-context';
import type { RequestHandler } from './$types';

type SyncMode = 'none' | 'cached-runs' | 'cold' | 'incremental' | 'reconcile' | 'locked';
const ALL_TIME_PAGES_PER_REQUEST = 75;
const ALL_TIME_PAGE_OVERLAP = 2;

interface DashboardContext {
	userId: string;
	owner: string;
	repo: string;
	lookback: ActionsLookback;
	averageDurationWindow: AverageDurationWindow;
	days: number | null;
	doraWorkflowIds: number[];
	octokit: ReturnType<typeof createOctokit>;
	visibility: 'public' | 'private';
	plan: GitHubPlan;
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
	const { userId, owner, repo, lookback, averageDurationWindow, days, doraWorkflowIds, octokit } =
		context;
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
		averageDurationWindow,
		onProgress: callbacks.onFetchProgress,
		onRepairProgress: callbacks.onRepairProgress,
		onComputeStart: callbacks.onComputeStart,
		onRunsFetched: (nextRuns) => {
			fetchedRuns = nextRuns;
		}
	});
	data.actionsCostEstimate = calculateActionsCostEstimate(
		data.minutesByWorkflow,
		context.visibility,
		context.plan,
		'workflow-runtime'
	);

	await storeWorkflowRuns(userId, owner, repo, lookback, fetchedRuns);
	await setDashboardSnapshot(
		userId,
		owner,
		repo,
		lookback,
		averageDurationWindow,
		data,
		doraWorkflowIds
	);
	if (sync === 'cold' || sync === 'reconcile') await markReconciled(userId, owner, repo, lookback);
	return { data, sync };
}

interface AllTimeChunkResult {
	complete: boolean;
	data?: DashboardData;
	importedRuns: number;
	expectedRuns: number;
}

async function syncAllTimeChunk(
	context: DashboardContext,
	token: string,
	callbacks: SyncCallbacks = {}
): Promise<AllTimeChunkResult> {
	let checkpoint = await getAllTimeImportCheckpoint(context.userId, context.owner, context.repo);
	if (!checkpoint) {
		await clearWorkflowRunIndexes(context.userId, context.owner, context.repo, 'all');
		checkpoint = {
			nextPage: 1,
			expectedRuns: 0,
			importedRuns: 0,
			startedAt: new Date().toISOString(),
			passes: 0
		};
	}

	await renewSyncLock(context.userId, context.owner, context.repo, 'all', token);
	const startedAt = Date.now();
	const chunk = await fetchWorkflowRunPageChunk(
		context.octokit,
		context.owner,
		context.repo,
		checkpoint.nextPage,
		ALL_TIME_PAGES_PER_REQUEST,
		(fetched, total, page) => {
			callbacks.onFetchProgress?.(Math.min(checkpoint.importedRuns + fetched, total), total, page);
			void renewSyncLock(context.userId, context.owner, context.repo, 'all', token);
		}
	);
	let importedRuns = await appendWorkflowRuns(
		context.userId,
		context.owner,
		context.repo,
		'all',
		chunk.runs
	);

	if (chunk.nextPage !== null) {
		await setAllTimeImportCheckpoint(context.userId, context.owner, context.repo, {
			...checkpoint,
			nextPage: Math.max(1, chunk.nextPage - ALL_TIME_PAGE_OVERLAP),
			expectedRuns: chunk.expectedRuns,
			importedRuns
		});
		console.info('[workflow-run-import-chunk]', {
			repository: `${context.owner}/${context.repo}`,
			startPage: checkpoint.nextPage,
			pages: chunk.pagesFetched,
			nextPage: Math.max(1, chunk.nextPage - ALL_TIME_PAGE_OVERLAP),
			importedRuns,
			expectedRuns: chunk.expectedRuns,
			durationMs: Date.now() - startedAt
		});
		return { complete: false, importedRuns, expectedRuns: chunk.expectedRuns };
	}

	// Re-read the newest pages before validation so runs created during a multi-request import are included.
	const newest = await fetchWorkflowRunPageChunk(
		context.octokit,
		context.owner,
		context.repo,
		1,
		ALL_TIME_PAGE_OVERLAP
	);
	importedRuns = await appendWorkflowRuns(
		context.userId,
		context.owner,
		context.repo,
		'all',
		newest.runs
	);
	if (importedRuns !== newest.expectedRuns) {
		if (importedRuns > newest.expectedRuns) {
			await clearWorkflowRunIndexes(context.userId, context.owner, context.repo, 'all');
			importedRuns = 0;
		}
		await setAllTimeImportCheckpoint(context.userId, context.owner, context.repo, {
			...checkpoint,
			nextPage: 1,
			expectedRuns: newest.expectedRuns,
			importedRuns,
			passes: checkpoint.passes + 1
		});
		console.warn('[workflow-run-import-validation]', {
			repository: `${context.owner}/${context.repo}`,
			importedRuns,
			expectedRuns: newest.expectedRuns,
			action: importedRuns === 0 ? 'restart' : 'rescan'
		});
		return { complete: false, importedRuns, expectedRuns: newest.expectedRuns };
	}

	const runs = await getWorkflowRuns(context.userId, context.owner, context.repo, 'all');
	callbacks.onComputeStart?.();
	const data = await buildDashboardData(context.octokit, context.owner, context.repo, {
		days: null,
		cachedRuns: runs,
		doraWorkflowIds: context.doraWorkflowIds,
		cacheUserId: context.userId,
		averageDurationWindow: context.averageDurationWindow,
		onRepairProgress: callbacks.onRepairProgress
	});
	data.actionsCostEstimate = calculateActionsCostEstimate(
		data.minutesByWorkflow,
		context.visibility,
		context.plan,
		'workflow-runtime'
	);
	await setDashboardSnapshot(
		context.userId,
		context.owner,
		context.repo,
		'all',
		context.averageDurationWindow,
		data,
		context.doraWorkflowIds
	);
	await markReconciled(context.userId, context.owner, context.repo, 'all');
	await clearAllTimeImportCheckpoint(context.userId, context.owner, context.repo);
	console.info('[workflow-run-import-complete]', {
		repository: `${context.owner}/${context.repo}`,
		importedRuns,
		expectedRuns: newest.expectedRuns,
		durationMs: Date.now() - startedAt
	});
	return { complete: true, data, importedRuns, expectedRuns: newest.expectedRuns };
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
			.select('id, is_private')
			.eq('user_id', user.id)
			.eq('owner', owner)
			.eq('name', repo)
			.single(),
		locals.supabase
			.from('user_settings')
			.select('dashboard_refresh_interval, average_duration_window')
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
	const averageDurationWindow: AverageDurationWindow =
		settings?.average_duration_window === 'recent_14_days' ? 'recent_14_days' : 'recent_150';
	const freshnessMs = refreshInterval === 'realtime' ? 0 : Number(refreshInterval) * 60_000;

	let snapshot;
	try {
		snapshot = await getDashboardSnapshot(
			user.id,
			owner,
			repo,
			lookback,
			averageDurationWindow,
			freshnessMs,
			doraWorkflowIds
		);
	} catch (cause) {
		console.error('[api/dashboard/data] Redis read failed', cause);
		return unavailable();
	}

	const octokit = createOctokit(githubAccessToken);
	const context: DashboardContext = {
		userId: user.id,
		owner,
		repo,
		lookback,
		averageDurationWindow,
		days,
		doraWorkflowIds,
		octokit,
		visibility: repository.is_private ? 'private' : 'public',
		plan: await getGitHubOwnerPlan(octokit, owner)
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
			const refresh = (
				lookback === 'all' ? syncAllTimeChunk(context, token) : syncDashboard(context)
			)
				.catch((cause) => console.warn('[api/dashboard/data] Background refresh failed', cause))
				.finally(() => releaseSyncLock(user.id, owner, repo, lookback, token).catch(() => {}));
			if (env.VERCEL) waitUntil(refresh);
			else void refresh;
		}
		return respond(snapshot.dashboardData, 'stale', token ? 'incremental' : 'locked');
	}

	const token = await acquireSyncLock(user.id, owner, repo, lookback).catch(() => null);
	if (!token) {
		if (lookback === 'all') {
			const checkpoint = await getAllTimeImportCheckpoint(user.id, owner, repo).catch(() => null);
			return importPending(checkpoint?.importedRuns ?? 0, checkpoint?.expectedRuns ?? 0);
		}
		return unavailable();
	}

	const cachedRuns = await getWorkflowRuns(user.id, owner, repo, lookback).catch(() => []);
	const forceCachedRuns = cachedRuns.length > 0;
	if (request.headers.get('Accept') === 'text/event-stream') {
		return streamDashboard(context, token, forceCachedRuns);
	}

	try {
		if (lookback === 'all') {
			const result = await syncAllTimeChunk(context, token);
			return result.complete && result.data
				? respond(result.data, 'miss', 'cold')
				: importPending(result.importedRuns, result.expectedRuns);
		}
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
	| {
			event: 'continue';
			data: { importedRuns: number; expectedRuns: number; retryAfterMs: number };
	  }
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
			if (context.lookback === 'all') {
				const result = await syncAllTimeChunk(context, token, {
					onFetchProgress: (fetched, total, page) => {
						writeProgress({
							event: 'progress',
							data: { phase: 'fetching', fetched, total, page }
						});
					},
					onRepairProgress: (completed, total) => {
						writeProgress({ event: 'progress', data: { phase: 'repairing', completed, total } });
					},
					onComputeStart: () => writeProgress({ event: 'progress', data: { phase: 'computing' } })
				});
				if (result.complete && result.data) {
					await write({ event: 'complete', data: result.data });
				} else {
					await write({
						event: 'continue',
						data: { ...result, retryAfterMs: 250 }
					});
				}
				return;
			}
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

function importPending(importedRuns: number, expectedRuns: number): Response {
	return json(
		{ importing: true, importedRuns, expectedRuns, retryAfterMs: 1_000 },
		{ status: 202, headers: { 'Retry-After': '1' } }
	);
}

function handleGitHubError(cause: unknown): never {
	if (isGitHubUnauthorizedError(cause))
		throw error(401, 'GitHub token expired. Please sign in again.');
	console.error('[api/dashboard/data] Sync failed', cause);
	throw error(500, 'Failed to fetch GitHub Actions data. Please check your permissions.');
}
