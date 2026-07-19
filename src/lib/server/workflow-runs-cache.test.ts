import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubWorkflowRun } from '$lib/types/github';
import type { DashboardData } from '$lib/types/metrics';

vi.mock('$lib/server/redis', () => ({ getRedisClient: vi.fn() }));

import { getRedisClient } from '$lib/server/redis';
import {
	acquireSyncLock,
	appendWorkflowRuns,
	getAllTimeImportCheckpoint,
	getCachedWorkflowFile,
	getDashboardSnapshot,
	getPaginatedRuns,
	getWorkflowRuns,
	markReconciled,
	reconciliationDue,
	releaseSyncLock,
	renewSyncLock,
	setAllTimeImportCheckpoint,
	setCachedWorkflowFile,
	setDashboardSnapshot,
	storeWorkflowRuns
} from './workflow-runs-cache';

class FakeRedis {
	strings = new Map<string, { value: string; expires?: number }>();
	hashes = new Map<string, Map<string, string>>();
	zsets = new Map<string, Map<string, number>>();

	async get(key: string) {
		const entry = this.strings.get(key);
		if (entry?.expires && entry.expires <= Date.now()) {
			this.strings.delete(key);
			return null;
		}
		return entry?.value ?? null;
	}

	async set(key: string, value: string, options: { NX?: boolean; PX?: number; EX?: number } = {}) {
		if (options.NX && (await this.get(key)) !== null) return null;
		this.strings.set(key, {
			value,
			expires: options.PX
				? Date.now() + options.PX
				: options.EX
					? Date.now() + options.EX * 1000
					: undefined
		});
		return 'OK';
	}

	async hSet(key: string, values: Record<string, string>) {
		const hash = this.hashes.get(key) ?? new Map<string, string>();
		for (const [field, value] of Object.entries(values)) hash.set(field, value);
		this.hashes.set(key, hash);
	}

	async hmGet(key: string, fields: string[]) {
		const hash = this.hashes.get(key);
		return fields.map((field) => hash?.get(field) ?? null);
	}

	async del(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.strings.delete(key);
			this.hashes.delete(key);
			this.zsets.delete(key);
		}
	}

	async zAdd(key: string, entries: Array<{ score: number; value: string }>) {
		const set = this.zsets.get(key) ?? new Map<string, number>();
		for (const entry of entries) set.set(entry.value, entry.score);
		this.zsets.set(key, set);
	}

	async zRange(key: string, start: number, end: number, options: { REV?: boolean } = {}) {
		let entries = [...(this.zsets.get(key)?.entries() ?? [])].sort(
			(a, b) => a[1] - b[1] || a[0].localeCompare(b[0])
		);
		if (options.REV) entries = entries.reverse();
		const finalEnd = end < 0 ? entries.length : end + 1;
		return entries.slice(start, finalEnd).map(([value]) => value);
	}

	async zCard(key: string) {
		return this.zsets.get(key)?.size ?? 0;
	}

	async eval(_script: string, args: { keys: string[]; arguments: string[] }) {
		const [key] = args.keys;
		if ((await this.get(key)) !== args.arguments[0]) return 0;
		if (_script.includes('pexpire')) {
			const entry = this.strings.get(key);
			if (entry) entry.expires = Date.now() + Number(args.arguments[1]);
			return 1;
		}
		this.strings.delete(key);
		return 1;
	}
}

function run(id: number, workflowId = 1): GitHubWorkflowRun {
	const started = new Date(Date.UTC(2026, 0, 1, 0, id % 60)).toISOString();
	return {
		id,
		name: 'Build',
		workflow_id: workflowId,
		status: 'completed',
		conclusion: 'success',
		head_branch: 'main',
		head_sha: String(id),
		run_number: id,
		run_attempt: 1,
		event: 'push',
		created_at: started,
		updated_at: new Date(Date.parse(started) + 60_000).toISOString(),
		run_started_at: started,
		effective_completed_at: new Date(Date.parse(started) + 60_000).toISOString(),
		timing_quality: 'original',
		html_url: `https://github.test/runs/${id}`,
		actor: null
	};
}

const dashboard = {
	owner: 'acme',
	repo: 'app',
	totalRuns: 1,
	doraWorkflowIds: [],
	timingDataQuality: { repairedRuns: 0, excludedRuns: 0 },
	actionsCostEstimate: { grossCostUsd: 0 }
} as unknown as DashboardData;

