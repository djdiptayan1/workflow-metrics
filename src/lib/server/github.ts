import { Octokit } from '@octokit/rest';
import { parse as parseYaml } from 'yaml';
import { computeDurationMs, percentile } from '$lib/utils';
import type { GitHubWorkflow, GitHubWorkflowRun, GitHubJob } from '$lib/types/github';
import type {
	DashboardData,
	DoraMetrics,
	WorkflowDetailData,
	WorkflowMetrics,
	RunDataPoint,
	DurationDataPoint,
	RecentRun,
	JobBreakdown,
	WorkflowFileCommit,
	MinutesDataPoint,
	WorkflowMinutesShare,
	JobMinutesShare,
	StepBreakdown,
	RunnerType,
	WorkflowJobNode,
	WorkflowJobEdge,
	AverageDurationWindow
} from '$lib/types/metrics';
import { buildJobGraphFromWorkflow } from '$lib/server/workflow-graph';
import {
	getRunTiming,
	normalizeWorkflowRun,
	repairWorkflowRunTimings,
	summarizeTimingQuality
} from '$lib/server/run-timing';
import { getCachedWorkflowFile, setCachedWorkflowFile } from '$lib/server/workflow-runs-cache';

export function createOctokit(accessToken: string): Octokit {
	return new Octokit({ auth: accessToken });
}

/** Detect 401 / Bad credentials from GitHub API (e.g. after OAuth was reset). */
export function isGitHubUnauthorizedError(e: unknown): boolean {
	if (e == null || typeof e !== 'object') return false;
	const err = e as Record<string, unknown>;
	const status =
		typeof err.status === 'number'
			? err.status
			: typeof (err.response as Record<string, unknown>)?.status === 'number'
				? (err.response as Record<string, unknown>).status
				: undefined;
	const data = (err.response as Record<string, unknown>)?.data as
		| Record<string, unknown>
		| undefined;
	const message =
		typeof err.message === 'string'
			? err.message
			: typeof data?.message === 'string'
				? data.message
				: '';
	return (
		status === 401 ||
		data?.message === 'Bad credentials' ||
		(message !== '' && message.includes('Bad credentials'))
	);
}

export async function fetchWorkflows(
	octokit: Octokit,
	owner: string,
	repo: string
): Promise<GitHubWorkflow[]> {
	const workflows = await octokit.paginate(octokit.rest.actions.listRepoWorkflows, {
		owner,
		repo,
		per_page: 100
	});
	return (workflows as GitHubWorkflow[]).filter((workflow) => !isReusableWorkflow(workflow));
}

function isReusableWorkflow(workflow: GitHubWorkflow): boolean {
	const fileName = workflow.path.split('/').pop() ?? '';
	return fileName.startsWith('_');
}

export async function fetchWorkflowRuns(
	octokit: Octokit,
	owner: string,
	repo: string,
	options: { per_page?: number; page?: number; created?: string } = {}
): Promise<GitHubWorkflowRun[]> {
	const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
		owner,
		repo,
		per_page: options.per_page ?? 100,
		page: options.page ?? 1,
		exclude_pull_requests: true,
		...(options.created ? { created: options.created } : {})
	});
	return (data.workflow_runs as unknown as GitHubWorkflowRun[]).map(normalizeWorkflowRun);
}

export type TimingCollector = (label: string, ms: number, meta?: Record<string, number>) => void;
export type ProgressCallback = (fetched: number, total: number, page: number) => void;

function createdCutoff(created?: string): number | null {
	if (!created?.startsWith('>=')) return null;
	const parsed = Date.parse(created.slice(2));
	return Number.isFinite(parsed) ? parsed : null;
}

function isBeforeCutoff(run: GitHubWorkflowRun, cutoff: number | null): boolean {
	if (cutoff === null) return false;
	const createdAt = Date.parse(run.created_at);
	return Number.isFinite(createdAt) && createdAt < cutoff;
}

const WORKFLOW_RUN_PAGE_SIZE = 100;
const WORKFLOW_RUN_CONCURRENCY = 3;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_CONCURRENT_IMPORT_ATTEMPTS = 2;

export interface WorkflowRunPageChunk {
	runs: GitHubWorkflowRun[];
	expectedRuns: number;
	pagesFetched: number;
	nextPage: number | null;
}

interface WorkflowRunRequestState {
	serial: boolean;
	serialTail: Promise<void>;
	retries: number;
	rateLimitRemaining: number | null;
}

class UnstableWorkflowRunListingError extends Error {
	constructor(
		message: string,
		readonly pages = 0,
		readonly sourceTotal = 0
	) {
		super(message);
	}
}

function responseHeader(headers: unknown, name: string): string | null {
	if (!headers || typeof headers !== 'object') return null;
	const value = (headers as Record<string, unknown>)[name];
	return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function errorStatus(cause: unknown): number | null {
	if (!cause || typeof cause !== 'object') return null;
	const error = cause as Record<string, unknown>;
	if (typeof error.status === 'number') return error.status;
	const response = error.response as Record<string, unknown> | undefined;
	return typeof response?.status === 'number' ? response.status : null;
}

function errorHeaders(cause: unknown): unknown {
	if (!cause || typeof cause !== 'object') return null;
	return ((cause as Record<string, unknown>).response as Record<string, unknown> | undefined)
		?.headers;
}

function rateLimitDelayMs(cause: unknown, attempt: number): number {
	const headers = errorHeaders(cause);
	const retryAfterHeader = responseHeader(headers, 'retry-after');
	const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
	if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000;
	const resetHeader = responseHeader(headers, 'x-ratelimit-reset');
	const reset = resetHeader === null ? NaN : Number(resetHeader);
	if (Number.isFinite(reset) && reset > 0)
		return Math.min(Math.max(reset * 1_000 - Date.now(), 1_000), 3_600_000);
	return Math.min(60_000 * 2 ** attempt, 300_000);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await mapper(items[index], index);
			}
		})
	);
	return results;
}

async function requestWorkflowRunsForRepo(
	octokit: Octokit,
	owner: string,
	repo: string,
	state: WorkflowRunRequestState,
	options: { per_page: number; page: number }
) {
	const requestOnce = () =>
		octokit.rest.actions.listWorkflowRunsForRepo({
			owner,
			repo,
			...options,
			exclude_pull_requests: true
		});
	const requestQueued = () => {
		if (!state.serial) return requestOnce();
		const queued = state.serialTail.then(requestOnce, requestOnce);
		state.serialTail = queued.then(
			() => undefined,
			() => undefined
		);
		return queued;
	};

	for (let attempt = 0; ; attempt++) {
		try {
			const response = await requestQueued();
			const remainingHeader = responseHeader(response.headers, 'x-ratelimit-remaining');
			const remaining = remainingHeader === null ? NaN : Number(remainingHeader);
			if (Number.isFinite(remaining)) state.rateLimitRemaining = remaining;
			return response;
		} catch (cause) {
			const status = errorStatus(cause);
			if ((status !== 403 && status !== 429) || attempt >= MAX_RATE_LIMIT_RETRIES) throw cause;
			state.serial = true;
			state.retries++;
			await sleep(rateLimitDelayMs(cause, attempt));
		}
	}
}

function uniqueSortedRuns(runs: GitHubWorkflowRun[]): GitHubWorkflowRun[] {
	return [...new Map(runs.map((run) => [run.id, run])).values()].sort(
		(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
	);
}

/** Fetches a bounded page range for resumable serverless all-time imports. */
export async function fetchWorkflowRunPageChunk(
	octokit: Octokit,
	owner: string,
	repo: string,
	startPage: number,
	maxPages: number,
	onProgress?: ProgressCallback
): Promise<WorkflowRunPageChunk> {
	const state: WorkflowRunRequestState = {
		serial: false,
		serialTail: Promise.resolve(),
		retries: 0,
		rateLimitRemaining: null
	};
	const firstPage = Math.max(1, startPage);
	const first = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
		per_page: WORKFLOW_RUN_PAGE_SIZE,
		page: firstPage
	});
	const expectedRuns = first.data.total_count ?? first.data.workflow_runs.length;
	const lastPage = Math.max(1, Math.ceil(expectedRuns / WORKFLOW_RUN_PAGE_SIZE));
	const endPage = Math.min(lastPage, firstPage + Math.max(1, maxPages) - 1);
	const pages = new Map<number, GitHubWorkflowRun[]>([
		[
			firstPage,
			((first.data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(normalizeWorkflowRun)
		]
	]);
	onProgress?.(pages.get(firstPage)?.length ?? 0, expectedRuns, firstPage);

	for (let page = firstPage + 1; page <= endPage; page += WORKFLOW_RUN_CONCURRENCY) {
		const pageNumbers = Array.from(
			{ length: Math.min(WORKFLOW_RUN_CONCURRENCY, endPage - page + 1) },
			(_, index) => page + index
		);
		const batch = await mapLimit(pageNumbers, WORKFLOW_RUN_CONCURRENCY, async (pageNumber) => {
			const { data } = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
				per_page: WORKFLOW_RUN_PAGE_SIZE,
				page: pageNumber
			});
			const runs = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
				normalizeWorkflowRun
			);
			onProgress?.(
				[...pages.values()].reduce((sum, value) => sum + value.length, 0) + runs.length,
				expectedRuns,
				pageNumber
			);
			return [pageNumber, runs] as const;
		});
		for (const [pageNumber, runs] of batch) pages.set(pageNumber, runs);
	}

	return {
		runs: uniqueSortedRuns([...pages.values()].flat()),
		expectedRuns,
		pagesFetched: pages.size,
		nextPage: endPage < lastPage ? endPage + 1 : null
	};
}

