import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { GitHubWorkflowRun } from '$lib/types/github';
import type {
	AverageDurationWindow,
	DashboardData,
	RecentRun,
	WorkflowDetailData
} from '$lib/types/metrics';
import { getRedisClient } from '$lib/server/redis';
import { getRunTiming } from '$lib/server/run-timing';

export type ActionsLookback = '7' | '30' | '90' | 'all';

const CACHE_VERSION = 'v1';
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 90 * 1000;
const WORKFLOW_FILE_TTL_SECONDS = 60 * 60;
const MISSING_WORKFLOW_FILE = '__missing__';
const CHUNK_SIZE = 500;

interface StoredSnapshot {
	dashboardData: DashboardData;
	fetchedAt: string;
	doraWorkflowIds: number[];
}

export interface CachedDashboardSnapshot {
	dashboardData: DashboardData;
	isStale: boolean;
	fetchedAt: string;
}

export interface PaginatedRuns {
	items: RecentRun[];
	total: number;
	page: number;
	pageSize: number;
}

export interface AllTimeImportCheckpoint {
	nextPage: number;
	expectedRuns: number;
	importedRuns: number;
	startedAt: string;
	passes: number;
}

function part(value: string): string {
	return encodeURIComponent(value.toLowerCase());
}

function baseKey(userId: string, owner: string, repo: string): string {
	return `workflow-metrics:${CACHE_VERSION}:${part(userId)}:${part(owner)}:${part(repo)}`;
}

function keys(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	averageDurationWindow: AverageDurationWindow = 'recent_150'
) {
	const base = baseKey(userId, owner, repo);
	return {
		runs: `${base}:runs`,
		repoIndex: `${base}:index:${lookback}:repo`,
		workflowIds: `${base}:index:${lookback}:workflow-ids`,
		workflowIndex: (workflowId: number) => `${base}:index:${lookback}:workflow:${workflowId}`,
		snapshot: `${base}:snapshot:${lookback}:avg:${averageDurationWindow}`,
		detailSnapshot: (workflowId: number) =>
			`${base}:snapshot:${lookback}:avg:${averageDurationWindow}:workflow:${workflowId}`,
		lock: (scope: string) => `${base}:lock:${lookback}:${part(scope)}`,
		importCheckpoint: `${base}:import:${lookback}`,
		reconciledAt: `${base}:reconciled-at:${lookback}`,
		workflowFile: (path: string) => `${base}:workflow-file:${encodeURIComponent(path)}`
	};
}

export async function getAllTimeImportCheckpoint(
	userId: string,
	owner: string,
	repo: string
): Promise<AllTimeImportCheckpoint | null> {
	const raw = await (await redis()).get(keys(userId, owner, repo, 'all').importCheckpoint);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as AllTimeImportCheckpoint;
	} catch {
		return null;
	}
}

export async function setAllTimeImportCheckpoint(
	userId: string,
	owner: string,
	repo: string,
	checkpoint: AllTimeImportCheckpoint
): Promise<void> {
	await (
		await redis()
	).set(keys(userId, owner, repo, 'all').importCheckpoint, JSON.stringify(checkpoint), {
		PX: STALE_TTL_MS
	});
}

export async function clearAllTimeImportCheckpoint(
	userId: string,
	owner: string,
	repo: string
): Promise<void> {
	await (await redis()).del(keys(userId, owner, repo, 'all').importCheckpoint);
}

export async function clearWorkflowRunIndexes(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback
): Promise<void> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	let workflowIds: number[] = [];
	try {
		workflowIds = JSON.parse((await client.get(cacheKeys.workflowIds)) ?? '[]') as number[];
	} catch {
		workflowIds = [];
	}
	await client.del([
		cacheKeys.repoIndex,
		cacheKeys.workflowIds,
		...workflowIds.map(cacheKeys.workflowIndex)
	]);
}

export async function appendWorkflowRuns(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	runs: GitHubWorkflowRun[]
): Promise<number> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	let workflowIds: number[] = [];
	try {
		workflowIds = JSON.parse((await client.get(cacheKeys.workflowIds)) ?? '[]') as number[];
	} catch {
		workflowIds = [];
	}
	const nextWorkflowIds = [...new Set([...workflowIds, ...runs.map((run) => run.workflow_id)])];
	await client.set(cacheKeys.workflowIds, JSON.stringify(nextWorkflowIds));

	for (let offset = 0; offset < runs.length; offset += CHUNK_SIZE) {
		const chunk = runs.slice(offset, offset + CHUNK_SIZE);
		const hash: Record<string, string> = {};
		const byWorkflow = new Map<number, GitHubWorkflowRun[]>();
		for (const run of chunk) {
			hash[String(run.id)] = JSON.stringify(run);
			const grouped = byWorkflow.get(run.workflow_id) ?? [];
			grouped.push(run);
			byWorkflow.set(run.workflow_id, grouped);
		}
		await client.hSet(cacheKeys.runs, hash);
		await client.zAdd(
			cacheKeys.repoIndex,
			chunk.map((run) => ({ score: Date.parse(run.created_at) || 0, value: String(run.id) }))
		);
		for (const [workflowId, workflowRuns] of byWorkflow) {
			await client.zAdd(
				cacheKeys.workflowIndex(workflowId),
				workflowRuns.map((run) => ({
					score: Date.parse(run.created_at) || 0,
					value: String(run.id)
				}))
			);
		}
	}
	return client.zCard(cacheKeys.repoIndex);
}

