import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

type Environment = 'production' | 'development' | 'unknown';

async function context(locals: App.Locals, owner: string, repo: string) {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const { data: repository } = await locals.supabase
		.from('repositories')
		.select('github_repo_id')
		.eq('user_id', user.id)
		.eq('owner', owner)
		.eq('name', repo)
		.eq('is_active', true)
		.single();

	if (!repository) throw error(404, 'Repository not found');
	return { user, githubRepoId: repository.github_repo_id };
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!owner || !repo) throw error(400, 'owner and repo are required');

	const { user, githubRepoId } = await context(locals, owner, repo);
	const { data: preferences, error: dbError } = await locals.supabase
		.from('workflow_preferences')
		.select('workflow_id,is_pinned,environment')
		.eq('github_repo_id', githubRepoId)
		.eq('user_id', user.id);

	if (dbError) throw error(500, 'Failed to load workflow preferences');
	return json({ mode: 'personal' as const, preferences: preferences ?? [] });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as {
		owner?: string;
		repo?: string;
		workflowId?: number;
		isPinned?: boolean;
		environment?: Environment;
	} | null;

	if (!body?.owner || !body.repo) throw error(400, 'owner and repo are required');
	if (
		typeof body.workflowId !== 'number' ||
		!Number.isSafeInteger(body.workflowId) ||
		body.workflowId <= 0 ||
		typeof body.isPinned !== 'boolean' ||
		!body.environment ||
		!['production', 'development', 'unknown'].includes(body.environment)
	) {
		throw error(400, 'Invalid workflow preference');
	}

	const { user, githubRepoId } = await context(locals, body.owner, body.repo);
	const { error: dbError } = await locals.supabase.from('workflow_preferences').upsert(
		{
			github_repo_id: githubRepoId,
			user_id: user.id,
			workflow_id: body.workflowId,
			is_pinned: body.isPinned,
			environment: body.environment,
			updated_by: user.id
		},
		{ onConflict: 'github_repo_id,user_id,workflow_id' }
	);

	if (dbError) throw error(500, 'Failed to update workflow preference');
	return json({ mode: 'personal' as const });
};
