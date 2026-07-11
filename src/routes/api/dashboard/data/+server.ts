import { error, json } from '@sveltejs/kit';
import { createOctokit, buildDashboardData, isGitHubUnauthorizedError } from '$lib/server/github';
import { createSupabaseAdminClient } from '$lib/server/supabase';
import { getCachedWorkflowRuns, setCachedWorkflowRuns } from '$lib/server/workflow-runs-cache';
import type { RequestHandler } from './$types';

/**
 * GET /api/dashboard/data?owner=...&repo=...&days=all
 *
 * Returns dashboard data for the given repo. Supports:
 *
 * - ?days=all imports all available GitHub Actions history.
 * - ?days=30 imports a bounded window, capped at 90 days.
 *
 * - Cache-hit (fresh):   returns JSON immediately.
 * - Cache-hit (stale):   returns stale JSON immediately with `X-Data-Stale: true` header,
 *   then refreshes the cache in the background (stale-while-revalidate).
 * - Cache-miss:          if client sends `Accept: text/event-stream`, streams progress
 *   events via SSE so the UI can show a live progress bar; otherwise returns JSON
 *   once all data has been fetched.
 */
export const GET: RequestHandler = async ({ url, locals, request, platform }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!owner || !repo) throw error(400, 'Missing owner or repo');

	const daysParam = url.searchParams.get('days');
	const days =
		daysParam === 'all'
			? null
			: daysParam
				? Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90)
				: 30;

	const { data: connection } = await locals.supabase
		.from('github_connections')
		.select('access_token')
		.eq('user_id', user.id)
		.single();

	if (!connection) throw error(401, 'GitHub connection not found');

	// Fetch the repository to get its ID
	const { data: repository } = await locals.supabase
		.from('repositories')
		.select('id')
		.eq('user_id', user.id)
		.eq('owner', owner)
		.eq('name', repo)
		.single();

	// Fetch DORA workflow selections for this repository
	// undefined = feature not initialized (always empty, show prompt)
	// [] = user cleared all selections (show prompt)
	// [1,2,3] = user selected workflows (filter metrics)
	let doraWorkflowIds: number[] | undefined = undefined;
	if (repository) {
		const { data: doraWorkflows } = await locals.supabase
			.from('dora_workflows')
			.select('workflow_id')
			.eq('user_id', user.id)
			.eq('repository_id', repository.id);

		// If query succeeded (even if empty), set to empty array to show this is initialized
		if (doraWorkflows !== null) {
			doraWorkflowIds = doraWorkflows.length > 0 ? doraWorkflows.map((w) => w.workflow_id) : [];
		}
	}
	const { data: userSettings } = await locals.supabase
		.from('user_settings')
		.select('dashboard_refresh_interval')
		.eq('user_id', user.id)
		.single();
	const refreshInterval = userSettings?.dashboard_refresh_interval ?? '5';
	const freshnessMs = refreshInterval === 'realtime' ? 0 : Number(refreshInterval) * 60_000;

	const windowStart = (() => {
		if (days === null) return '1970-01-01';
		const d = new Date();
		d.setDate(d.getDate() - days);
		return d.toISOString().slice(0, 10);
	})();

	const cachedResult =
		refreshInterval === 'realtime'
			? null
			: await getCachedWorkflowRuns(
					locals.supabase,
					user.id,
					owner,
					repo,
					windowStart,
					freshnessMs
				);

	const octokit = createOctokit(connection.access_token);
	const snapshotMatchesDoraSelection =
		cachedResult?.dashboardData != null &&
		[...(cachedResult.dashboardData.doraWorkflowIds ?? [])].sort().join(',') ===
			[...(doraWorkflowIds ?? [])].sort().join(',');
	const requestStart = performance.now();
	const timing: string[] = [];
	const onTiming = (label: string, ms: number) => {
		timing.push(`${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()};dur=${Math.round(ms)}`);
	};
	const timedJson = (data: unknown, cacheState: 'fresh' | 'stale' | 'miss') =>
		json(data, {
			headers: {
				'X-Data-Cache': cacheState,
				...(cacheState === 'stale' ? { 'X-Data-Stale': 'true' } : {}),
				'Server-Timing': [
					`dashboard;dur=${Math.round(performance.now() - requestStart)}`,
					...timing
				].join(', ')
			}
		});

	// --- Cache hit (fresh) ---
	if (
		cachedResult &&
		!cachedResult.isStale &&
		cachedResult.dashboardData &&
		snapshotMatchesDoraSelection
	) {
		return timedJson(cachedResult.dashboardData, 'fresh');
	}

	// Legacy raw-run cache entries are upgraded in-place on their next read.
	if (cachedResult && !cachedResult.isStale) {
		try {
			const dashboardData = await buildDashboardData(octokit, owner, repo, {
				cachedRuns: cachedResult.runs,
				days,
				doraWorkflowIds,
				onTiming
			});
			const admin = createSupabaseAdminClient();
			await setCachedWorkflowRuns(
				admin ?? locals.supabase,
				user.id,
				owner,
				repo,
				windowStart,
				cachedResult.runs,
				dashboardData
			);
			return timedJson(dashboardData, 'fresh');
		} catch (e: unknown) {
			return handleGitHubError(e);
		}
	}

	// --- Cache hit (stale): return stale data immediately, refresh in background ---
	if (
		cachedResult &&
		cachedResult.isStale &&
		cachedResult.dashboardData &&
		snapshotMatchesDoraSelection
	) {
		// Fire background refresh — update the cache without blocking the response
		const refreshTask = (async () => {
			try {
				const admin = createSupabaseAdminClient();
				const supabaseForWrite = admin ?? locals.supabase;
				let refreshedRuns = cachedResult.runs;
				const dashboardData = await buildDashboardData(octokit, owner, repo, {
					days,
					doraWorkflowIds,
					onRunsFetched: async (runs) => {
						refreshedRuns = runs;
					}
				});
				await setCachedWorkflowRuns(
					supabaseForWrite,
					user.id,
					owner,
					repo,
					windowStart,
					refreshedRuns,
					dashboardData
				);
			} catch (e) {
				console.warn('[api/dashboard/data] Background SWR refresh failed:', e);
			}
		})();

		// On Cloudflare Workers, use waitUntil so the worker stays alive for the background task
		const ctx = platform?.env
			? (platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } }).context
			: undefined;
		if (ctx?.waitUntil) {
			ctx.waitUntil(refreshTask);
		}
		// In Node.js the promise runs fire-and-forget

		return timedJson(cachedResult.dashboardData, 'stale');
	}

	// --- Cache miss ---
	// If client requests SSE, stream progress events for a better UX during long fetches
	const acceptsSSE = request.headers.get('Accept') === 'text/event-stream';

	if (acceptsSSE) {
		return streamDashboardData(
			octokit,
			owner,
			repo,
			days,
			windowStart,
			user.id,
			locals,
			doraWorkflowIds
		);
	}

	// Plain JSON fallback (no SSE support, or client didn't request it)
	try {
		const admin = createSupabaseAdminClient();
		const supabaseForWrite = admin ?? locals.supabase;

		let fetchedRuns: import('$lib/types/github').GitHubWorkflowRun[] = [];
		const dashboardData = await buildDashboardData(octokit, owner, repo, {
			days,
			doraWorkflowIds,
			onTiming,
			onRunsFetched: async (runs) => {
				fetchedRuns = runs;
			}
		});
		await setCachedWorkflowRuns(
			supabaseForWrite,
			user.id,
			owner,
			repo,
			windowStart,
			fetchedRuns,
			dashboardData
		);
		return timedJson(dashboardData, 'miss');
	} catch (e: unknown) {
		return handleGitHubError(e);
	}
};