async function fetchWorkflowRunsConcurrently(
	octokit: Octokit,
	owner: string,
	repo: string,
	state: WorkflowRunRequestState,
	created?: string,
	onTiming?: TimingCollector,
	onProgress?: ProgressCallback,
	progressFloor = 0,
	pageFloor = 0
): Promise<{ runs: GitHubWorkflowRun[]; pages: number; sourceTotal: number }> {
	const cutoff = createdCutoff(created);
	const firstStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
	const firstResponse = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
		per_page: WORKFLOW_RUN_PAGE_SIZE,
		page: 1
	});
	const firstRuns = (
		(firstResponse.data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]
	).map(normalizeWorkflowRun);
	if (onTiming && typeof performance !== 'undefined')
		onTiming(
			'GitHub: listWorkflowRunsForRepo concurrent page',
			performance.now() - firstStartedAt,
			{
				runsInPage: firstRuns.length
			}
		);

	const sourceTotal = firstResponse.data.total_count ?? firstRuns.length;
	const firstRunId = firstRuns[0]?.id ?? null;
	const pages = [firstRuns];
	let completedPages = 1;
	let fetched = firstRuns.length;
	let nextPage = 2;
	let done =
		firstRuns.length < WORKFLOW_RUN_PAGE_SIZE ||
		firstRuns.some((run) => isBeforeCutoff(run, cutoff));
	onProgress?.(Math.max(progressFloor, fetched), sourceTotal, pageFloor + completedPages);

	while (!done) {
		const lastPage = Math.ceil(sourceTotal / WORKFLOW_RUN_PAGE_SIZE);
		const pageNumbers = Array.from(
			{ length: Math.max(0, Math.min(WORKFLOW_RUN_CONCURRENCY, lastPage - nextPage + 1)) },
			(_, index) => nextPage + index
		);
		if (pageNumbers.length === 0) break;
		const batch = await mapLimit(pageNumbers, WORKFLOW_RUN_CONCURRENCY, async (page) => {
			const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
			const { data } = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
				per_page: WORKFLOW_RUN_PAGE_SIZE,
				page
			});
			const runs = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
				normalizeWorkflowRun
			);
			completedPages++;
			fetched += runs.length;
			onProgress?.(Math.max(progressFloor, fetched), sourceTotal, pageFloor + completedPages);
			if (onTiming && typeof performance !== 'undefined')
				onTiming('GitHub: listWorkflowRunsForRepo concurrent page', performance.now() - startedAt, {
					runsInPage: runs.length
				});
			return runs;
		});
		pages.push(...batch);
		done = batch.some(
			(runs) =>
				runs.length < WORKFLOW_RUN_PAGE_SIZE || runs.some((run) => isBeforeCutoff(run, cutoff))
		);
		nextPage += pageNumbers.length;
	}

	const finalResponse = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
		per_page: 1,
		page: 1
	});
	const finalTotal = finalResponse.data.total_count ?? finalResponse.data.workflow_runs.length;
	const finalRunId =
		(finalResponse.data.workflow_runs[0] as { id?: number } | undefined)?.id ?? null;
	const runs = uniqueSortedRuns(pages.flat().filter((run) => !isBeforeCutoff(run, cutoff)));
	if (
		finalTotal !== sourceTotal ||
		finalRunId !== firstRunId ||
		(cutoff === null && runs.length !== finalTotal)
	) {
		throw new UnstableWorkflowRunListingError(
			`unstable-listing:${sourceTotal}/${finalTotal}/${runs.length}`,
			pages.length,
			Math.max(sourceTotal, finalTotal)
		);
	}
	return { runs, pages: pages.length, sourceTotal: finalTotal };
}

async function fetchWorkflowRunsSerially(
	octokit: Octokit,
	owner: string,
	repo: string,
	created: string | undefined,
	state: WorkflowRunRequestState,
	onTiming?: TimingCollector,
	onProgress?: ProgressCallback,
	progressFloor = 0,
	pageFloor = 0
): Promise<{ runs: GitHubWorkflowRun[]; pages: number; sourceTotal: number }> {
	const runs: GitHubWorkflowRun[] = [];
	const cutoff = createdCutoff(created);
	let page = 1;
	let total = 0;
	while (true) {
		const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
		const { data } = await requestWorkflowRunsForRepo(octokit, owner, repo, state, {
			per_page: WORKFLOW_RUN_PAGE_SIZE,
			page
		});
		const pageRuns = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
			normalizeWorkflowRun
		);
		if (onTiming && typeof performance !== 'undefined')
			onTiming(`GitHub: listWorkflowRunsForRepo page ${page}`, performance.now() - startedAt, {
				runsInPage: pageRuns.length
			});
		if (page === 1) total = data.total_count ?? pageRuns.length;
		runs.push(...pageRuns.filter((run) => !isBeforeCutoff(run, cutoff)));
		onProgress?.(
			Math.max(progressFloor, Math.min(page * WORKFLOW_RUN_PAGE_SIZE, total)),
			total,
			pageFloor + page
		);
		if (
			pageRuns.length < WORKFLOW_RUN_PAGE_SIZE ||
			pageRuns.some((run) => isBeforeCutoff(run, cutoff))
		)
			break;
		page++;
	}
	return { runs: uniqueSortedRuns(runs), pages: page, sourceTotal: total };
}

/** Fetches unfiltered pages concurrently and falls back to serial pagination if the listing moves. */
export async function fetchAllWorkflowRunsForRepo(
	octokit: Octokit,
	owner: string,
	repo: string,
	created?: string,
	onTiming?: TimingCollector,
	onProgress?: ProgressCallback
): Promise<GitHubWorkflowRun[]> {
	const startedAt = Date.now();
	const state: WorkflowRunRequestState = {
		serial: false,
		serialTail: Promise.resolve(),
		retries: 0,
		rateLimitRemaining: null
	};
	let expected = 0;
	let pageCount = 0;
	let uniqueCount = 0;
	let fallbackReason: string | null = null;
	let progressFloor = 0;
	let attempts = 0;

	try {
		for (; attempts < MAX_CONCURRENT_IMPORT_ATTEMPTS; attempts++) {
			try {
				const fetched = await fetchWorkflowRunsConcurrently(
					octokit,
					owner,
					repo,
					state,
					created,
					onTiming,
					onProgress,
					progressFloor,
					pageCount
				);
				attempts++;
				pageCount += fetched.pages;
				expected = fetched.sourceTotal;
				uniqueCount = fetched.runs.length;
				fallbackReason = null;
				return fetched.runs;
			} catch (cause) {
				if (!(cause instanceof UnstableWorkflowRunListingError)) throw cause;
				fallbackReason = cause.message;
				pageCount += cause.pages;
				expected = cause.sourceTotal;
				progressFloor = Math.max(progressFloor, cause.sourceTotal);
			}
		}
		throw new UnstableWorkflowRunListingError(fallbackReason ?? 'unstable-listing');
	} catch (cause) {
		if (isGitHubUnauthorizedError(cause)) throw cause;
		fallbackReason ??= cause instanceof Error ? cause.message : 'concurrent-import-failed';
		const fallback = await fetchWorkflowRunsSerially(
			octokit,
			owner,
			repo,
			created,
			state,
			onTiming,
			onProgress,
			progressFloor,
			pageCount
		);
		pageCount += fallback.pages;
		expected = fallback.sourceTotal;
		const runs = uniqueSortedRuns(fallback.runs);
		uniqueCount = runs.length;
		return runs;
	} finally {
		const durationMs = Date.now() - startedAt;
		onTiming?.('GitHub: fetchAllWorkflowRunsForRepo (total)', durationMs, {
			totalRuns: uniqueCount,
			pages: pageCount
		});
		console.info('[workflow-run-import]', {
			repository: `${owner}/${repo}`,
			lookback: created ?? 'all',
			expectedRuns: expected,
			uniqueRuns: uniqueCount,
			attempts,
			pages: pageCount,
			durationMs,
			retries: state.retries,
			finalConcurrency: state.serial ? 1 : WORKFLOW_RUN_CONCURRENCY,
			rateLimitRemaining: state.rateLimitRemaining,
			fallbackReason
		});
	}
}

