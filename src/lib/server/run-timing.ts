import type { Octokit } from '@octokit/rest';
import type { GitHubWorkflowRun } from '$lib/types/github';

export const MAX_WORKFLOW_DURATION_MS = 35 * 24 * 60 * 60 * 1000;

export interface RunTiming {
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	quality: 'original' | 'repaired' | 'excluded';
}

export interface TimingDataQuality {
	repairedRuns: number;
	excludedRuns: number;
}

function timestamp(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function validDuration(startedAt: string | null, completedAt: string | null): number | null {
	const start = timestamp(startedAt);
	const end = timestamp(completedAt);
	if (start === null || end === null || end < start) return null;
	const duration = end - start;
	return duration <= MAX_WORKFLOW_DURATION_MS ? duration : null;
}

export function normalizeWorkflowRun(run: GitHubWorkflowRun): GitHubWorkflowRun {
	const startedAt = run.run_started_at ?? run.created_at ?? null;
	const duration = validDuration(startedAt, run.updated_at);
	return {
		id: run.id,
		name: run.name,
		workflow_id: run.workflow_id,
		status: run.status,
		conclusion: run.conclusion,
		head_branch: run.head_branch,
		head_sha: run.head_sha,
		run_number: run.run_number,
		run_attempt: run.run_attempt,
		event: run.event,
		created_at: run.created_at,
		updated_at: run.updated_at,
		run_started_at: run.run_started_at,
		effective_completed_at: run.status === 'completed' && duration !== null ? run.updated_at : null,
		timing_quality: run.status === 'completed' && duration === null ? 'excluded' : 'original',
		html_url: run.html_url,
		actor: run.actor ? { login: run.actor.login, avatar_url: run.actor.avatar_url } : null,
		head_commit: run.head_commit
			? {
					id: run.head_commit.id,
					timestamp: run.head_commit.timestamp,
					message: run.head_commit.message
				}
			: null
	};
}

export function getRunTiming(run: GitHubWorkflowRun): RunTiming {
	const startedAt = run.run_started_at ?? run.created_at ?? null;
	const completedAt = run.effective_completed_at ?? null;
	const durationMs = validDuration(startedAt, completedAt);
	return {
		startedAt,
		completedAt: durationMs === null ? null : completedAt,
		durationMs,
		quality:
			durationMs === null && run.status === 'completed'
				? 'excluded'
				: (run.timing_quality ?? 'original')
	};
}

export function summarizeTimingQuality(runs: GitHubWorkflowRun[]): TimingDataQuality {
	let repairedRuns = 0;
	let excludedRuns = 0;
	for (const run of runs) {
		if (run.status !== 'completed') continue;
		const timing = getRunTiming(run);
		if (timing.quality === 'repaired') repairedRuns++;
		if (timing.durationMs === null) excludedRuns++;
	}
	return { repairedRuns, excludedRuns };
}

function needsRepair(run: GitHubWorkflowRun): boolean {
	if (run.status !== 'completed' || run.timing_quality === 'repaired') return false;
	const startedAt = timestamp(run.run_started_at ?? run.created_at);
	const listedCompletedAt = timestamp(run.updated_at);
	return (
		startedAt !== null &&
		listedCompletedAt !== null &&
		listedCompletedAt - startedAt > MAX_WORKFLOW_DURATION_MS
	);
}

export async function repairWorkflowRunTimings(
	octokit: Octokit,
	owner: string,
	repo: string,
	runs: GitHubWorkflowRun[],
	onProgress?: (completed: number, total: number) => void
): Promise<void> {
	const candidates = runs.filter(needsRepair);
	let next = 0;
	let completed = 0;

	await Promise.all(
		Array.from({ length: Math.min(4, candidates.length) }, async () => {
			while (next < candidates.length) {
				const run = candidates[next++];
				try {
					const response = await octokit.request(
						'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
						{
							owner,
							repo,
							run_id: run.id,
							attempt_number: run.run_attempt ?? 1
						}
					);
					const attempt = response.data as {
						run_started_at?: string | null;
						updated_at?: string | null;
					};
					const startedAt = attempt.run_started_at ?? run.run_started_at ?? run.created_at;
					const completedAt = attempt.updated_at ?? null;
					if (validDuration(startedAt, completedAt) !== null) {
						run.run_started_at = startedAt;
						run.effective_completed_at = completedAt;
						run.timing_quality = 'repaired';
					} else {
						run.effective_completed_at = null;
						run.timing_quality = 'excluded';
					}
				} catch {
					run.effective_completed_at = null;
					run.timing_quality = 'excluded';
				} finally {
					completed++;
					onProgress?.(completed, candidates.length);
				}
			}
		})
	);
}
