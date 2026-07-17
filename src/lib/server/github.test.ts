import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createOctokit,
	isGitHubUnauthorizedError,
	fetchWorkflows,
	fetchWorkflowRuns,
	fetchAllWorkflowRunsForRepo,
	fetchSingleWorkflowRuns,
	fetchAllSingleWorkflowRuns,
	fetchJobsForRun,
	fetchWorkflowFileCommits,
	buildDashboardData,
	buildWorkflowDetailData,
	fetchIncrementalWorkflowRunsForRepo,
	fetchIncrementalSingleWorkflowRuns,
	isTrustedGitHubLogDownloadUrl
} from './github';
import type { GitHubWorkflow, GitHubWorkflowRun, GitHubJob } from '$lib/types/github';

// Mock Octokit
vi.mock('@octokit/rest', () => ({
	Octokit: vi.fn().mockImplementation(() => ({
		request: vi.fn(),
		paginate: vi.fn(async (method, options) => (await method(options)).data.workflows),
		rest: {
			actions: {
				listRepoWorkflows: vi.fn(),
				listWorkflowRunsForRepo: vi.fn(),
				listWorkflowRuns: vi.fn(),
				listJobsForWorkflowRun: vi.fn()
			},
			repos: {
				listCommits: vi.fn(),
				getContent: vi.fn()
			}
		}
	}))
}));

describe('createOctokit', () => {
	it('creates Octokit instance with access token', () => {
		const octokit = createOctokit('test-token');
		expect(octokit).toBeDefined();
	});
});

describe('isTrustedGitHubLogDownloadUrl', () => {
	it.each([
		'https://pipelines.actions.githubusercontent.com/logs',
		'https://results-receiver.actions.githubusercontent.com/logs',
		'https://example.blob.core.windows.net/logs'
	])('accepts trusted HTTPS log download hosts: %s', (url) => {
		expect(isTrustedGitHubLogDownloadUrl(url)).toBe(true);
	});

	it.each([
		'http://pipelines.actions.githubusercontent.com/logs',
		'https://api.github.com/logs',
		'https://127.0.0.1/logs',
		'not-a-url'
	])('rejects untrusted log download targets: %s', (url) => {
		expect(isTrustedGitHubLogDownloadUrl(url)).toBe(false);
	});
});

describe('isGitHubUnauthorizedError', () => {
	it('returns true for 401 status', () => {
		const error = { status: 401 };
		expect(isGitHubUnauthorizedError(error)).toBe(true);
	});

	it('returns true for Bad credentials message', () => {
		const error = { response: { data: { message: 'Bad credentials' } } };
		expect(isGitHubUnauthorizedError(error)).toBe(true);
	});

	it('returns true for message containing Bad credentials', () => {
		const error = { message: 'Bad credentials error' };
		expect(isGitHubUnauthorizedError(error)).toBe(true);
	});

	it('returns false for null', () => {
		expect(isGitHubUnauthorizedError(null)).toBe(false);
	});

	it('returns false for non-object', () => {
		expect(isGitHubUnauthorizedError('error')).toBe(false);
	});

	it('returns false for other errors', () => {
		expect(isGitHubUnauthorizedError({ status: 500 })).toBe(false);
		expect(isGitHubUnauthorizedError({ message: 'Not found' })).toBe(false);
	});

	it('handles nested response status', () => {
		const error = { response: { status: 401 } };
		expect(isGitHubUnauthorizedError(error)).toBe(true);
	});
});

