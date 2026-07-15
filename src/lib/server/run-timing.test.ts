import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { GitHubWorkflowRun } from '$lib/types/github';
import {
	MAX_WORKFLOW_DURATION_MS,
	getRunTiming,
	normalizeWorkflowRun,
	repairWorkflowRunTimings,
	summarizeTimingQuality
} from './run-timing';

function run(overrides: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun {
	return {
		id: 1,
		name: 'Deploy',
		workflow_id: 10,
		status: 'completed',
		conclusion: 'success',
		head_branch: 'main',
		head_sha: 'abc',
		run_number: 1,
		run_attempt: 1,
		event: 'push',
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:20:00Z',
		run_started_at: '2026-01-01T00:00:00Z',
		html_url: 'https://github.test/run/1',
		actor: null,
		...overrides
	};
}

describe('workflow run timing', () => {
	it('accepts the exact 35-day boundary', () => {
		const normalized = normalizeWorkflowRun(
			run({
				updated_at: new Date(
					Date.parse('2026-01-01T00:00:00Z') + MAX_WORKFLOW_DURATION_MS
				).toISOString()
			})
		);
		expect(getRunTiming(normalized).durationMs).toBe(MAX_WORKFLOW_DURATION_MS);
		expect(getRunTiming(normalized).quality).toBe('original');
	});

	it('repairs a corrupted listing timestamp from its matching rerun attempt', async () => {
		const corrupted = normalizeWorkflowRun(
			run({ id: 42, run_attempt: 3, updated_at: '2027-02-01T00:00:00Z' })
		);
		const request = vi.fn().mockResolvedValue({
			data: { run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:24:00Z' }
		});
		await repairWorkflowRunTimings({ request } as unknown as Octokit, 'acme', 'repo', [corrupted]);
		expect(request).toHaveBeenCalledWith(
			'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
			expect.objectContaining({ run_id: 42, attempt_number: 3 })
		);
		expect(getRunTiming(corrupted)).toMatchObject({ durationMs: 24 * 60_000, quality: 'repaired' });
	});

	it('excludes timing when attempt repair fails but keeps the run object', async () => {
		const corrupted = normalizeWorkflowRun(run({ updated_at: '2027-02-01T00:00:00Z' }));
		const request = vi.fn().mockRejectedValue(new Error('missing'));
		await repairWorkflowRunTimings({ request } as unknown as Octokit, 'acme', 'repo', [corrupted]);
		expect(getRunTiming(corrupted).durationMs).toBeNull();
		expect(summarizeTimingQuality([corrupted])).toEqual({ repairedRuns: 0, excludedRuns: 1 });
	});

	it('excludes invalid and null timestamps', () => {
		const invalid = normalizeWorkflowRun(run({ run_started_at: 'invalid' }));
		const missing = normalizeWorkflowRun(run({ run_started_at: null, created_at: 'invalid' }));
		expect(getRunTiming(invalid).durationMs).toBeNull();
		expect(getRunTiming(missing).durationMs).toBeNull();
	});

	it('limits attempt repairs to four concurrent requests', async () => {
		let active = 0;
		let peak = 0;
		const request = vi.fn().mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 2));
			active--;
			return {
				data: { run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:20:00Z' }
			};
		});
		const runs = Array.from({ length: 12 }, (_, index) =>
			normalizeWorkflowRun(run({ id: index + 1, updated_at: '2027-02-01T00:00:00Z' }))
		);
		await repairWorkflowRunTimings({ request } as unknown as Octokit, 'acme', 'repo', runs);
		expect(peak).toBe(4);
		expect(runs.every((item) => item.timing_quality === 'repaired')).toBe(true);
	});
});
