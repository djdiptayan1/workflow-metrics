import { error, json } from '@sveltejs/kit';
import { generateText } from 'ai';
import type { RequestHandler } from './$types';
import { createAIModel, type AIProvider } from '$lib/server/mistral';
import { createOctokit, fetchJobFailureExcerpt, fetchJobsForRun } from '$lib/server/github';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');
	const body = (await request.json().catch(() => null)) as {
		owner?: string;
		repo?: string;
		runId?: number;
	} | null;
	if (!body?.owner || !body.repo || !Number.isSafeInteger(body.runId))
		throw error(400, 'Invalid run request');
	const [connectionResult, settingsResult, trackedResult] = await Promise.all([
		locals.supabase
			.from('github_connections')
			.select('access_token')
			.eq('user_id', user.id)
			.single(),
		locals.supabase
			.from('user_settings')
			.select('ai_provider,ai_api_key,ai_model')
			.eq('user_id', user.id)
			.single(),
		locals.supabase
			.from('repositories')
			.select('id')
			.eq('user_id', user.id)
			.eq('owner', body.owner)
			.eq('name', body.repo)
			.maybeSingle()
	]);
	if (!connectionResult.data || !trackedResult.data)
		throw error(403, 'Repository not found or access denied');
	if (!settingsResult.data?.ai_api_key)
		throw error(400, 'AI API key not configured. Add it in Settings.');
	const octokit = createOctokit(connectionResult.data.access_token);
	const [runResult, jobs] = await Promise.all([
		octokit.rest.actions.getWorkflowRun({
			owner: body.owner,
			repo: body.repo,
			run_id: body.runId!
		}),
		fetchJobsForRun(octokit, body.owner, body.repo, body.runId!)
	]);
	const failedJob = jobs.find((job) => job.conclusion === 'failure');
	if (!failedJob) throw error(404, 'No failed job found for this run');
	const [excerpt, commitResult, pullRequestsResult] = await Promise.all([
		fetchJobFailureExcerpt(connectionResult.data.access_token, body.owner, body.repo, failedJob.id),
		octokit.rest.repos
			.getCommit({ owner: body.owner, repo: body.repo, ref: runResult.data.head_sha })
			.catch(() => null),
		octokit.rest.repos
			.listPullRequestsAssociatedWithCommit({
				owner: body.owner,
				repo: body.repo,
				commit_sha: runResult.data.head_sha
			})
			.catch(() => null)
	]);
	const commit = commitResult?.data;
	const pullRequest = pullRequestsResult?.data[0];
	const { text } = await generateText({
		model: createAIModel(
			(settingsResult.data.ai_provider ?? 'openai') as AIProvider,
			settingsResult.data.ai_api_key,
			settingsResult.data.ai_model
		),
		system:
			'You are a senior GitHub Actions incident analyst. Explain only evidence supported by the supplied metadata and log. Separate confirmed cause from hypotheses. Give concise remediation steps.',
		prompt: `Analyze this failed GitHub Actions run.\nRun: ${runResult.data.name ?? 'workflow'} #${runResult.data.run_number}\nFailed job: ${failedJob.name}\nFailed steps: ${
			failedJob.steps
				.filter((step) => step.conclusion === 'failure')
				.map((step) => step.name)
				.join(', ') || 'not reported'
		}\nCommit: ${runResult.data.head_sha}\nCommit author: ${commit?.author?.login ?? commit?.commit.author?.name ?? 'unknown'}\nCommit message: ${commit?.commit.message ?? 'unknown'}\nAssociated PR: ${pullRequest ? `#${pullRequest.number} ${pullRequest.title} by ${pullRequest.user?.login ?? 'unknown'}` : 'none found'}\n\nLog excerpt:\n${excerpt ?? 'No readable log excerpt'}\n\nReturn: 1) what failed, 2) likely cause and confidence, 3) commit/PR attribution, 4) exact next steps.`,
		maxOutputTokens: 1200
	});
	return json({
		analysis: text,
		commit: {
			sha: runResult.data.head_sha,
			author: commit?.author?.login ?? commit?.commit.author?.name ?? null,
			message: commit?.commit.message ?? null
		},
		pullRequest: pullRequest
			? {
					number: pullRequest.number,
					title: pullRequest.title,
					author: pullRequest.user?.login ?? null
				}
			: null
	});
};