describe('fetchWorkflows', () => {
	it('filters out reusable workflows and returns only non-reusable workflows', async () => {
		const mockWorkflows: GitHubWorkflow[] = [
			{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } as GitHubWorkflow,
			{
				id: 2,
				name: '_Reusable Deploy',
				path: '.github/workflows/_deploy.yml',
				state: 'active'
			} as GitHubWorkflow,
			{
				id: 3,
				name: 'Test',
				path: '.github/workflows/test.yml',
				state: 'active'
			} as GitHubWorkflow
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);

		const result = await fetchWorkflows(octokit, 'owner', 'repo');
		expect(result.map((workflow) => workflow.id)).toEqual([1, 3]);
		expect(result.every((workflow) => !workflow.path.split('/').pop()?.startsWith('_'))).toBe(true);
	});

	it('returns an empty array when all workflows are reusable', async () => {
		const mockWorkflows: GitHubWorkflow[] = [
			{
				id: 10,
				name: '_Reusable A',
				path: '.github/workflows/_reusable-a.yml',
				state: 'active'
			} as GitHubWorkflow,
			{
				id: 11,
				name: '_Reusable B',
				path: '.github/workflows/_reusable-b.yml',
				state: 'active'
			} as GitHubWorkflow
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);

		const result = await fetchWorkflows(octokit, 'owner', 'repo');
		expect(result).toEqual([]);
	});
});

describe('fetchWorkflowRuns', () => {
	it('fetches workflow runs with default options', async () => {
		const mockRuns: GitHubWorkflowRun[] = [
			{ id: 1, status: 'completed', conclusion: 'success' } as GitHubWorkflowRun
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: mockRuns }
		} as never);

		const result = await fetchWorkflowRuns(octokit, 'owner', 'repo');
		expect(result).toEqual([expect.objectContaining(mockRuns[0])]);
	});

	it('fetches with custom per_page and page', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: [] }
		} as never);

		await fetchWorkflowRuns(octokit, 'owner', 'repo', { per_page: 50, page: 2 });
		expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			per_page: 50,
			page: 2,
			exclude_pull_requests: true
		});
	});

	it('includes created filter when provided', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: [] }
		} as never);

		await fetchWorkflowRuns(octokit, 'owner', 'repo', { created: '>=2024-01-01' });
		expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			per_page: 100,
			page: 1,
			exclude_pull_requests: true,
			created: '>=2024-01-01'
		});
	});
});

describe('fetchIncrementalWorkflowRunsForRepo', () => {
	it('stops at an unchanged full page and preserves repaired timing fields', async () => {
		const octokit = createOctokit('test-token');
		const cachedRuns = Array.from(
			{ length: 100 },
			(_, index) =>
				({
					id: index + 1,
					workflow_id: 1,
					status: 'completed',
					conclusion: 'success',
					created_at: '2026-01-01T00:00:00Z',
					updated_at: '2027-01-01T00:00:00Z',
					run_started_at: '2026-01-01T00:00:00Z',
					run_attempt: 1,
					effective_completed_at: '2026-01-01T00:20:00Z',
					timing_quality: 'repaired'
				}) as GitHubWorkflowRun
		);
		const listingRuns = cachedRuns.map((run) => {
			const copy = { ...run };
			delete copy.effective_completed_at;
			delete copy.timing_quality;
			return copy;
		});
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: listingRuns, total_count: 100 }
		} as never);
		const result = await fetchIncrementalWorkflowRunsForRepo(octokit, 'owner', 'repo', cachedRuns);
		expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledTimes(1);
		expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
			expect.objectContaining({ exclude_pull_requests: true })
		);
		expect(result[0].timing_quality).toBe('repaired');
		expect(result[0].effective_completed_at).toBe('2026-01-01T00:20:00Z');
	});
});

