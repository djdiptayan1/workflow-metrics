import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createOctokit } from '$lib/server/github';
import { createSupabaseAdminClient } from '$lib/server/supabase';

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
		.single();
	if (!repository) throw error(404, 'Repository not found');
	return { user, githubRepoId: repository.github_repo_id };
}

async function requireAdmin(locals: App.Locals, userId: string, owner: string, repo: string) {
	const { data: connection } = await locals.supabase
		.from('github_connections')
		.select('access_token')
		.eq('user_id', userId)
		.single();
	if (!connection) throw error(401, 'GitHub connection not found');
	const { data } = await createOctokit(connection.access_token).rest.repos.get({ owner, repo });
	if (!data.permissions?.admin)
		throw error(403, 'Only GitHub repository admins can change shared workflow preferences');
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!owner || !repo) {
		const { user } = await locals.safeGetSession();
		if (!user) throw error(401, 'Unauthorized');
		const { data: repositories } = await locals.supabase
			.from('repositories')
			.select('id,github_repo_id')
			.eq('user_id', user.id)
			.eq('is_active', true);
		const repoIds = repositories?.map((repository) => repository.github_repo_id) ?? [];
		if (repoIds.length === 0) return json({ modes: {} });
		const { data: settings } = await locals.supabase
			.from('repository_workflow_settings')
			.select('github_repo_id,preferences_mode')
			.in('github_repo_id', repoIds);
		const modeByGitHubRepoId = new Map(
			(settings ?? []).map((setting) => [setting.github_repo_id, setting.preferences_mode])
		);
		return json({
			modes: Object.fromEntries(
				(repositories ?? []).map((repository) => [
					repository.id,
					modeByGitHubRepoId.get(repository.github_repo_id) ?? 'personal'
				])
			)
		});
	}
	const { user, githubRepoId } = await context(locals, owner, repo);
	const { data: settings } = await locals.supabase
		.from('repository_workflow_settings')
		.select('preferences_mode')
		.eq('github_repo_id', githubRepoId)
		.maybeSingle();
	const mode = settings?.preferences_mode ?? 'personal';
	const preferencesQuery = locals.supabase
		.from('workflow_preferences')
		.select('workflow_id,is_pinned,environment')
		.eq('github_repo_id', githubRepoId);
	const { data: preferences } = await (mode === 'shared'
		? preferencesQuery.is('user_id', null)
		: preferencesQuery.eq('user_id', user.id));
	return json({ mode, preferences: preferences ?? [] });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as {
		owner?: string;
		repo?: string;
		mode?: 'personal' | 'shared';
		workflowId?: number;
		isPinned?: boolean;
		environment?: Environment;
	} | null;
	if (!body?.owner || !body.repo) throw error(400, 'owner and repo are required');
	const { user, githubRepoId } = await context(locals, body.owner, body.repo);
	if (body.mode) {
		if (body.mode !== 'personal' && body.mode !== 'shared')
			throw error(400, 'Invalid preferences mode');
		await requireAdmin(locals, user.id, body.owner, body.repo);
		// RLS-scoped write: any user tracking the repo may write here, admin-ness was just verified above.
		const { error: dbError } = await locals.supabase
			.from('repository_workflow_settings')
			.upsert(
				{ github_repo_id: githubRepoId, preferences_mode: body.mode, updated_by: user.id },
				{ onConflict: 'github_repo_id' }
			);
		if (dbError) throw error(500, 'Failed to update workflow preference mode');
		return json({ mode: body.mode });
	}
	const { workflowId, isPinned, environment } = body;
	if (
		typeof workflowId !== 'number' ||
		!Number.isSafeInteger(workflowId) ||
		workflowId <= 0 ||
		typeof isPinned !== 'boolean' ||
		!environment
	)
		throw error(400, 'Invalid workflow preference');
	const { data: setting } = await locals.supabase
		.from('repository_workflow_settings')
		.select('preferences_mode')
		.eq('github_repo_id', githubRepoId)
		.maybeSingle();
	const mode = setting?.preferences_mode ?? 'personal';
	if (mode === 'shared') {
		// Shared rows have user_id = null, which no per-user RLS policy can authorize — needs the admin client.
		await requireAdmin(locals, user.id, body.owner, body.repo);
		const admin = createSupabaseAdminClient();
		if (!admin) throw error(503, 'Shared workflow preferences require SUPABASE_SERVICE_ROLE_KEY');
		const { error: dbError } = await admin.from('workflow_preferences').upsert(
			{
				github_repo_id: githubRepoId,
				user_id: null,
				workflow_id: workflowId,
				is_pinned: isPinned,
				environment,
				updated_by: user.id
			},
			{ onConflict: 'github_repo_id,user_id,workflow_id' }
		);
		if (dbError) throw error(500, 'Failed to update workflow preference');
		return json({ mode });
	}
	// Personal mode: RLS-scoped write against the user's own row.
	const { error: dbError } = await locals.supabase.from('workflow_preferences').upsert(
		{
			github_repo_id: githubRepoId,
			user_id: user.id,
			workflow_id: workflowId,
			is_pinned: isPinned,
			environment,
			updated_by: user.id
		},
		{ onConflict: 'github_repo_id,user_id,workflow_id' }
	);
	if (dbError) throw error(500, 'Failed to update workflow preference');
	return json({ mode });
};