function listingSignature(run: GitHubWorkflowRun): string {
	return [run.run_attempt ?? 1, run.status ?? '', run.conclusion ?? '', run.updated_at ?? ''].join(
		':'
	);
}

/** Fetch newest pages until GitHub returns one complete page unchanged from Redis. */
export async function fetchIncrementalWorkflowRunsForRepo(
	octokit: Octokit,
	owner: string,
	repo: string,
	cachedRuns: GitHubWorkflowRun[],
	created?: string,
	onProgress?: ProgressCallback
): Promise<GitHubWorkflowRun[]> {
	const cached = new Map(cachedRuns.map((run) => [run.id, run]));
	let page = 1;
	let fetched = 0;
	const cutoff = createdCutoff(created);
	while (true) {
		const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
			owner,
			repo,
			per_page: 100,
			page,
			exclude_pull_requests: true
		});
		const pageRuns = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
			normalizeWorkflowRun
		);
		fetched += pageRuns.length;
		onProgress?.(fetched, data.total_count ?? fetched, page);
		const relevantRuns = pageRuns.filter((run) => !isBeforeCutoff(run, cutoff));
		const unchanged =
			pageRuns.length === 100 &&
			relevantRuns.every((run) => {
				const previous = cached.get(run.id);
				return previous && listingSignature(previous) === listingSignature(run);
			});
		for (const run of relevantRuns) {
			const previous = cached.get(run.id);
			if (!previous || listingSignature(previous) !== listingSignature(run))
				cached.set(run.id, run);
		}
		if (pageRuns.length < 100 || pageRuns.some((run) => isBeforeCutoff(run, cutoff)) || unchanged)
			break;
		page++;
	}
	return [...cached.values()].sort(
		(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
	);
}

export async function fetchSingleWorkflowRuns(
	octokit: Octokit,
	owner: string,
	repo: string,
	workflowId: number,
	options: { per_page?: number; page?: number; created?: string } = {}
): Promise<GitHubWorkflowRun[]> {
	const { data } = await octokit.rest.actions.listWorkflowRuns({
		owner,
		repo,
		workflow_id: workflowId,
		per_page: options.per_page ?? 100,
		page: options.page ?? 1,
		...(options.created ? { created: options.created } : {})
	});
	return (data.workflow_runs as unknown as GitHubWorkflowRun[]).map(normalizeWorkflowRun);
}

/** Fetches all workflow runs for a single workflow in the given date range by paginating. */
export async function fetchAllSingleWorkflowRuns(
	octokit: Octokit,
	owner: string,
	repo: string,
	workflowId: number,
	created?: string
): Promise<GitHubWorkflowRun[]> {
	const allRuns: GitHubWorkflowRun[] = [];
	let page = 1;
	const cutoff = createdCutoff(created);
	while (true) {
		const { data } = await octokit.rest.actions.listWorkflowRuns({
			owner,
			repo,
			workflow_id: workflowId,
			per_page: 100,
			page
		});
		const runs = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
			normalizeWorkflowRun
		);
		allRuns.push(...runs.filter((run) => !isBeforeCutoff(run, cutoff)));
		if (runs.length < 100 || runs.some((run) => isBeforeCutoff(run, cutoff))) break;
		page++;
	}
	return allRuns;
}

/** Fetch newest workflow pages until one complete page is unchanged from Redis. */
export async function fetchIncrementalSingleWorkflowRuns(
	octokit: Octokit,
	owner: string,
	repo: string,
	workflowId: number,
	cachedRuns: GitHubWorkflowRun[],
	created?: string
): Promise<GitHubWorkflowRun[]> {
	const cached = new Map(cachedRuns.map((run) => [run.id, run]));
	const cutoff = createdCutoff(created);
	let page = 1;
	while (true) {
		const { data } = await octokit.rest.actions.listWorkflowRuns({
			owner,
			repo,
			workflow_id: workflowId,
			per_page: 100,
			page
		});
		const pageRuns = ((data.workflow_runs ?? []) as unknown as GitHubWorkflowRun[]).map(
			normalizeWorkflowRun
		);
		const relevantRuns = pageRuns.filter((run) => !isBeforeCutoff(run, cutoff));
		const unchanged =
			pageRuns.length === 100 &&
			relevantRuns.every((run) => {
				const previous = cached.get(run.id);
				return previous && listingSignature(previous) === listingSignature(run);
			});
		for (const run of relevantRuns) {
			const previous = cached.get(run.id);
			if (!previous || listingSignature(previous) !== listingSignature(run))
				cached.set(run.id, run);
		}
		if (pageRuns.length < 100 || pageRuns.some((run) => isBeforeCutoff(run, cutoff)) || unchanged)
			break;
		page++;
	}
	return [...cached.values()].sort(
		(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
	);
}

export async function fetchJobsForRun(
	octokit: Octokit,
	owner: string,
	repo: string,
	runId: number
): Promise<GitHubJob[]> {
	const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
		owner,
		repo,
		run_id: runId,
		per_page: 100
	});
	return data.jobs as unknown as GitHubJob[];
}

const trustedGitHubLogHosts = new Set([
	'pipelines.actions.githubusercontent.com',
	'results-receiver.actions.githubusercontent.com'
]);

export function isTrustedGitHubLogDownloadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			(trustedGitHubLogHosts.has(url.hostname) || url.hostname.endsWith('.blob.core.windows.net'))
		);
	} catch {
		return false;
	}
}

/** Returns the actionable tail of a GitHub Actions job log without exposing the full noisy log. */
export async function fetchJobLog(
	accessToken: string,
	owner: string,
	repo: string,
	jobId: number
): Promise<string | null> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
		{
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
			redirect: 'manual'
		}
	);
	const location = response.headers.get('location');
	if (location && !isTrustedGitHubLogDownloadUrl(location)) return null;
	const logResponse = location ? await fetch(location) : response;
	if (!logResponse.ok) return null;
	return (await logResponse.text()).slice(-1_000_000) || null;
}