describe('fetchAllWorkflowRunsForRepo', () => {
	let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
	const response = (runs: GitHubWorkflowRun[], total = runs.length) =>
		({
			data: { workflow_runs: runs, total_count: total },
			headers: { 'x-ratelimit-remaining': '4000' }
		}) as never;
	const run = (id: number, createdAt: string): GitHubWorkflowRun =>
		({ id, workflow_id: 1, status: 'completed', created_at: createdAt }) as GitHubWorkflowRun;

	beforeEach(() => {
		consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		consoleInfoSpy.mockRestore();
	});

	const runsForPage = (total: number, page: number) => {
		const offset = (page - 1) * 100;
		return Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, index) => {
			const id = total - offset - index;
			return run(id, new Date(Date.UTC(2024, 0, 1) + id * 1_000).toISOString());
		});
	};

	it('keeps GitHub unfiltered, filters the lookback locally, and omits pull request payloads', async () => {
		const octokit = createOctokit('test-token');
		const runs = [run(2, '2024-01-03T00:00:00Z'), run(1, '2023-12-31T00:00:00Z')];
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				return options.per_page === 1 ? response([runs[0]], 2) : response(runs, 2);
			}
		);
		const onProgress = vi.fn();

		const result = await fetchAllWorkflowRunsForRepo(
			octokit,
			'owner',
			'repo',
			'>=2024-01-01',
			undefined,
			onProgress
		);

		expect(result.map((item) => item.id)).toEqual([2]);
		expect(onProgress).toHaveBeenCalledWith(2, 2, 1);
		expect(
			vi
				.mocked(octokit.rest.actions.listWorkflowRunsForRepo)
				.mock.calls.every(
					([options]) => options?.exclude_pull_requests === true && !('created' in options)
				)
		).toBe(true);
	});

	it.each([0, 99, 1_000])('imports %i stable runs exactly', async (total) => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				return options.per_page === 1
					? response(runsForPage(total, 1).slice(0, 1), total)
					: response(runsForPage(total, options.page!), total);
			}
		);

		const result = await fetchAllWorkflowRunsForRepo(octokit, 'owner', 'repo');

		expect(result).toHaveLength(total);
		expect(new Set(result.map((item) => item.id)).size).toBe(total);
	});

	it('never exceeds three concurrent page requests and keeps progress monotonic', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
		const octokit = createOctokit('test-token');
		let active = 0;
		let maxActive = 0;
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				if (options.per_page === 1) return response(runsForPage(400, 1).slice(0, 1), 400);
				if (options.page === 1) return response(runsForPage(400, 1), 400);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, (5 - options.page!) * 10));
				active--;
				return response(runsForPage(400, options.page!), 400);
			}
		);
		const onProgress = vi.fn();
		const pending = fetchAllWorkflowRunsForRepo(
			octokit,
			'owner',
			'repo',
			'>=2024-01-01',
			undefined,
			onProgress
		);
		await vi.runAllTimersAsync();
		await pending;

		expect(maxActive).toBe(3);
		expect(onProgress.mock.calls.map(([fetched]) => fetched)).toEqual([100, 200, 300, 400]);
		expect(onProgress.mock.calls.map(([, , page]) => page)).toEqual([1, 2, 3, 4]);
	});

	it('retries rate limits and serializes subsequent requests', async () => {
		const octokit = createOctokit('test-token');
		let calls = 0;
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				calls++;
				if (calls === 1)
					throw {
						status: 429,
						response: { status: 429, headers: { 'retry-after': '0' } }
					};
				return options.per_page === 1
					? response([run(1, '2024-01-01T12:00:00Z')], 1)
					: response([run(1, '2024-01-01T12:00:00Z')], 1);
			}
		);

		await fetchAllWorkflowRunsForRepo(octokit, 'owner', 'repo', '>=2024-01-01');

		expect(calls).toBe(3);
		expect(console.info).toHaveBeenCalledWith(
			'[workflow-run-import]',
			expect.objectContaining({ retries: 1, finalConcurrency: 1, fallbackReason: null })
		);
	});

	it('retries the concurrent import when the total or newest-run anchor changes', async () => {
		const octokit = createOctokit('test-token');
		let attempt = 0;
		const onProgress = vi.fn();
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				if (options.per_page === 100 && options.page === 1) attempt++;
				const total = attempt === 1 ? 200 : 199;
				return options.per_page === 1
					? response(runsForPage(199, 1).slice(0, 1), 199)
					: response(runsForPage(total, options.page!), total);
			}
		);

		const result = await fetchAllWorkflowRunsForRepo(
			octokit,
			'owner',
			'repo',
			undefined,
			undefined,
			onProgress
		);

		expect(attempt).toBe(2);
		expect(result).toHaveLength(199);
		expect(onProgress.mock.calls.map(([, , page]) => page)).toEqual([1, 2, 3, 4]);
		expect(onProgress.mock.calls.map(([fetched]) => fetched)).toEqual([100, 200, 200, 200]);
		expect(console.info).toHaveBeenCalledWith(
			'[workflow-run-import]',
			expect.objectContaining({ attempts: 2, fallbackReason: null })
		);
	});

	it('falls back to serial pagination after two unstable concurrent attempts', async () => {
		const octokit = createOctokit('test-token');
		let dataPageOneCalls = 0;
		const onProgress = vi.fn();
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				if (options.per_page === 100 && options.page === 1) dataPageOneCalls++;
				if (dataPageOneCalls >= 3) return response(runsForPage(2, 1), 2);
				return options.per_page === 1
					? response(runsForPage(1, 1), 1)
					: response(runsForPage(2, options.page!), 2);
			}
		);

		const result = await fetchAllWorkflowRunsForRepo(
			octokit,
			'owner',
			'repo',
			undefined,
			undefined,
			onProgress
		);

		expect(dataPageOneCalls).toBe(3);
		expect(result).toHaveLength(2);
		expect(onProgress.mock.calls.map(([, , page]) => page)).toEqual([1, 2, 3]);
		expect(console.info).toHaveBeenCalledWith(
			'[workflow-run-import]',
			expect.objectContaining({
				attempts: 2,
				fallbackReason: 'unstable-listing:2/1/2'
			})
		);
	});

	it('imports 26k unique runs exactly without a bulk response', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockImplementation(
			async (rawOptions) => {
				const options = rawOptions!;
				return options.per_page === 1
					? response(runsForPage(26_000, 1).slice(0, 1), 26_000)
					: response(runsForPage(26_000, options.page!), 26_000);
			}
		);

		const result = await fetchAllWorkflowRunsForRepo(octokit, 'owner', 'repo', '>=2024-01-01');

		expect(result).toHaveLength(26_000);
		expect(new Set(result.map((item) => item.id)).size).toBe(26_000);
		expect(result[0].id).toBe(26_000);
		expect(result.at(-1)?.id).toBe(1);
	}, 15_000);
});