async function redis(): Promise<RedisClientType> {
	return getRedisClient();
}

function recentRun(run: GitHubWorkflowRun): RecentRun {
	const timing = getRunTiming(run);
	return {
		id: run.id,
		workflowName: run.name ?? `Workflow ${run.workflow_id}`,
		workflowId: run.workflow_id,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.head_branch,
		durationMs: timing.durationMs,
		startedAt: timing.startedAt,
		htmlUrl: run.html_url,
		actor: run.actor?.login ?? null,
		actorAvatar: run.actor?.avatar_url ?? null,
		runNumber: run.run_number
	};
}

async function readRuns(
	client: RedisClientType,
	hashKey: string,
	ids: string[]
): Promise<GitHubWorkflowRun[]> {
	const runs: GitHubWorkflowRun[] = [];
	for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
		const values = await client.hmGet(hashKey, ids.slice(offset, offset + CHUNK_SIZE));
		for (const value of values) {
			if (!value) continue;
			try {
				runs.push(JSON.parse(value) as GitHubWorkflowRun);
			} catch {
				// Ignore an individually corrupted cache entry; the next sync repairs the index.
			}
		}
	}
	return runs;
}

export async function getDashboardSnapshot(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	averageDurationWindow: AverageDurationWindow,
	freshnessMs: number,
	doraWorkflowIds: number[]
): Promise<CachedDashboardSnapshot | null> {
	const client = await redis();
	const raw = await client.get(keys(userId, owner, repo, lookback, averageDurationWindow).snapshot);
	if (!raw) return null;
	try {
		const snapshot = JSON.parse(raw) as StoredSnapshot;
		if (!snapshot.dashboardData.actionsCostEstimate) return null;
		if (
			[...snapshot.doraWorkflowIds].sort((a, b) => a - b).join(',') !==
			[...doraWorkflowIds].sort((a, b) => a - b).join(',')
		) {
			return null;
		}
		const age = Date.now() - Date.parse(snapshot.fetchedAt);
		if (!Number.isFinite(age) || age > STALE_TTL_MS) return null;
		return {
			dashboardData: snapshot.dashboardData,
			isStale: age > freshnessMs,
			fetchedAt: snapshot.fetchedAt
		};
	} catch {
		return null;
	}
}

export async function setDashboardSnapshot(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	averageDurationWindow: AverageDurationWindow,
	dashboardData: DashboardData,
	doraWorkflowIds: number[]
): Promise<void> {
	const client = await redis();
	const snapshot: StoredSnapshot = {
		dashboardData,
		fetchedAt: new Date().toISOString(),
		doraWorkflowIds
	};
	await client.set(
		keys(userId, owner, repo, lookback, averageDurationWindow).snapshot,
		JSON.stringify(snapshot),
		{
			PX: STALE_TTL_MS
		}
	);
}

export async function storeWorkflowRuns(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	runs: GitHubWorkflowRun[]
): Promise<void> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	const workflowIds = [...new Set(runs.map((run) => run.workflow_id))];
	let previousWorkflowIds: number[] = [];
	try {
		previousWorkflowIds = JSON.parse((await client.get(cacheKeys.workflowIds)) ?? '[]') as number[];
	} catch {
		previousWorkflowIds = [];
	}
	await client.del([
		cacheKeys.repoIndex,
		...[...new Set([...workflowIds, ...previousWorkflowIds])].map(cacheKeys.workflowIndex)
	]);
	await client.set(cacheKeys.workflowIds, JSON.stringify(workflowIds));

	for (let offset = 0; offset < runs.length; offset += CHUNK_SIZE) {
		const chunk = runs.slice(offset, offset + CHUNK_SIZE);
		const hash: Record<string, string> = {};
		for (const run of chunk) hash[String(run.id)] = JSON.stringify(run);
		await client.hSet(cacheKeys.runs, hash);
		await client.zAdd(
			cacheKeys.repoIndex,
			chunk.map((run) => ({ score: Date.parse(run.created_at) || 0, value: String(run.id) }))
		);
		for (const workflowId of workflowIds) {
			const workflowRuns = chunk.filter((run) => run.workflow_id === workflowId);
			if (workflowRuns.length === 0) continue;
			await client.zAdd(
				cacheKeys.workflowIndex(workflowId),
				workflowRuns.map((run) => ({
					score: Date.parse(run.created_at) || 0,
					value: String(run.id)
				}))
			);
		}
	}
}