/** Returns the actionable tail of a GitHub Actions job log without exposing the full noisy log. */
export async function fetchJobFailureExcerpt(
	accessToken: string,
	owner: string,
	repo: string,
	jobId: number
): Promise<string | null> {
	const log = await fetchJobLog(accessToken, owner, repo, jobId);
	if (!log) return null;
	const lines = log.slice(-250_000).split('\n');
	const errorLines = lines.filter((line) => /##\[error\]|\berror:|\bfailed\b/i.test(line));
	return (
		(errorLines.length > 0 ? errorLines.slice(-30) : lines.filter(Boolean).slice(-40))
			.join('\n')
			.trim() || null
	);
}

/** Commits that modified files under .github/workflows in the last N days (for chart markers). */
export async function fetchWorkflowFileCommits(
	octokit: Octokit,
	owner: string,
	repo: string,
	since: Date
): Promise<WorkflowFileCommit[]> {
	const sinceIso = since.toISOString();
	const { data } = await octokit.rest.repos.listCommits({
		owner,
		repo,
		path: '.github/workflows',
		since: sinceIso,
		per_page: 100
	});

	const out: WorkflowFileCommit[] = [];
	for (const c of data as Array<{
		sha: string;
		commit: { message: string; committer?: { date: string } };
	}>) {
		const committedAt = c.commit?.committer?.date ?? sinceIso;
		const dateKey = committedAt.slice(0, 10);
		out.push({
			date: dateKey,
			committedAt,
			sha: c.sha.slice(0, 7),
			message: (c.commit?.message ?? '').split('\n')[0].slice(0, 80),
			paths: []
		});
	}
	return out;
}

const AVERAGE_DURATION_RUN_LIMIT = 150;
const AVERAGE_DURATION_DAYS = 14;

function runsForAverage(
	runs: GitHubWorkflowRun[],
	window: AverageDurationWindow
): GitHubWorkflowRun[] {
	const completed = runs.filter((run) => run.status === 'completed');
	if (window === 'recent_14_days') {
		const cutoff = Date.now() - AVERAGE_DURATION_DAYS * 86_400_000;
		return completed.filter((run) => {
			const startedAt = getRunTiming(run).startedAt ?? run.created_at;
			return Date.parse(startedAt) >= cutoff;
		});
	}

	return [...completed]
		.sort((a, b) => {
			const aStartedAt = getRunTiming(a).startedAt ?? a.created_at;
			const bStartedAt = getRunTiming(b).startedAt ?? b.created_at;
			return Date.parse(bStartedAt) - Date.parse(aStartedAt);
		})
		.slice(0, AVERAGE_DURATION_RUN_LIMIT);
}

function computeWorkflowMetrics(
	workflow: GitHubWorkflow,
	runs: GitHubWorkflowRun[],
	averageDurationWindow: AverageDurationWindow
): WorkflowMetrics {
	const workflowRuns = runs.filter((r) => r.workflow_id === workflow.id);
	const completed = workflowRuns.filter((r) => r.status === 'completed');
	const successCount = completed.filter((r) => r.conclusion === 'success').length;
	const failureCount = completed.filter((r) => r.conclusion === 'failure').length;
	const cancelledCount = completed.filter((r) => r.conclusion === 'cancelled').length;
	const skippedCount = completed.filter((r) => r.conclusion === 'skipped').length;

	// Success/failure rates only among runs that actually executed (exclude skipped/cancelled)
	const executedCount = successCount + failureCount;
	const successRate =
		executedCount > 0 ? Math.round((successCount / executedCount) * 1000) / 10 : 0;
	const failureRate =
		executedCount > 0 ? Math.round((failureCount / executedCount) * 1000) / 10 : 0;
	const skipRate =
		workflowRuns.length > 0 ? Math.round((skippedCount / workflowRuns.length) * 1000) / 10 : 0;

	const durations = runsForAverage(workflowRuns, averageDurationWindow)
		.map((r) => getRunTiming(r).durationMs)
		.filter((d): d is number => d !== null);
	const allDurations = completed
		.map((r) => getRunTiming(r).durationMs)
		.filter((d): d is number => d !== null)
		.sort((a, b) => a - b);

	const avgDurationMs =
		durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

	const lastRun = workflowRuns[0];

	return {
		workflowId: workflow.id,
		workflowName: workflow.name,
		workflowPath: workflow.path,
		totalRuns: workflowRuns.length,
		successCount,
		failureCount,
		cancelledCount,
		skippedCount,
		successRate,
		failureRate,
		skipRate,
		avgDurationMs: Math.round(avgDurationMs),
		p50DurationMs: Math.round(percentile(allDurations, 50)),
		p95DurationMs: Math.round(percentile(allDurations, 95)),
		lastRunAt: lastRun
			? (getRunTiming(lastRun).completedAt ?? getRunTiming(lastRun).startedAt)
			: null,
		lastConclusion: lastRun?.conclusion ?? null
	};
}

function buildRunTrend(runs: GitHubWorkflowRun[], days = 30): RunDataPoint[] {
	const map = new Map<string, RunDataPoint>();

	for (let i = days - 1; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const key = d.toISOString().slice(0, 10);
		map.set(key, { date: key, success: 0, failure: 0, cancelled: 0, skipped: 0, total: 0 });
	}

	for (const run of runs) {
		const key = (getRunTiming(run).startedAt ?? run.created_at).slice(0, 10);
		if (!map.has(key)) continue;
		const point = map.get(key)!;
		point.total++;
		if (run.conclusion === 'success') point.success++;
		else if (run.conclusion === 'failure') point.failure++;
		else if (run.conclusion === 'cancelled') point.cancelled++;
		else if (run.conclusion === 'skipped') point.skipped++;
	}

	return Array.from(map.values());
}

const DAYS_WINDOW = 30;

function computeDoraMetrics(runs: GitHubWorkflowRun[], doraWorkflowIds?: number[]): DoraMetrics {
	// Filter runs to only DORA workflows if specified
	const filteredRuns =
		doraWorkflowIds && doraWorkflowIds.length > 0
			? runs.filter((r) => doraWorkflowIds.includes(r.workflow_id))
			: runs;

	const completed = filteredRuns.filter((r) => r.status === 'completed');
	const successCount = completed.filter((r) => r.conclusion === 'success').length;
	const failureCount = completed.filter((r) => r.conclusion === 'failure').length;
	const successOrFailure = completed.filter(
		(r) => r.conclusion === 'success' || r.conclusion === 'failure'
	);

	// Deployment frequency: successful runs per week and per day
	const perWeek = DAYS_WINDOW > 0 ? successCount / (DAYS_WINDOW / 7) : 0;
	const perDay = DAYS_WINDOW > 0 ? successCount / DAYS_WINDOW : 0;

	// Change failure rate: failures / (successes + failures) * 100
	const deployCount = successCount + failureCount;
	const changeFailureRate =
		deployCount > 0 ? Math.round((failureCount / deployCount) * 1000) / 10 : 0;

	// Lead time: commit → stable run end, or created_at → stable run end as proxy.
	const leadTimesMs: number[] = [];
	let usedCommitTimestamp = false;
	for (const r of successOrFailure) {
		const completedAt = getRunTiming(r).completedAt;
		if (!completedAt) continue;
		const endMs = new Date(completedAt).getTime();
		const startMs = r.head_commit?.timestamp
			? new Date(r.head_commit.timestamp).getTime()
			: new Date(r.created_at).getTime();
		if (r.head_commit?.timestamp) usedCommitTimestamp = true;
		if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
			leadTimesMs.push(endMs - startMs);
		}
	}
	const leadTimeForChangesMs =
		leadTimesMs.length > 0
			? Math.round(
					percentile(
						[...leadTimesMs].sort((a, b) => a - b),
						50
					)
				)
			: null;

	// MTTR: for each timed failure, time until the next timed success.
	const byCompletedAt = completed
		.filter((run) => getRunTiming(run).completedAt !== null)
		.sort(
			(a, b) =>
				new Date(getRunTiming(a).completedAt!).getTime() -
				new Date(getRunTiming(b).completedAt!).getTime()
		);
	const recoveryTimesMs: number[] = [];
	for (let i = 0; i < byCompletedAt.length; i++) {
		if (byCompletedAt[i].conclusion !== 'failure') continue;
		const failureEnd = new Date(getRunTiming(byCompletedAt[i]).completedAt!).getTime();
		for (let j = i + 1; j < byCompletedAt.length; j++) {
			if (byCompletedAt[j].conclusion === 'success') {
				recoveryTimesMs.push(
					new Date(getRunTiming(byCompletedAt[j]).completedAt!).getTime() - failureEnd
				);
				break;
			}
		}
	}
	const meanTimeToRecoveryMs =
		recoveryTimesMs.length > 0
			? Math.round(recoveryTimesMs.reduce((a, b) => a + b, 0) / recoveryTimesMs.length)
			: null;

	return {
		deploymentFrequency: { perWeek, perDay },
		leadTimeForChangesMs,
		leadTimeFromCommit: usedCommitTimestamp,
		changeFailureRate,
		meanTimeToRecoveryMs
	};
}

function runsToRecentRuns(runs: GitHubWorkflowRun[], workflows: GitHubWorkflow[]): RecentRun[] {
	const workflowMap = new Map(workflows.map((w) => [w.id, w.name]));
	return runs.map((r) => ({
		id: r.id,
		workflowName: r.name ?? workflowMap.get(r.workflow_id) ?? 'Unknown',
		workflowId: r.workflow_id,
		status: r.status,
		conclusion: r.conclusion,
		branch: r.head_branch,
		durationMs: getRunTiming(r).durationMs,
		startedAt: getRunTiming(r).startedAt,
		htmlUrl: r.html_url,
		actor: r.actor?.login ?? null,
		actorAvatar: r.actor?.avatar_url ?? null,
		runNumber: r.run_number
	}));
}

/**
 * GitHub Actions billing multiplier by runner OS.
 * Linux (ubuntu-*): ×1 · Windows (windows-*): ×2 · macOS (macos-*): ×10
 */