describe('fetchSingleWorkflowRuns', () => {
	it('fetches runs for specific workflow', async () => {
		const mockRuns: GitHubWorkflowRun[] = [
			{ id: 1, workflow_id: 123, status: 'completed' } as GitHubWorkflowRun
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: { workflow_runs: mockRuns }
		} as never);

		const result = await fetchSingleWorkflowRuns(octokit, 'owner', 'repo', 123);
		expect(result).toEqual([expect.objectContaining(mockRuns[0])]);
		expect(octokit.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			workflow_id: 123,
			per_page: 100,
			page: 1
		});
	});
});

describe('fetchAllSingleWorkflowRuns', () => {
	it('paginates through all runs for single workflow', async () => {
		const octokit = createOctokit('test-token');
		const mockRuns = [{ id: 1, workflow_id: 123, status: 'completed' } as GitHubWorkflowRun];

		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: { workflow_runs: mockRuns }
		} as never);

		const result = await fetchAllSingleWorkflowRuns(octokit, 'owner', 'repo', 123, '>=2024-01-01');
		expect(result).toEqual([expect.objectContaining(mockRuns[0])]);
	});

	it('filters locally instead of using GitHub created search', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: {
				workflow_runs: [
					{ id: 1, workflow_id: 123, created_at: '2024-01-02T00:00:00Z' },
					{ id: 2, workflow_id: 123, created_at: '2023-12-31T23:59:59Z' }
				]
			}
		} as never);

		const result = await fetchAllSingleWorkflowRuns(octokit, 'owner', 'repo', 123, '>=2024-01-01');

		expect(result.map((run) => run.id)).toEqual([1]);
		expect(octokit.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			workflow_id: 123,
			per_page: 100,
			page: 1
		});
	});

	it('incrementally stops at an unchanged full workflow page', async () => {
		const octokit = createOctokit('test-token');
		const cachedRuns = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			workflow_id: 123,
			status: 'completed',
			conclusion: 'success',
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:01:00Z',
			run_started_at: '2026-01-01T00:00:00Z',
			run_attempt: 1,
			effective_completed_at: '2026-01-01T00:01:00Z',
			timing_quality: 'original'
		})) as GitHubWorkflowRun[];
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: { workflow_runs: cachedRuns }
		} as never);

		const result = await fetchIncrementalSingleWorkflowRuns(
			octokit,
			'owner',
			'repo',
			123,
			cachedRuns
		);

		expect(result).toHaveLength(100);
		expect(octokit.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(1);
	});
});

