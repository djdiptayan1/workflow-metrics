import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createOctokit, fetchJobLog, fetchJobsForRun } from '$lib/server/github';

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
	const { data: connection } = await locals.supabase
		.from('github_connections')
		.select('access_token')
		.eq('user_id', user.id)
		.single();
	const { data: tracked } = await locals.supabase
		.from('repositories')
		.select('id')
		.eq('user_id', user.id)
		.eq('owner', body.owner)
		.eq('name', body.repo)
		.maybeSingle();
	if (!connection || !tracked) throw error(403, 'Repository not found or access denied');
	const jobs = await fetchJobsForRun(
		createOctokit(connection.access_token),
		body.owner,
		body.repo,
		body.runId!
	);
	const failedJob = jobs.find((job) => job.conclusion === 'failure');
	if (!failedJob) throw error(404, 'No failed job found for this run');
	const log = await fetchJobLog(connection.access_token, body.owner, body.repo, failedJob.id);
	if (!log) throw error(502, 'GitHub did not return a job log');
	return json({ jobName: failedJob.name, log });
};