function getRunnerMultiplier(labels: string[]): number {
	const runnerType = getRunnerType(labels);
	if (runnerType === 'macos' || runnerType === 'macos-large' || runnerType === 'macos-xlarge')
		return 10;
	if (runnerType === 'windows' || runnerType === 'windows-arm') return 2;
	return 1;
}

function getRunnerType(labels: string[]): RunnerType {
	const value = labels.join(' ').toLowerCase();
	if (value.includes('self-hosted')) return 'self-hosted';
	if (/macos-(latest|\d+)-xlarge/.test(value)) return 'macos-xlarge';
	if (/macos-(latest|\d+)-large/.test(value)) return 'macos-large';
	if (value.includes('ubuntu-slim')) return 'ubuntu-slim';
	if (value.includes('core') || value.includes('gpu')) return 'unknown';
	if (value.includes('ubuntu') && value.includes('arm')) return 'ubuntu-arm';
	if (value.includes('windows') && value.includes('arm')) return 'windows-arm';
	if (value.includes('ubuntu')) return 'ubuntu';
	if (value.includes('windows')) return 'windows';
	if (value.includes('macos') || value.includes('mac-') || value.includes('osx')) return 'macos';
	return 'unknown';
}

function getRunnerDisplayLabel(job: GitHubJob): string | undefined {
	const generic = new Set(['self-hosted', 'linux', 'windows', 'macos', 'x64', 'arm64', 'arm']);
	return (
		job.labels.find((label) => !generic.has(label.toLowerCase())) ??
		job.runner_name ??
		job.labels[0]
	);
}

/** Fetches a workflow YAML file from the repo and returns its raw string content. */
async function fetchWorkflowContent(
	octokit: Octokit,
	owner: string,
	repo: string,
	path: string,
	cacheUserId?: string
): Promise<string | null> {
	// GitHub exposes generated workflows (for example Copilot code review) under
	// dynamic/* paths. They are runnable but are not files in the repository.
	if (!path.startsWith('.github/workflows/')) return null;
	if (cacheUserId) {
		const cached = await getCachedWorkflowFile(cacheUserId, owner, repo, path);
		if (cached.hit) return cached.content;
	}

	try {
		const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
		if (!('content' in data) || data.type !== 'file') return null;
		// GitHub returns base64 with embedded newlines — strip them before decoding
		const b64 = (data.content as string).replace(/\n/g, '');
		const content = atob(b64);
		if (cacheUserId) await setCachedWorkflowFile(cacheUserId, owner, repo, path, content);
		return content;
	} catch {
		if (cacheUserId) await setCachedWorkflowFile(cacheUserId, owner, repo, path, null);
		return null;
	}
}

interface WorkflowRunnerInfo {
	multiplier: number;
	runnerType: RunnerType;
	detected: boolean;
	runnerLabel?: string;
}

/**
 * Parses a GitHub Actions workflow YAML string and returns the runner info.
 * Handles: plain strings, label arrays, and gracefully skips template expressions (${{ }}).
 * Mixed runner types (e.g., ubuntu + macos) are averaged and labelled "mixed".
 */
function parseWorkflowRunners(content: string): WorkflowRunnerInfo {
	try {
		const doc = parseYaml(content) as Record<string, unknown> | null;
		if (!doc || typeof doc !== 'object')
			return { multiplier: 1, runnerType: 'unknown', detected: false };

		const jobs = doc.jobs as Record<string, unknown> | undefined;
		if (!jobs || typeof jobs !== 'object')
			return { multiplier: 1, runnerType: 'unknown', detected: false };

		const runnerTypes: RunnerType[] = [];
		const runnerLabels: string[] = [];

		for (const job of Object.values(jobs)) {
			if (!job || typeof job !== 'object') continue;
			const jobObj = job as Record<string, unknown>;

			// Reusable workflow calls (`uses:`) have no runner — skip them
			if ('uses' in jobObj) continue;

			const runsOn = jobObj['runs-on'];

			let labels: string[] = [];

			if (runsOn === undefined || runsOn === null) {
				continue;
			} else if (typeof runsOn === 'string') {
				// Skip template expressions — we can't resolve them statically
				if (runsOn.includes('${{')) continue;
				labels = [runsOn];
			} else if (Array.isArray(runsOn)) {
				// Filter out template expressions within arrays
				labels = runsOn.filter((l): l is string => typeof l === 'string' && !l.includes('${{'));
				if (labels.length === 0) continue;
			} else {
				continue;
			}

			runnerTypes.push(getRunnerType(labels));
			runnerLabels.push(labels.join(', '));
		}

		if (runnerTypes.length === 0) return { multiplier: 1, runnerType: 'unknown', detected: false };

		const unique = [...new Set(runnerTypes)];
		const runnerType: RunnerType = unique.length > 1 ? 'mixed' : unique[0];
		const avg =
			runnerTypes.reduce((sum, type) => sum + getRunnerMultiplier([type]), 0) / runnerTypes.length;

		return {
			multiplier: avg,
			runnerType,
			detected: runnerType !== 'unknown',
			runnerLabel: [...new Set(runnerLabels)].join(' / ')
		};
	} catch {
		return { multiplier: 1, runnerType: 'unknown', detected: false };
	}
}

/**
 * Fetches and parses the runner info for every workflow in the list in parallel.
 * Returns a Map keyed by workflow id.
 */
async function fetchWorkflowRunnerInfo(
	octokit: Octokit,
	owner: string,
	repo: string,
	workflows: GitHubWorkflow[],
	cacheUserId?: string
): Promise<Map<number, WorkflowRunnerInfo>> {
	const results: Array<readonly [number, WorkflowRunnerInfo]> = [];
	let nextIndex = 0;
	const workerCount = Math.min(8, workflows.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < workflows.length) {
				const workflow = workflows[nextIndex++];
				const content = await fetchWorkflowContent(
					octokit,
					owner,
					repo,
					workflow.path,
					cacheUserId
				);
				const info = content
					? parseWorkflowRunners(content)
					: { multiplier: 1, runnerType: 'unknown' as RunnerType, detected: false };
				results.push([workflow.id, info]);
			}
		})
	);
	return new Map(results);
}

/** Returns the raw duration of a run in whole minutes (ceiling), minimum 0. */
function runDurationMinutes(run: GitHubWorkflowRun): number | null {
	const durationMs = getRunTiming(run).durationMs;
	return durationMs === null ? null : Math.max(0, Math.ceil(durationMs / 60_000));
}

interface MinutesOverviewMetrics {
	totalMinutes30d: number;
	billableMinutes30d: number;
	billableIsEstimate: boolean;
	minutesByWorkflow: WorkflowMinutesShare[];
	minutesTrend: MinutesDataPoint[];
	wastedMinutes: number;
	topBranchByMinutes: { branch: string; minutes: number } | null;
}

function computeMinutesOverview(
	runs: GitHubWorkflowRun[],
	workflows: GitHubWorkflow[],
	days: number,
	runnerInfoMap: Map<number, WorkflowRunnerInfo> = new Map()
): MinutesOverviewMetrics {
	const completedRuns = runs.filter((r) => r.status === 'completed');

	// Per-workflow minutes
	const workflowMinutesMap = new Map<number, number>();
	const workflowNameMap = new Map<number, string>(workflows.map((w) => [w.id, w.name]));
	let totalMinutes30d = 0;
	let wastedMinutes = 0;

	// Daily trend map (pre-fill all days in the window)
	const trendMap = new Map<string, number>();
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		trendMap.set(d.toISOString().slice(0, 10), 0);
	}

	// Branch minutes map
	const branchMinutesMap = new Map<string, number>();

	for (const run of completedRuns) {
		const minutes = runDurationMinutes(run);
		if (minutes === null) continue;
		totalMinutes30d += minutes;

		// Per-workflow
		const prev = workflowMinutesMap.get(run.workflow_id) ?? 0;
		workflowMinutesMap.set(run.workflow_id, prev + minutes);

		// Wasted minutes (failures + cancelled)
		if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
			wastedMinutes += minutes;
		}

		// Daily trend (keyed by run start date)
		const dateKey = (getRunTiming(run).startedAt ?? run.created_at).slice(0, 10);
		if (trendMap.has(dateKey)) {
			trendMap.set(dateKey, (trendMap.get(dateKey) ?? 0) + minutes);
		}

		// Branch
		const branch = run.head_branch;
		if (branch) {
			branchMinutesMap.set(branch, (branchMinutesMap.get(branch) ?? 0) + minutes);
		}
	}

	// Build minutesByWorkflow (sorted descending by minutes)
	// Use runner info parsed from workflow YAML files when available
	const minutesByWorkflow: WorkflowMinutesShare[] = Array.from(workflowMinutesMap.entries())
		.map(([workflowId, minutes]) => {
			const runnerInfo = runnerInfoMap.get(workflowId);
			const multiplier = runnerInfo?.multiplier ?? 1;
			const runnerDetected = runnerInfo?.detected ?? false;
			return {
				workflowName: workflowNameMap.get(workflowId) ?? `Workflow ${workflowId}`,
				minutes,
				billableMinutes: Math.ceil(minutes * multiplier),
				percentage: totalMinutes30d > 0 ? Math.round((minutes / totalMinutes30d) * 100) : 0,
				runnerType: (runnerInfo?.runnerType ?? 'unknown') as RunnerType,
				runnerDetected,
				runnerLabel: runnerInfo?.runnerLabel
			};
		})
		.filter((w) => w.minutes > 0)
		.sort((a, b) => b.minutes - a.minutes);

	// Build minutesTrend
	const minutesTrend: MinutesDataPoint[] = Array.from(trendMap.entries()).map(
		([date, minutes]) => ({ date, minutes })
	);

	// Top branch
	let topBranchByMinutes: { branch: string; minutes: number } | null = null;
	if (branchMinutesMap.size > 0) {
		const [branch, minutes] = [...branchMinutesMap.entries()].sort((a, b) => b[1] - a[1])[0];
		topBranchByMinutes = { branch, minutes };
	}

	const billableMinutes30d = minutesByWorkflow.reduce((sum, w) => sum + w.billableMinutes, 0);
	const billableIsEstimate = minutesByWorkflow.some((w) => !w.runnerDetected);

	return {
		totalMinutes30d,
		billableMinutes30d,
		billableIsEstimate,
		minutesByWorkflow,
		minutesTrend,
		wastedMinutes,
		topBranchByMinutes
	};
}