describe('fetchJobsForRun', () => {
	it('fetches jobs for a workflow run', async () => {
		const mockJobs: GitHubJob[] = [{ id: 1, name: 'build', status: 'completed' } as GitHubJob];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listJobsForWorkflowRun).mockResolvedValue({
			data: { jobs: mockJobs }
		} as never);

		const result = await fetchJobsForRun(octokit, 'owner', 'repo', 123);
		expect(result).toEqual(mockJobs);
		expect(octokit.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			run_id: 123,
			per_page: 100
		});
	});
});

describe('fetchWorkflowFileCommits', () => {
	it('fetches commits for workflow files', async () => {
		const mockCommits = [
			{
				sha: 'abc123',
				commit: {
					message: 'Update CI workflow',
					committer: { date: '2024-01-15T10:30:00Z' }
				}
			}
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({
			data: mockCommits
		} as never);

		const since = new Date('2024-01-01');
		const result = await fetchWorkflowFileCommits(octokit, 'owner', 'repo', since);
		expect(result).toHaveLength(1);
		expect(result[0].sha).toBe('abc123');
		expect(result[0].message).toBe('Update CI workflow');
	});

	it('truncates long commit messages', async () => {
		const mockCommits = [
			{
				sha: 'abc123',
				commit: {
					message: 'A'.repeat(100) + '\nSecond line',
					committer: { date: '2024-01-15T10:30:00Z' }
				}
			}
		];
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({
			data: mockCommits
		} as never);

		const since = new Date('2024-01-01');
		const result = await fetchWorkflowFileCommits(octokit, 'owner', 'repo', since);
		expect(result[0].message.length).toBeLessThanOrEqual(80);
	});
});

describe('buildDashboardData', () => {
	it('uses repaired attempt timing across duration, percentile, DORA, and minutes metrics', async () => {
		const octokit = createOctokit('test-token');
		const corrupted = {
			id: 99,
			name: 'Prod Deploy',
			workflow_id: 1,
			status: 'completed',
			conclusion: 'success',
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2027-02-01T00:00:00Z',
			run_started_at: '2026-01-01T00:00:00Z',
			run_attempt: 2,
			head_commit: { timestamp: '2026-01-01T00:00:00Z' }
		} as GitHubWorkflowRun;
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: {
				workflows: [
					{ id: 1, name: 'Prod Deploy', path: '.github/workflows/prod.yml', state: 'active' }
				]
			}
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: [corrupted], total_count: 1 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);
		vi.mocked(octokit.rest.repos.getContent).mockRejectedValue(new Error('deleted'));
		vi.mocked(octokit.request).mockResolvedValue({
			data: { run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:20:00Z' }
		} as never);

		const result = await buildDashboardData(octokit, 'owner', 'repo', {
			days: null,
			doraWorkflowIds: [1]
		});

		expect(result.avgDurationMs).toBe(20 * 60_000);
		expect(result.workflowMetrics[0]).toMatchObject({
			avgDurationMs: 20 * 60_000,
			p50DurationMs: 20 * 60_000,
			p95DurationMs: 20 * 60_000
		});
		expect(result.totalMinutes30d).toBe(20);
		expect(result.minutesByWorkflow[0].minutes).toBe(20);
		expect(result.dora?.leadTimeForChangesMs).toBe(20 * 60_000);
		expect(result.timingDataQuality).toEqual({ repairedRuns: 1, excludedRuns: 0 });
		expect(result.minutesTrend.find((point) => point.date === '2026-01-01')?.minutes).toBe(20);
	});

	it('preserves run history when a workflow is absent from the current workflow list', async () => {
		const octokit = createOctokit('test-token');
		const mockWorkflows: GitHubWorkflow[] = [
			{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } as GitHubWorkflow,
			{
				id: 2,
				name: 'Reusable Deploy',
				path: '.github/workflows/_deploy.yml',
				state: 'active'
			} as GitHubWorkflow
		];
		const mockRuns: GitHubWorkflowRun[] = [
			{
				id: 1,
				workflow_id: 1,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 60_000).toISOString()
			} as GitHubWorkflowRun,
			{
				id: 2,
				workflow_id: 2,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 30_000).toISOString()
			} as GitHubWorkflowRun
		];

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: mockRuns, total_count: 2 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);
		vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
			data: { type: 'file', content: 'bmFtZTogQ0k=' }
		} as never);

		const result = await buildDashboardData(octokit, 'owner', 'repo', { days: 7 });

		expect(result.workflowMetrics).toHaveLength(2);
		expect(result.workflowMetrics[0].workflowId).toBe(1);
		expect(result.activeWorkflows).toBe(1);
		expect(result.totalRuns).toBe(2);
	});

	it('imports old runs when all-time history is requested', async () => {
		const octokit = createOctokit('test-token');
		const oldRun = {
			id: 1,
			name: 'CI',
			workflow_id: 1,
			status: 'completed',
			conclusion: 'success',
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:01:00Z',
			run_started_at: '2024-01-01T00:00:00Z'
		} as GitHubWorkflowRun;

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: {
				workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }]
			}
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: [oldRun], total_count: 1 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);
		vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
			data: { type: 'file', content: 'bmFtZTogQ0k=' }
		} as never);

		const result = await buildDashboardData(octokit, 'owner', 'repo', { days: null });

		expect(result.totalRuns).toBe(1);
		expect(result.isAllTime).toBe(true);
		expect(octokit.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: 'owner',
				repo: 'repo',
				per_page: 100,
				page: 1,
				exclude_pull_requests: true
			})
		);
		expect(
			vi
				.mocked(octokit.rest.actions.listWorkflowRunsForRepo)
				.mock.calls.every(([options]) => options != null && !('created' in options))
		).toBe(true);
	});

	it('does not fetch generated workflow paths as repository files', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: {
				workflows: [
					{
						id: 1,
						name: 'Copilot',
						path: 'dynamic/agents/copilot-pull-request-reviewer',
						state: 'active'
					}
				]
			}
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: [], total_count: 0 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);

		await buildDashboardData(octokit, 'owner', 'repo', { days: null });

		expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
	});

	it('builds dashboard data from GitHub data', async () => {
		const octokit = createOctokit('test-token');
		const mockWorkflows: GitHubWorkflow[] = [
			{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } as GitHubWorkflow
		];
		const mockRuns: GitHubWorkflowRun[] = [
			{
				id: 1,
				workflow_id: 1,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 60000).toISOString()
			} as GitHubWorkflowRun
		];

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: mockRuns, total_count: 1 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);
		vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
			data: { type: 'file', content: 'bmFtZTogQ0k=' }
		} as never);

		const result = await buildDashboardData(octokit, 'owner', 'repo', { days: 7 });
		expect(result.owner).toBe('owner');
		expect(result.repo).toBe('repo');
		expect(result.totalRuns).toBe(1);
		expect(result.workflowMetrics).toHaveLength(1);
	});

	it('uses cached runs when provided', async () => {
		const octokit = createOctokit('test-token');
		const mockWorkflows: GitHubWorkflow[] = [
			{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } as GitHubWorkflow
		];
		const cachedRuns: GitHubWorkflowRun[] = [
			{
				id: 1,
				workflow_id: 1,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 60000).toISOString()
			} as GitHubWorkflowRun
		];

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);
		vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
			data: { type: 'file', content: 'bmFtZTogQ0k=' }
		} as never);

		const result = await buildDashboardData(octokit, 'owner', 'repo', {
			cachedRuns,
			days: 7
		});
		expect(result.totalRuns).toBe(1);
	});

	it('calls onRunsFetched callback', async () => {
		const octokit = createOctokit('test-token');
		const onRunsFetched = vi.fn();
		const mockRuns: GitHubWorkflowRun[] = [
			{
				id: 1,
				workflow_id: 1,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 60000).toISOString()
			} as GitHubWorkflowRun
		];

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: [] }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRunsForRepo).mockResolvedValue({
			data: { workflow_runs: mockRuns, total_count: 1 }
		} as never);
		vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [] } as never);

		await buildDashboardData(octokit, 'owner', 'repo', { onRunsFetched, days: 7 });
		expect(onRunsFetched).toHaveBeenCalledWith([expect.objectContaining(mockRuns[0])]);
	});
});

