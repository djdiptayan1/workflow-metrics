import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	createOctokit,
	fetchJobFailureExcerpt,
	fetchJobsForRun,
	isGitHubUnauthorizedError
} from '$lib/server/github';

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
		const failedJob = jobs.find((job) => job.conclusion === 'failure') ?? null;
		const failureExcerpt = failedJob
			? await fetchJobFailureExcerpt(connection.access_token, owner, repo, failedJob.id).catch(
					() => null
				)
			: null;
		return { owner, repo, run, jobs, failureExcerpt, workflowId: params.id, hasAiKey };
	} catch (cause) {
		if (isGitHubUnauthorizedError(cause))
			throw redirect(303, '/auth/login?error=' + encodeURIComponent('GitHub token expired. Please sign in again.'));
		throw error(404, 'This run could not be found. It may have been deleted from GitHub.');
	}
};