interface MinutesDetailMetrics {
	totalMinutes30d: number;
	billableMinutes30d: number;
	minutesByJob: JobMinutesShare[];
	completedRunCount: number;
	jobMinutesSampleRunCount: number;
	minutesTrend: MinutesDataPoint[];
	wastedMinutes: number;
	stepBreakdown: StepBreakdown[];
	slowestJobName: string | null;
}

function computeMinutesDetail(
	runs: GitHubWorkflowRun[],
	jobsPerRun: GitHubJob[][],
	jobBreakdown: JobBreakdown[]
): MinutesDetailMetrics {
	const completedRuns = runs.filter((r) => r.status === 'completed');

	// Total minutes and waste from all runs in window (run-level)
	let totalMinutes30d = 0;
	let wastedMinutes = 0;
	const trendMap = new Map<string, number>();
	for (let i = 29; i >= 0; i--) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		trendMap.set(d.toISOString().slice(0, 10), 0);
	}

	for (const run of completedRuns) {
		const minutes = runDurationMinutes(run);
		if (minutes === null) continue;
		totalMinutes30d += minutes;
		if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
			wastedMinutes += minutes;
		}
		const dateKey = (getRunTiming(run).startedAt ?? run.created_at).slice(0, 10);
		if (trendMap.has(dateKey)) {
			trendMap.set(dateKey, (trendMap.get(dateKey) ?? 0) + minutes);
		}
	}

	const minutesTrend: MinutesDataPoint[] = Array.from(trendMap.entries()).map(
		([date, minutes]) => ({ date, minutes })
	);

	// Per-job minutes from sampled runs — track raw and billable separately
	const jobMinutesMap = new Map<string, number>();
	const jobBillableMap = new Map<string, number>();
	const jobRunnerTypes = new Map<string, Set<RunnerType>>();
	const jobRunnerLabels = new Map<string, Set<string>>();
	let totalRawFromJobs = 0;
	let totalBillableFromJobs = 0;

	for (const jobs of jobsPerRun) {
		for (const job of jobs) {
			const dur = computeDurationMs(job.started_at, job.completed_at);
			if (dur !== null) {
				const rawMins = Math.max(0, Math.ceil(dur / 60_000));
				const billableMins = rawMins * getRunnerMultiplier(job.labels);
				jobMinutesMap.set(job.name, (jobMinutesMap.get(job.name) ?? 0) + rawMins);
				jobBillableMap.set(job.name, (jobBillableMap.get(job.name) ?? 0) + billableMins);
				const runnerTypes = jobRunnerTypes.get(job.name) ?? new Set<RunnerType>();
				runnerTypes.add(getRunnerType(job.labels));
				jobRunnerTypes.set(job.name, runnerTypes);
				const runnerLabels = jobRunnerLabels.get(job.name) ?? new Set<string>();
				const runnerLabel = getRunnerDisplayLabel(job);
				if (runnerLabel) runnerLabels.add(runnerLabel);
				jobRunnerLabels.set(job.name, runnerLabels);
				totalRawFromJobs += rawMins;
				totalBillableFromJobs += billableMins;
			}
		}
	}
	const totalJobMinutes = Array.from(jobMinutesMap.values()).reduce((a, b) => a + b, 0);
	const minutesByJob: JobMinutesShare[] = Array.from(jobMinutesMap.entries())
		.map(([jobName, minutes]) => {
			const types = [...(jobRunnerTypes.get(jobName) ?? new Set<RunnerType>(['unknown']))];
			const runnerType: RunnerType = types.length === 1 ? types[0] : 'mixed';
			const runnerLabel = [...(jobRunnerLabels.get(jobName) ?? [])].join(' / ');
			return {
				jobName,
				minutes,
				billableMinutes: jobBillableMap.get(jobName) ?? minutes,
				percentage: totalJobMinutes > 0 ? Math.round((minutes / totalJobMinutes) * 100) : 0,
				runnerType,
				runnerDetected: runnerType !== 'unknown' && runnerType !== 'mixed',
				runnerLabel: runnerLabel || undefined
			};
		})
		.filter((j) => j.minutes > 0)
		.sort((a, b) => b.minutes - a.minutes);

	// Estimate billable for all 30 days using the avg multiplier from sampled jobs
	const avgMultiplier = totalRawFromJobs > 0 ? totalBillableFromJobs / totalRawFromJobs : 1;
	const billableMinutes30d = Math.round(totalMinutes30d * avgMultiplier);

	// Step breakdown for the slowest job
	const slowestJob = [...jobBreakdown].sort((a, b) => b.avgDurationMs - a.avgDurationMs)[0];
	const slowestJobName = slowestJob?.jobName ?? null;
	const stepDurations = new Map<string, number[]>();
	if (slowestJob) {
		for (const jobs of jobsPerRun) {
			const match = jobs.find((j) => j.name === slowestJob.jobName);
			if (match) {
				for (const step of match.steps) {
					const dur = computeDurationMs(step.started_at, step.completed_at);
					if (dur !== null && dur > 0) {
						if (!stepDurations.has(step.name)) stepDurations.set(step.name, []);
						stepDurations.get(step.name)!.push(dur);
					}
				}
			}
		}
	}
	const stepBreakdown: StepBreakdown[] = Array.from(stepDurations.entries())
		.map(([stepName, durs]) => ({
			stepName,
			avgDurationMs: Math.round(durs.reduce((a, b) => a + b, 0) / durs.length),
			samples: durs.length
		}))
		.sort((a, b) => b.avgDurationMs - a.avgDurationMs);

	return {
		totalMinutes30d,
		billableMinutes30d,
		minutesByJob,
		completedRunCount: completedRuns.length,
		jobMinutesSampleRunCount: jobsPerRun.length,
		minutesTrend,
		wastedMinutes,
		stepBreakdown,
		slowestJobName
	};
}

export interface BuildDashboardDataOptions {
	onTiming?: TimingCollector;
	/** When set, skip fetching runs from GitHub and use this array instead (e.g. from cache). */
	cachedRuns?: GitHubWorkflowRun[];
	/** Called with the fetched runs when we hit GitHub (so the caller can cache them). */
	onRunsFetched?: (runs: GitHubWorkflowRun[]) => void;
	/** Number of days to look back. Defaults to 30. Null imports all available history. */
	days?: number | null;
	/** Called after each paginated page when fetching from GitHub. Useful for streaming progress. */
	onProgress?: ProgressCallback;
	/** Called as corrupted listing timestamps are repaired from workflow attempts. */
	onRepairProgress?: (completed: number, total: number) => void;
	/** Called immediately before derived dashboard metrics are computed. */
	onComputeStart?: () => void;
	/** Workflow IDs to include in DORA metrics calculation. When provided, only these workflows are used. */
	doraWorkflowIds?: number[];
	/** Authenticated cache namespace for workflow-file contents. */
	cacheUserId?: string;
	/** Bounded run window used only for average-duration metrics. */
	averageDurationWindow?: AverageDurationWindow;
}

