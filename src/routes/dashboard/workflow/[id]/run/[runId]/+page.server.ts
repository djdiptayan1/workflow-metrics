import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	createOctokit,
	fetchJobFailureExcerpt,
	fetchJobsForRun,
	isGitHubUnauthorizedError
} from '$lib/server/github';
import { MAX_WORKFLOW_DURATION_MS } from '$lib/server/run-timing';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw redirect(303, '/auth/login');
	const runId = Number(params.runId);
	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!Number.isSafeInteger(runId) || !owner || !repo) throw error(400, 'Invalid workflow run');
	const [{ data: connection }, { data: tracked }, { data: settings }] = await Promise.all([
		locals.supabase
			.from('github_connections')
			.select('access_token')
			.eq('user_id', user.id)
			.single(),
		locals.supabase
			.from('repositories')
			.select('id')
			.eq('user_id', user.id)
			.eq('owner', owner)
			.eq('name', repo)
			.maybeSingle(),
		locals.supabase.from('user_settings').select('ai_api_key').eq('user_id', user.id).single()
	]);
	if (!connection || !tracked) throw error(403, 'Repository not found or access denied');
	const hasAiKey = !!settings?.ai_api_key;

	const octokit = createOctokit(connection.access_token);
	try {
		const { data: run } = await octokit.rest.actions.getWorkflowRun({
			owner,
			repo,
			run_id: runId
		});
		const jobs = await fetchJobsForRun(octokit, owner, repo, runId);
		let durationMs: number | null = null;
		try {
			const { data: attempt } = await octokit.request(
				'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
				{
					owner,
					repo,
					run_id: runId,
					attempt_number: run.run_attempt ?? 1
				}
			);
			const started = Date.parse(attempt.run_started_at ?? '');
			const completed = Date.parse(attempt.updated_at ?? '');
			if (
				Number.isFinite(started) &&
				Number.isFinite(completed) &&
				completed >= started &&
				completed - started <= MAX_WORKFLOW_DURATION_MS
			) {
				durationMs = completed - started;
			}
		} catch {
			// Fall back to the observed job bounds below.
		}
		if (durationMs === null) {
			const starts = jobs.map((job) => Date.parse(job.started_at ?? '')).filter(Number.isFinite);
			const completions = jobs
				.map((job) => Date.parse(job.completed_at ?? ''))
				.filter(Number.isFinite);
			if (starts.length > 0 && completions.length > 0) {
				const started = Math.min(...starts);
				const completed = Math.max(...completions);
				if (completed >= started) durationMs = completed - started;
			}
		}
		const failedJob = jobs.find((job) => job.conclusion === 'failure') ?? null;
		const failureExcerpt = failedJob
			? await fetchJobFailureExcerpt(connection.access_token, owner, repo, failedJob.id).catch(
					() => null
				)
			: null;
		return { owner, repo, run, jobs, durationMs, failureExcerpt, workflowId: params.id, hasAiKey };
	} catch (cause) {
		if (isGitHubUnauthorizedError(cause))
			throw redirect(
				303,
				'/auth/login?error=' + encodeURIComponent('GitHub token expired. Please sign in again.')
			);
		throw error(404, 'This run could not be found. It may have been deleted from GitHub.');
	}
};