// ---------------------------------------------------------------------------
// SSE streaming helper
// ---------------------------------------------------------------------------

type SseEvent =
	| { event: 'progress'; data: { phase: 'fetching'; fetched: number; total: number; page: number } }
	| { event: 'progress'; data: { phase: 'computing' } }
	| { event: 'complete'; data: unknown }
	| { event: 'error'; data: { message: string } };

function encodeSse(ev: SseEvent): string {
	return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

function streamDashboardData(
	octokit: ReturnType<typeof createOctokit>,
	owner: string,
	repo: string,
	days: number | null,
	windowStart: string,
	userId: string,
	locals: App.Locals,
	doraWorkflowIds?: number[]
): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	const write = (ev: SseEvent) => {
		writer.write(encoder.encode(encodeSse(ev))).catch(() => {});
	};

	(async () => {
		try {
			const admin = createSupabaseAdminClient();
			const supabaseForWrite = admin ?? locals.supabase;
			let fetchedRuns: import('$lib/types/github').GitHubWorkflowRun[] = [];

			const dashboardData = await buildDashboardData(octokit, owner, repo, {
				days,
				doraWorkflowIds,
				onProgress: (fetched, total, page) => {
					write({
						event: 'progress',
						data: { phase: 'fetching', fetched, total, page }
					});
				},
				onRunsFetched: async (runs) => {
					write({ event: 'progress', data: { phase: 'computing' } });
					fetchedRuns = runs;
				}
			});
			await setCachedWorkflowRuns(
				supabaseForWrite,
				userId,
				owner,
				repo,
				windowStart,
				fetchedRuns,
				dashboardData
			);

			write({ event: 'complete', data: dashboardData });
		} catch (e: unknown) {
			const message = isGitHubUnauthorizedError(e)
				? 'GitHub token expired. Please sign in again.'
				: 'Failed to fetch GitHub Actions data. Please check your permissions.';
			write({ event: 'error', data: { message } });
		} finally {
			writer.close().catch(() => {});
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function handleGitHubError(e: unknown): never {
	if (isGitHubUnauthorizedError(e)) {
		throw error(401, 'GitHub token expired. Please sign in again.');
	}
	const err = e as Record<string, unknown>;
	console.error('[api/dashboard/data] Failed to fetch dashboard data:', err);
	throw error(500, 'Failed to fetch GitHub Actions data. Please check your permissions.');
}