export async function buildDashboardData(
	octokit: Octokit,
	owner: string,
	repo: string,
	options?: BuildDashboardDataOptions
): Promise<DashboardData> {
	const {
		onTiming,
		cachedRuns,
		onRunsFetched,
		onProgress,
		onRepairProgress,
		onComputeStart,
		doraWorkflowIds,
		cacheUserId,
		averageDurationWindow = 'recent_150'
	} = options ?? {};
	const days = options?.days === undefined ? 30 : options.days;
	const isAllTime = days === null;
	const now = typeof performance !== 'undefined' ? () => performance.now() : () => 0;
	const timing = (label: string, ms: number, meta?: Record<string, number>) => {
		onTiming?.(label, ms, meta);
	};

	const windowStart = isAllTime ? new Date(0) : new Date();
	if (days !== null) windowStart.setDate(windowStart.getDate() - days);
	const created = isAllTime ? undefined : `>=${windowStart.toISOString().slice(0, 10)}`;

	let runs: GitHubWorkflowRun[];
	let workflows: GitHubWorkflow[];
	let workflowFileCommits: WorkflowFileCommit[];

	if (cachedRuns != null) {
		timing('cache: use cached runs', 0, { runs: cachedRuns.length });
		runs = cachedRuns;
		const start = now();
		[workflows, workflowFileCommits] = await Promise.all([
			fetchWorkflows(octokit, owner, repo),
			fetchWorkflowFileCommits(octokit, owner, repo, windowStart).catch(
				() => [] as WorkflowFileCommit[]
			)
		]);
		timing('GitHub: fetchWorkflows + fetchWorkflowFileCommits (cache hit)', now() - start, {
			workflows: workflows.length,
			commits: workflowFileCommits.length
		});
	} else {
		const parallelStart = now();
		[workflows, runs, workflowFileCommits] = await Promise.all([
			(async () => {
				const start = now();
				const w = await fetchWorkflows(octokit, owner, repo);
				timing('GitHub: fetchWorkflows', now() - start, { count: w.length });
				return w;
			})(),
			fetchAllWorkflowRunsForRepo(octokit, owner, repo, created, onTiming, onProgress),
			(async () => {
				const start = now();
				const c = await fetchWorkflowFileCommits(octokit, owner, repo, windowStart).catch(
					() => [] as WorkflowFileCommit[]
				);
				timing('GitHub: fetchWorkflowFileCommits', now() - start, { count: c.length });
				return c;
			})()
		]);
		timing('GitHub: Promise.all(workflows, runs, commits)', now() - parallelStart);
	}

	await repairWorkflowRunTimings(octokit, owner, repo, runs, onRepairProgress);
	if (cachedRuns == null) await onRunsFetched?.(runs);

	const knownWorkflowIds = new Set(workflows.map((workflow) => workflow.id));
	for (const run of runs) {
		if (knownWorkflowIds.has(run.workflow_id)) continue;
		workflows.push({
			id: run.workflow_id,
			name: run.name ?? `Workflow ${run.workflow_id}`,
			path: `historical/${run.workflow_id}`,
			state: 'historical',
			html_url: run.html_url,
			badge_url: '',
			created_at: run.created_at,
			updated_at: run.updated_at
		});
		knownWorkflowIds.add(run.workflow_id);
	}

	const effectiveDays = isAllTime
		? Math.max(
				1,
				Math.ceil(
					(Date.now() -
						Math.min(...runs.map((run) => new Date(run.created_at).getTime()), Date.now())) /
						86_400_000
				)
			)
		: days;

	onComputeStart?.();
	const computeStart = now();
	const workflowMetrics = workflows.map((w) =>
		computeWorkflowMetrics(w, runs, averageDurationWindow)
	);
	timing('compute: workflowMetrics', now() - computeStart, { workflows: workflows.length });

	const trendStart = now();
	const runTrend = buildRunTrend(runs, effectiveDays);
	timing('compute: buildRunTrend', now() - trendStart, { runs: runs.length });

	const doraStart = now();
	const dora = computeDoraMetrics(runs, doraWorkflowIds);
	timing('compute: computeDoraMetrics', now() - doraStart, { runs: runs.length });

	const runnerInfoStart = now();
	const runnerInfoMap = await fetchWorkflowRunnerInfo(octokit, owner, repo, workflows, cacheUserId);
	timing('GitHub: fetchWorkflowRunnerInfo', now() - runnerInfoStart, {
		workflows: runnerInfoMap.size
	});

	const minutesStart = now();
	const minutesMetrics = computeMinutesOverview(runs, workflows, effectiveDays, runnerInfoMap);
	timing('compute: computeMinutesOverview', now() - minutesStart, { runs: runs.length });

	const completedRuns = runs.filter((r) => r.status === 'completed');
	const successRuns = completedRuns.filter((r) => r.conclusion === 'success');
	const failureRuns = completedRuns.filter((r) => r.conclusion === 'failure');
	const skippedRuns = completedRuns.filter((r) => r.conclusion === 'skipped');
	const executedRuns = successRuns.length + failureRuns.length;
	const successRate =
		executedRuns > 0 ? Math.round((successRuns.length / executedRuns) * 1000) / 10 : 0;
	const totalSkipped = skippedRuns.length;
	const skipRate =
		completedRuns.length > 0 ? Math.round((totalSkipped / completedRuns.length) * 1000) / 10 : 0;

	const durations = runsForAverage(runs, averageDurationWindow)
		.map((r) => getRunTiming(r).durationMs)
		.filter((d): d is number => d !== null);
	const avgDurationMs =
		durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

	return {
		owner,
		repo,
		totalRuns: runs.length,
		// We paginate until GitHub returns a short page, so this is the actual imported count.
		totalRunsIsCapped: false,
		successRate,
		totalSkipped,
		skipRate,
		avgDurationMs: Math.round(avgDurationMs),
		averageDurationWindow,
		activeWorkflows: workflows.filter((w) => w.state === 'active').length,
		runTrend,
		workflowMetrics,
		timingDataQuality: summarizeTimingQuality(runs),
		workflowFileCommits,
		dora,
		timeWindowDays: effectiveDays,
		isAllTime,
		doraWorkflowIds: doraWorkflowIds ?? [],
		hasDoraWorkflowsSelected: doraWorkflowIds != null && doraWorkflowIds.length > 0,
		...minutesMetrics
	};
}

export interface BuildWorkflowDetailDataOptions {
	/** Number of days to fetch. Omit for all available history. */
	days?: number;
	/** When set, skip fetching runs from GitHub and use this array instead (e.g. from cache). */
	cachedRuns?: GitHubWorkflowRun[];
	/** Called with the fetched runs when we hit GitHub (so the caller can cache them). */
	onRunsFetched?: (runs: GitHubWorkflowRun[]) => void | Promise<void>;
	/** Called as corrupted listing timestamps are repaired from workflow attempts. */
	onRepairProgress?: (completed: number, total: number) => void;
	/** Authenticated cache namespace for workflow-file contents. */
	cacheUserId?: string;
	/** Bounded run window used only for the workflow's average duration. */
	averageDurationWindow?: AverageDurationWindow;
}

