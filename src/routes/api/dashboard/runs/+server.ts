import { error, json } from '@sveltejs/kit';
import { getPaginatedRuns, type ActionsLookback } from '$lib/server/workflow-runs-cache';
import type { RequestHandler } from './$types';

const PAGE_SIZES = new Set([20, 50, 100]);

function lookback(value: string | null): ActionsLookback {
	if (value === '7' || value === '30' || value === '90' || value === 'all') return value;
	throw error(400, 'days must be one of 7, 30, 90, or all');
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');
	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	if (!owner || !repo) throw error(400, 'Missing owner or repo');

	const page = Number(url.searchParams.get('page') ?? '1');
	const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
	const workflowIdParam = url.searchParams.get('workflowId');
	const workflowId = workflowIdParam === null ? undefined : Number(workflowIdParam);
	if (!Number.isSafeInteger(page) || page < 1) throw error(400, 'page must be a positive integer');
	if (!PAGE_SIZES.has(pageSize)) throw error(400, 'pageSize must be 20, 50, or 100');
	if (workflowId !== undefined && (!Number.isSafeInteger(workflowId) || workflowId < 1))
		throw error(400, 'workflowId must be a positive integer');

	const { data: tracked } = await locals.supabase
		.from('repositories')
		.select('id')
		.eq('user_id', user.id)
		.eq('owner', owner)
		.eq('name', repo)
		.maybeSingle();
	if (!tracked) throw error(403, 'Repository not found or access denied');

	try {
		return json(
			await getPaginatedRuns(
				user.id,
				owner,
				repo,
				lookback(url.searchParams.get('days')),
				page,
				pageSize,
				workflowId
			)
		);
	} catch (cause) {
		console.error('[api/dashboard/runs] Redis read failed', cause);
		return json(
			{ message: 'Workflow data cache is temporarily unavailable. Please retry.', retryable: true },
			{ status: 503, headers: { 'Retry-After': '3' } }
		);
	}
};
