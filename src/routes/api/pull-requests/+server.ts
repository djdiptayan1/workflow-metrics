import { error, json } from '@sveltejs/kit';
import type { Octokit } from '@octokit/rest';
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

type RestPullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

type PullRequestFilter = 'open' | 'closed' | 'merged';

type PullRequestNode = {
	number: number;
	title: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	mergedAt: string | null;
	isDraft: boolean;
	url: string;
	author: { login: string; avatarUrl: string | null } | null;
	headRefOid: string;
	additions: number;
	deletions: number;
};

type PullRequestConnection = {
	totalCount: number;
	pageInfo: { endCursor: string | null; hasNextPage: boolean };
	nodes: PullRequestNode[];
};

type PullRequestPageResponse = {
	repository: {
		selected: PullRequestConnection;
		open: { totalCount: number };
		closed: { totalCount: number };
		merged: { totalCount: number };
	} | null;
};

const PAGE_SIZES = new Set([20, 50, 100]);
const FILTERS = new Set<PullRequestFilter>(['open', 'closed', 'merged']);

export function _parsePullRequestListParams(url: URL): {
	filter: PullRequestFilter;
	pageSize: number;
	cursor: string | null;
} {
	const filter = url.searchParams.get('state') ?? 'open';
	const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
	const cursor = url.searchParams.get('cursor');

	if (!FILTERS.has(filter as PullRequestFilter))
		throw error(400, 'state must be open, closed, or merged');
	if (!PAGE_SIZES.has(pageSize)) throw error(400, 'pageSize must be 20, 50, or 100');
	if (cursor && cursor.length > 512) throw error(400, 'Invalid pagination cursor');

	return { filter: filter as PullRequestFilter, pageSize, cursor };
}

function toPullRequest(pull: RestPullRequest): PullRequest {
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

function toPullRequestFromNode(pull: PullRequestNode): PullRequest {
	return {
		number: pull.number,
		title: pull.title,
		state: pull.state === 'OPEN' ? 'open' : 'closed',
		mergedAt: pull.mergedAt,
		draft: pull.isDraft,
		url: pull.url,
		author: {
			login: pull.author?.login ?? 'unknown',
			avatarUrl: pull.author?.avatarUrl ?? null
		},
		headSha: pull.headRefOid,
		additions: pull.additions,
		deletions: pull.deletions
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
			const { filter, pageSize, cursor } = _parsePullRequestListParams(url);
			const data = await octokit.graphql<PullRequestPageResponse>(
				`query PullRequestsPage(
					$owner: String!
					$repo: String!
					$state: [PullRequestState!]!
					$pageSize: Int!
					$cursor: String
				) {
					repository(owner: $owner, name: $repo) {
						selected: pullRequests(
							states: $state
							first: $pageSize
							after: $cursor
							orderBy: { field: UPDATED_AT, direction: DESC }
						) {
							totalCount
							pageInfo { endCursor hasNextPage }
							nodes {
								number title state mergedAt isDraft url headRefOid additions deletions
								author { login avatarUrl }
							}
						}
						open: pullRequests(states: OPEN, first: 1) { totalCount }
						closed: pullRequests(states: CLOSED, first: 1) { totalCount }
						merged: pullRequests(states: MERGED, first: 1) { totalCount }
					}
				}`,
				{
					owner,
					repo,
					state: [filter.toUpperCase()],
					pageSize,
					cursor
				}
			);
			if (!data.repository) throw error(404, 'Repository was not found on GitHub.');

			const counts = {
				open: data.repository.open.totalCount,
				closed: data.repository.closed.totalCount,
				merged: data.repository.merged.totalCount
			};
			return json({
				items: data.repository.selected.nodes.map(toPullRequestFromNode),
				counts,
				total: counts.open + counts.closed + counts.merged,
				pageSize,
				nextCursor: data.repository.selected.pageInfo.endCursor,
				hasNextPage: data.repository.selected.pageInfo.hasNextPage
			});
		}

		const number = Number(numberParam);
		if (!Number.isInteger(number) || number < 1) throw error(400, 'Invalid pull request number.');

		const { data: pullData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
		const pullRequest = toPullRequest(pullData);
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