export async function buildWorkflowDetailData(
	octokit: Octokit,
	owner: string,
	repo: string,
	workflowId: number,
	options?: BuildWorkflowDetailDataOptions
): Promise<WorkflowDetailData> {
	const {
		cachedRuns,
		onRunsFetched,
		onRepairProgress,
		cacheUserId,
		days,
		averageDurationWindow = 'recent_150'
	} = options ?? {};
	const created = days
		? `>=${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`
		: undefined;
	let runs: GitHubWorkflowRun[];
	let workflows: GitHubWorkflow[];

	if (cachedRuns != null) {
		runs = cachedRuns;
		workflows = await fetchWorkflows(octokit, owner, repo);
	} else {
		[workflows, runs] = await Promise.all([
			fetchWorkflows(octokit, owner, repo),
			fetchAllSingleWorkflowRuns(octokit, owner, repo, workflowId, created)
		]);
	}

	await repairWorkflowRunTimings(octokit, owner, repo, runs, onRepairProgress);
	if (cachedRuns == null) await onRunsFetched?.(runs);

	const historicalRun = runs.find((run) => run.workflow_id === workflowId);
	const workflow =
		workflows.find((item) => item.id === workflowId) ??
		(historicalRun
			? {
					id: workflowId,
					name: historicalRun.name ?? `Workflow ${workflowId}`,
					path: `historical/${workflowId}`,
					state: 'historical',
					html_url: historicalRun.html_url,
					badge_url: '',
					created_at: historicalRun.created_at,
					updated_at: historicalRun.updated_at
				}
			: undefined);
	if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

	// Same "all available history" case buildDashboardData handles: without this, buildRunTrend's
	// hardcoded 30-day default window silently drops every run older than 30 days from today.
	const effectiveDays = days
		? days
		: Math.max(
				1,
				Math.ceil(
					(Date.now() -
						Math.min(...runs.map((run) => new Date(run.created_at).getTime()), Date.now())) /
						86_400_000
				)
			);

	const completedRuns = runs.filter((r) => r.status === 'completed');

	const durationTrend: DurationDataPoint[] = completedRuns
		.flatMap((r) => {
			const timing = getRunTiming(r);
			return timing.startedAt && timing.durationMs !== null
				? [
						{
							runId: r.id,
							runNumber: r.run_number,
							startedAt: timing.startedAt,
							durationMs: timing.durationMs,
							conclusion: r.conclusion,
							branch: r.head_branch
						}
					]
				: [];
		})
		.reverse();

	// Fetch jobs for the last 5 runs to get job breakdown
	const recentCompleted = completedRuns.slice(0, 5);
	const jobsPerRun = await Promise.all(
		recentCompleted.map((r) => fetchJobsForRun(octokit, owner, repo, r.id))
	);

	const jobDurations = new Map<string, number[]>();
	for (const jobs of jobsPerRun) {
		for (const job of jobs) {
			const dur = computeDurationMs(job.started_at, job.completed_at);
			if (dur !== null) {
				if (!jobDurations.has(job.name)) jobDurations.set(job.name, []);
				jobDurations.get(job.name)!.push(dur);
			}
		}
	}

	const jobBreakdown: JobBreakdown[] = Array.from(jobDurations.entries()).map(
		([jobName, durs]) => ({
			jobName,
			avgDurationMs: Math.round(durs.reduce((a, b) => a + b, 0) / durs.length),
			maxDurationMs: Math.max(...durs),
			minDurationMs: Math.min(...durs),
			samples: durs.length
		})
	);

	const metrics = computeWorkflowMetrics(workflow, runs, averageDurationWindow);

	const minutesMetrics = computeMinutesDetail(runs, jobsPerRun, jobBreakdown);

	let jobGraphNodes: WorkflowJobNode[] = [];
	let jobGraphEdges: WorkflowJobEdge[] = [];

	const workflowContent = await fetchWorkflowContent(
		octokit,
		owner,
		repo,
		workflow.path,
		cacheUserId
	);
	// Only the most recent completed run counts as "latest failed" — completedRuns is newest-first,
	// so this must NOT be a .find() scan (that would surface an older failure even after a later success).
	const latestFailedRun = completedRuns[0]?.conclusion === 'failure' ? completedRuns[0] : null;
	const latestFailedRunIndex = latestFailedRun
		? recentCompleted.findIndex((run) => run.id === latestFailedRun.id)
		: -1;
	const failedJobs = latestFailedRunIndex >= 0 ? (jobsPerRun[latestFailedRunIndex] ?? []) : [];
	const failedJob = failedJobs.find((job) => job.conclusion === 'failure') ?? null;
	const failedStep = failedJob?.steps.find((step) => step.conclusion === 'failure') ?? null;
	const durationByJob = new Map<string, JobBreakdown>();
	for (const jb of jobBreakdown) {
		durationByJob.set(jb.jobName, jb);
	}

	const minutesByJobMap = new Map<string, JobMinutesShare>();
	for (const m of minutesMetrics.minutesByJob) {
		minutesByJobMap.set(m.jobName, m);
	}

	const successStats = new Map<
		string,
		{
			success: number;
			total: number;
		}
	>();

	for (const jobs of jobsPerRun) {
		for (const job of jobs) {
			if (job.conclusion === null) continue;
			const name = job.name;
			const current = successStats.get(name) ?? { success: 0, total: 0 };
			if (job.conclusion === 'success') {
				current.success += 1;
			}
			current.total += 1;
			successStats.set(name, current);
		}
	}

	if (workflowContent) {
		const baseGraph = buildJobGraphFromWorkflow(workflowContent);

		if (baseGraph.nodes.length > 0) {
			jobGraphNodes = baseGraph.nodes.map((node) => {
				const durations = durationByJob.get(node.jobName);
				const minutes = minutesByJobMap.get(node.jobName);
				const success = successStats.get(node.jobName);
				const runCount = success?.total ?? durations?.samples ?? 0;
				const successRate =
					success && success.total > 0
						? Math.round((success.success / success.total) * 1000) / 10
						: 0;
				const minutesShare = minutes?.percentage ?? 0;

				return {
					...node,
					avgDurationMs: durations?.avgDurationMs ?? 0,
					minDurationMs: durations?.minDurationMs ?? 0,
					maxDurationMs: durations?.maxDurationMs ?? 0,
					runCount,
					successRate,
					minutesShare
				};
			});

			jobGraphEdges = baseGraph.edges;
		}
	}

	// Fallback: if we couldn't build a graph from the workflow file, at least
	// surface one node per job based on minutes/metrics (no dependencies).
	if (jobGraphNodes.length === 0 && minutesMetrics.minutesByJob.length > 0) {
		jobGraphNodes = minutesMetrics.minutesByJob.map((m, index) => {
			const durations = durationByJob.get(m.jobName);
			const success = successStats.get(m.jobName);
			const runCount = success?.total ?? durations?.samples ?? 0;
			const successRate =
				success && success.total > 0
					? Math.round((success.success / success.total) * 1000) / 10
					: 0;

			return {
				id: m.jobName,
				jobName: m.jobName,
				runnerLabel: '',
				stepCount: 0,
				avgDurationMs: durations?.avgDurationMs ?? 0,
				minDurationMs: durations?.minDurationMs ?? 0,
				maxDurationMs: durations?.maxDurationMs ?? 0,
				runCount,
				successRate,
				minutesShare: m.percentage,
				columnIndex: index, // Horizontal: each job in its own column
				rowIndex: 0
			};
		});
		jobGraphEdges = [];
	}

	// Final fallback: if we still have no nodes but we do have a job breakdown,
	// surface one node per job using duration metrics only (no dependencies).
	if (jobGraphNodes.length === 0 && jobBreakdown.length > 0) {
		const minutesByJobMapForFallback = new Map<string, JobMinutesShare>();
		for (const m of minutesMetrics.minutesByJob) {
			minutesByJobMapForFallback.set(m.jobName, m);
		}

		jobGraphNodes = jobBreakdown.map((jb, index) => {
			const minutes = minutesByJobMapForFallback.get(jb.jobName);
			const success = successStats.get(jb.jobName);
			const runCount = success?.total ?? jb.samples ?? 0;
			const successRate =
				success && success.total > 0
					? Math.round((success.success / success.total) * 1000) / 10
					: 0;

			return {
				id: jb.jobName,
				jobName: jb.jobName,
				runnerLabel: '',
				stepCount: 0,
				avgDurationMs: jb.avgDurationMs,
				minDurationMs: jb.minDurationMs,
				maxDurationMs: jb.maxDurationMs,
				runCount,
				successRate,
				minutesShare: minutes?.percentage ?? 0,
				columnIndex: index, // Horizontal: each job in its own column
				rowIndex: 0
			};
		});

		jobGraphEdges = [];
	}

	return {
		workflowId,
		workflowName: workflow.name,
		workflowPath: workflow.path,
		metrics,
		durationTrend,
		runHistory: buildRunTrend(runs, effectiveDays),
		jobBreakdown,
		recentRuns: runsToRecentRuns(runs, workflows),
		timingDataQuality: summarizeTimingQuality(runs),
		...minutesMetrics,
		jobGraphNodes,
		jobGraphEdges,
		workflowContent,
		latestFailure: latestFailedRun
			? {
					runId: latestFailedRun.id,
					runNumber: latestFailedRun.run_number,
					failedAt: getRunTiming(latestFailedRun).completedAt,
					htmlUrl: latestFailedRun.html_url,
					jobName: failedJob?.name ?? null,
					stepName: failedStep?.name ?? null
				}
			: null
	};
}
