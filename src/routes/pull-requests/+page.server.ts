import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw redirect(303, '/auth/login');

	const { data: repos } = await locals.supabase
		.from('repositories')
		.select('id, owner, name, full_name, is_private')
		.eq('user_id', user.id)
		.eq('is_active', true)
		.order('full_name');
	if (!repos?.length) throw redirect(303, '/onboarding');

	const owner = url.searchParams.get('owner');
	const repo = url.searchParams.get('repo');
	const selectedRepo = repos.find((item) => item.owner === owner && item.name === repo) ?? repos[0];
	return { repos, selectedRepo };
};