describe('buildWorkflowDetailData', () => {
	it('builds workflow detail data', async () => {
		const octokit = createOctokit('test-token');
		const mockWorkflows: GitHubWorkflow[] = [
			{ id: 123, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } as GitHubWorkflow
		];
		const mockRuns: GitHubWorkflowRun[] = [
			{
				id: 1,
				workflow_id: 123,
				status: 'completed',
				conclusion: 'success',
				updated_at: new Date().toISOString(),
				run_started_at: new Date(Date.now() - 60000).toISOString()
			} as GitHubWorkflowRun
		];
		const mockJobs: GitHubJob[] = [
			{
				id: 1,
				run_id: 1,
				name: 'build',
				status: 'completed',
				conclusion: 'success',
				started_at: new Date().toISOString(),
				completed_at: new Date(Date.now() + 30000).toISOString(),
				runner_name: 'GitHub Actions',
				labels: ['ubuntu-latest'],
				steps: []
			} as GitHubJob
		];

		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: mockWorkflows }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: { workflow_runs: mockRuns }
		} as never);
		vi.mocked(octokit.rest.actions.listJobsForWorkflowRun).mockResolvedValue({
			data: { jobs: mockJobs }
		} as never);
		vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
			data: { type: 'file', content: 'bmFtZTogQ0k=' }
		} as never);

		const result = await buildWorkflowDetailData(octokit, 'owner', 'repo', 123);
		expect(result.workflowId).toBe(123);
		expect(result.workflowName).toBe('CI');
	});

	it('limits workflow runs locally without GitHub created search', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: [{ id: 123, name: 'CI', path: 'dynamic/ci.yml', state: 'active' }] }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: {
				workflow_runs: [
					{ id: 1, workflow_id: 123, created_at: '2026-06-12T00:00:00Z' },
					{ id: 2, workflow_id: 123, created_at: '2026-06-10T23:59:59Z' }
				]
			}
		} as never);

		await buildWorkflowDetailData(octokit, 'owner', 'repo', 123, { days: 30 });

		expect(octokit.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			workflow_id: 123,
			per_page: 100,
			page: 1
		});
		vi.useRealTimers();
	});

	it('builds detail for a deleted workflow retained in run history', async () => {
		const octokit = createOctokit('test-token');
		const historicalRun = {
			id: 1,
			name: 'Deleted CI',
			workflow_id: 999,
			status: 'completed',
			conclusion: 'success',
			created_at: '2025-01-01T00:00:00Z',
			updated_at: '2025-01-01T00:01:00Z',
			run_started_at: '2025-01-01T00:00:00Z',
			html_url: 'https://github.com/owner/repo/actions/runs/1'
		} as GitHubWorkflowRun;
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: [] }
		} as never);
		vi.mocked(octokit.rest.actions.listJobsForWorkflowRun).mockResolvedValue({
			data: { jobs: [] }
		} as never);

		const result = await buildWorkflowDetailData(octokit, 'owner', 'repo', 999, {
			cachedRuns: [historicalRun]
		});

		expect(result).toMatchObject({
			workflowId: 999,
			workflowName: 'Deleted CI',
			workflowPath: 'historical/999'
		});
		expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
	});

	it('throws error when workflow not found', async () => {
		const octokit = createOctokit('test-token');
		vi.mocked(octokit.rest.actions.listRepoWorkflows).mockResolvedValue({
			data: { workflows: [] }
		} as never);
		vi.mocked(octokit.rest.actions.listWorkflowRuns).mockResolvedValue({
			data: { workflow_runs: [] }
		} as never);

		await expect(buildWorkflowDetailData(octokit, 'owner', 'repo', 999)).rejects.toThrow(
			'Workflow 999 not found'
		);
	});
});