export async function storeSingleWorkflowRuns(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	workflowId: number,
	runs: GitHubWorkflowRun[]
): Promise<void> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	const index = cacheKeys.workflowIndex(workflowId);
	await client.del(index);
	for (let offset = 0; offset < runs.length; offset += CHUNK_SIZE) {
		const chunk = runs.slice(offset, offset + CHUNK_SIZE);
		const hash: Record<string, string> = {};
		for (const run of chunk) hash[String(run.id)] = JSON.stringify(run);
		await client.hSet(cacheKeys.runs, hash);
		await client.zAdd(
			index,
			chunk.map((run) => ({ score: Date.parse(run.created_at) || 0, value: String(run.id) }))
		);
	}
}

export async function getWorkflowDetailSnapshot(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	workflowId: number,
	averageDurationWindow: AverageDurationWindow,
	freshnessMs: number
): Promise<{ data: WorkflowDetailData; isStale: boolean } | null> {
	const raw = await (
		await redis()
	).get(keys(userId, owner, repo, lookback, averageDurationWindow).detailSnapshot(workflowId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { data: WorkflowDetailData; fetchedAt: string };
		if (
			!parsed.data.actionsCostEstimate ||
			parsed.data.actionsCostEstimate.basis !== 'sampled-jobs' ||
			parsed.data.actionsCostEstimate.projectedRuns === undefined
		)
			return null;
		const age = Date.now() - Date.parse(parsed.fetchedAt);
		if (!Number.isFinite(age) || age > STALE_TTL_MS) return null;
		return { data: parsed.data, isStale: age > freshnessMs };
	} catch {
		return null;
	}
}

export async function setWorkflowDetailSnapshot(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	workflowId: number,
	averageDurationWindow: AverageDurationWindow,
	data: WorkflowDetailData
): Promise<void> {
	await (
		await redis()
	).set(
		keys(userId, owner, repo, lookback, averageDurationWindow).detailSnapshot(workflowId),
		JSON.stringify({ data, fetchedAt: new Date().toISOString() }),
		{ PX: STALE_TTL_MS }
	);
}

export async function getWorkflowRuns(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	workflowId?: number
): Promise<GitHubWorkflowRun[]> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	const index = workflowId ? cacheKeys.workflowIndex(workflowId) : cacheKeys.repoIndex;
	const ids = await client.zRange(index, 0, -1, { REV: true });
	return readRuns(client, cacheKeys.runs, ids);
}

export async function getPaginatedRuns(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	page: number,
	pageSize: number,
	workflowId?: number
): Promise<PaginatedRuns> {
	const client = await redis();
	const cacheKeys = keys(userId, owner, repo, lookback);
	const index = workflowId ? cacheKeys.workflowIndex(workflowId) : cacheKeys.repoIndex;
	const total = await client.zCard(index);
	const start = (page - 1) * pageSize;
	const ids = await client.zRange(index, start, start + pageSize - 1, { REV: true });
	const runs = await readRuns(client, cacheKeys.runs, ids);
	return { items: runs.map(recentRun), total, page, pageSize };
}

export async function acquireSyncLock(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	scope = 'repo'
): Promise<string | null> {
	const token = randomUUID();
	const client = await redis();
	const result = await client.set(keys(userId, owner, repo, lookback).lock(scope), token, {
		NX: true,
		PX: LOCK_TTL_MS
	});
	return result === 'OK' ? token : null;
}

export async function releaseSyncLock(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	token: string,
	scope = 'repo'
): Promise<void> {
	const client = await redis();
	await client.eval(
		"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
		{ keys: [keys(userId, owner, repo, lookback).lock(scope)], arguments: [token] }
	);
}

export async function renewSyncLock(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback,
	token: string,
	scope = 'repo'
): Promise<boolean> {
	const client = await redis();
	const result = await client.eval(
		"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
		{
			keys: [keys(userId, owner, repo, lookback).lock(scope)],
			arguments: [token, String(LOCK_TTL_MS)]
		}
	);
	return result === 1;
}

export async function reconciliationDue(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback
): Promise<boolean> {
	const value = await (await redis()).get(keys(userId, owner, repo, lookback).reconciledAt);
	return !value || Date.now() - Date.parse(value) >= RECONCILE_INTERVAL_MS;
}

export async function markReconciled(
	userId: string,
	owner: string,
	repo: string,
	lookback: ActionsLookback
): Promise<void> {
	await (
		await redis()
	).set(keys(userId, owner, repo, lookback).reconciledAt, new Date().toISOString());
}

export async function getCachedWorkflowFile(
	userId: string,
	owner: string,
	repo: string,
	path: string
): Promise<{ hit: boolean; content: string | null }> {
	const value = await (await redis()).get(keys(userId, owner, repo, 'all').workflowFile(path));
	return value === null
		? { hit: false, content: null }
		: { hit: true, content: value === MISSING_WORKFLOW_FILE ? null : value };
}

export async function setCachedWorkflowFile(
	userId: string,
	owner: string,
	repo: string,
	path: string,
	content: string | null
): Promise<void> {
	await (
		await redis()
	).set(keys(userId, owner, repo, 'all').workflowFile(path), content ?? MISSING_WORKFLOW_FILE, {
		EX: WORKFLOW_FILE_TTL_SECONDS
	});
}
