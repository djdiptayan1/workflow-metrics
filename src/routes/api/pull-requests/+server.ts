import { error, json } from '@sveltejs/kit';
import { createOctokit, isGitHubUnauthorizedError } from '$lib/server/github';
import type { GitHubWorkflowRun } from '$lib/types/github';
import type { RequestHandler } from './$types';

type PullRequest = {
	number: number;
	title: string;
	state: 'open' | 'closed';
	mergedAt: string | null;
	draft: boolean;
	url: string;
	author: { login: string; avatarUrl: string | null };
	headSha: string;
	additions: number | null;
	deletions: number | null;
};

function toPullRequest(pull: Record<string, any>): PullRequest {
	return {
		number: pull.number,
		title: pull.title,
		state: pull.state,
		mergedAt: pull.merged_at ?? null,
		draft: Boolean(pull.draft),
		url: pull.html_url,
		author: { login: pull.user?.login ?? 'unknown', avatarUrl: pull.user?.avatar_url ?? null },
		headSha: pull.head?.sha ?? '',
		additions: typeof pull.additions === 'number' ? pull.additions : null,
		deletions: typeof pull.deletions === 'number' ? pull.deletions : null
	};
}

async function getRequestContext(locals: App.Locals, owner: string, repo: string) {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const [{ data: connection }, { data: repository }] = await Promise.all([
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
			.single()
	]);

	if (!connection) throw error(401, 'GitHub connection not found. Please sign in again.');
	if (!repository) throw error(404, 'Repository is not tracked.');
	return createOctokit(connection.access_token);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	const numberParam = url.searchParams.get('number');
	if (!owner || !repo) throw error(400, 'Missing owner or repository.');

	try {
		const octokit = await getRequestContext(locals, owner, repo);

		if (!numberParam) {
			const { data } = await octokit.rest.pulls.list({
				owner,
				repo,
				state: 'all',
				sort: 'updated',
				direction: 'desc',
				per_page: 100
			});
			return json({ pullRequests: (data as unknown as Record<string, any>[]).map(toPullRequest) });
		}

		const number = Number(numberParam);
		if (!Number.isInteger(number) || number < 1) throw error(400, 'Invalid pull request number.');

		const { data: pullData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
		const pullRequest = toPullRequest(pullData as unknown as Record<string, any>);
		const { data: runsData } = await octokit.rest.actions.listWorkflowRunsForRepo({
			owner,
			repo,
			event: 'pull_request',
			head_sha: pullRequest.headSha,
			per_page: 100
		});

		const latestRuns = new Map<number, GitHubWorkflowRun>();
		for (const run of runsData.workflow_runs as unknown as GitHubWorkflowRun[]) {
			const current = latestRuns.get(run.workflow_id);
			if (!current || new Date(run.updated_at).getTime() > new Date(current.updated_at).getTime()) {
				latestRuns.set(run.workflow_id, run);
			}
		}

		return json({
			pullRequest,
			actions: [...latestRuns.values()].map((run) => ({
				workflowId: run.workflow_id,
				workflowName: run.name ?? 'Unnamed workflow',
				runId: run.id,
				runNumber: run.run_number,
				status: run.status,
				conclusion: run.conclusion,
				updatedAt: run.updated_at
			}))
		});
	} catch (cause) {
		if (isGitHubUnauthorizedError(cause))
			throw error(401, 'GitHub token expired. Please sign in again.');
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		console.error('[api/pull-requests] GitHub request failed:', cause);
		throw error(500, 'Could not load pull requests. Check your GitHub repository access.');
	}
};