describe('Redis workflow cache', () => {
	let redis: FakeRedis;

	beforeEach(() => {
		vi.useRealTimers();
		redis = new FakeRedis();
		vi.mocked(getRedisClient).mockResolvedValue(redis as never);
	});

	it('serves fresh snapshots and rejects a different DORA selection', async () => {
		await setDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_150', dashboard, []);
		expect(
			await getDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_150', 300_000, [])
		).toMatchObject({
			isStale: false,
			dashboardData: dashboard
		});
		expect(
			await getDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_150', 300_000, [7])
		).toBeNull();
		expect(
			await getDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_14_days', 300_000, [])
		).toBeNull();
	});

	it('marks snapshots stale after the configured freshness without discarding them', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		await setDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_150', dashboard, []);
		vi.advanceTimersByTime(301_000);
		expect(
			await getDashboardSnapshot('u1', 'acme', 'app', '30', 'recent_150', 300_000, [])
		).toMatchObject({ isStale: true });
	});

	it('isolates lookbacks and paginates 26k runs without a bulk response', async () => {
		const runs = Array.from({ length: 26_000 }, (_, index) => run(index + 1, index % 3));
		await storeWorkflowRuns('u1', 'acme', 'app', 'all', runs);
		await storeWorkflowRuns('u1', 'acme', 'app', '7', runs.slice(0, 7));
		const page = await getPaginatedRuns('u1', 'acme', 'app', 'all', 2, 50);
		const workflowPage = await getPaginatedRuns('u1', 'acme', 'app', 'all', 1, 50, 1);
		expect(page.items).toHaveLength(50);
		expect(page.total).toBe(26_000);
		expect(workflowPage.items).toHaveLength(50);
		expect(workflowPage.total).toBe(8_667);
		expect(workflowPage.items.every((item) => item.workflowId === 1)).toBe(true);
		expect(await getWorkflowRuns('u1', 'acme', 'app', '7')).toHaveLength(7);
		expect(await getWorkflowRuns('u2', 'acme', 'app', 'all')).toEqual([]);
	}, 15_000);

	it('uses token-safe single-flight locks', async () => {
		const token = await acquireSyncLock('u1', 'acme', 'app', '30');
		expect(token).toBeTruthy();
		expect(await acquireSyncLock('u1', 'acme', 'app', '30')).toBeNull();
		await releaseSyncLock('u1', 'acme', 'app', '30', 'wrong-token');
		expect(await acquireSyncLock('u1', 'acme', 'app', '30')).toBeNull();
		await releaseSyncLock('u1', 'acme', 'app', '30', token!);
		expect(await acquireSyncLock('u1', 'acme', 'app', '30')).toBeTruthy();
	});

	it('renews a lock only when the caller still owns its token', async () => {
		const token = await acquireSyncLock('u1', 'acme', 'app', 'all');
		expect(await renewSyncLock('u1', 'acme', 'app', 'all', token!)).toBe(true);
		expect(await renewSyncLock('u1', 'acme', 'app', 'all', 'wrong-token')).toBe(false);
	});

	it('persists resumable checkpoints and deduplicates overlapping import chunks', async () => {
		await setAllTimeImportCheckpoint('u1', 'acme', 'app', {
			nextPage: 76,
			expectedRuns: 26_000,
			importedRuns: 7_500,
			startedAt: '2026-07-19T00:00:00.000Z',
			passes: 0
		});
		expect(await getAllTimeImportCheckpoint('u1', 'acme', 'app')).toMatchObject({
			nextPage: 76,
			expectedRuns: 26_000
		});
		expect(await appendWorkflowRuns('u1', 'acme', 'app', 'all', [run(1), run(2)])).toBe(2);
		expect(await appendWorkflowRuns('u1', 'acme', 'app', 'all', [run(2), run(3)])).toBe(3);
		expect(await getWorkflowRuns('u1', 'acme', 'app', 'all')).toHaveLength(3);
	});

	it('tracks reconciliation and caches missing workflow files', async () => {
		expect(await reconciliationDue('u1', 'acme', 'app', '30')).toBe(true);
		await markReconciled('u1', 'acme', 'app', '30');
		expect(await reconciliationDue('u1', 'acme', 'app', '30')).toBe(false);
		await setCachedWorkflowFile('u1', 'acme', 'app', '.github/workflows/deleted.yml', null);
		expect(
			await getCachedWorkflowFile('u1', 'acme', 'app', '.github/workflows/deleted.yml')
		).toEqual({ hit: true, content: null });
	});

	it('prunes workflow indexes during a full reconciliation', async () => {
		await storeWorkflowRuns('u1', 'acme', 'app', '30', [run(1, 10), run(2, 20)]);
		await storeWorkflowRuns('u1', 'acme', 'app', '30', [run(3, 10)]);
		expect(await getWorkflowRuns('u1', 'acme', 'app', '30', 20)).toEqual([]);
		expect(await getWorkflowRuns('u1', 'acme', 'app', '30', 10)).toHaveLength(1);
	});

	it('propagates Redis outages so routes can return 503', async () => {
		vi.mocked(getRedisClient).mockRejectedValueOnce(new Error('offline'));
		await expect(getWorkflowRuns('u1', 'acme', 'app', 'all')).rejects.toThrow('offline');
	});
});
