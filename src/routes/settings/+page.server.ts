import { redirect, fail } from '@sveltejs/kit';
import { clearAiApiKey, hasAiApiKey, storeAiApiKey } from '$lib/server/secrets';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw redirect(303, '/auth/login');

	const [connectionsResult, settingsResult, reposResult, aiApiKeyConfigured] = await Promise.all([
		locals.supabase
			.from('github_connections')
			.select('id, github_username, avatar_url, scopes, created_at')
			.eq('user_id', user.id),
		locals.supabase
			.from('user_settings')
			.select(
				'ai_provider, ai_model, theme, default_repo_id, actions_lookback, dashboard_refresh_interval'
			)
			.eq('user_id', user.id)
			.single(),
		locals.supabase
			.from('repositories')
			.select('id, full_name, owner, name, is_private, is_active')
			.eq('user_id', user.id)
			.order('full_name'),
		hasAiApiKey(user.id)
	]);

	const repos = reposResult.data ?? [];

	return {
		connections: connectionsResult.data ?? [],
		settings: settingsResult.data,
		aiApiKeyConfigured,
		repos
	};
};

export const actions: Actions = {
	updateSettings: async ({ request, locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) return fail(401, { error: 'Unauthorized' });

		const formData = await request.formData();
		const aiApiKey = String(formData.get('ai_api_key') ?? '').trim();
		const removeAiApiKey = formData.get('remove_ai_api_key') === 'true';
		const requestedProvider = formData.get('ai_provider');
		const aiProvider =
			requestedProvider === 'gemini' || requestedProvider === 'mistral'
				? requestedProvider
				: 'openai';
		const aiModel =
			String(formData.get('ai_model') ?? '')
				.trim()
				.slice(0, 200) || null;
		const theme = formData.get('theme') as 'dark' | 'light' | 'system';
		const defaultRepoId = formData.get('default_repo_id') as string | null;
		const requestedLookback = formData.get('actions_lookback');
		const actionsLookback = ['7', '30', '90', 'all'].includes(String(requestedLookback))
			? (requestedLookback as '7' | '30' | '90' | 'all')
			: '30';
		const requestedRefreshInterval = formData.get('dashboard_refresh_interval');
		const dashboardRefreshInterval = ['realtime', '5', '10', '15'].includes(
			String(requestedRefreshInterval)
		)
			? (requestedRefreshInterval as 'realtime' | '5' | '10' | '15')
			: '5';

		const { error } = await locals.supabase.from('user_settings').upsert(
			{
				user_id: user.id,
				ai_provider: aiProvider,
				ai_model: aiModel,
				theme: theme || 'dark',
				default_repo_id: defaultRepoId || null,
				actions_lookback: actionsLookback,
				dashboard_refresh_interval: dashboardRefreshInterval,
				updated_at: new Date().toISOString()
			},
			{ onConflict: 'user_id' }
		);

		if (error) return fail(500, { error: error.message });

		try {
			if (removeAiApiKey) {
				await clearAiApiKey(user.id);
			} else if (aiApiKey) {
				await storeAiApiKey(user.id, aiApiKey);
			}
		} catch (error) {
			return fail(500, {
				error: error instanceof Error ? error.message : 'Unable to update the AI API key.'
			});
		}

		return { success: true, default_repo_id: defaultRepoId || null };
	},

	removeRepo: async ({ request, locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) return fail(401, { error: 'Unauthorized' });

		const formData = await request.formData();
		const repoId = formData.get('repo_id') as string;

		const { error } = await locals.supabase
			.from('repositories')
			.update({ is_active: false })
			.eq('id', repoId)
			.eq('user_id', user.id);

		if (error) return fail(500, { error: error.message });

		return { success: true };
	},

	addRepo: async ({ locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) return fail(401, { error: 'Unauthorized' });

		throw redirect(303, '/onboarding?from=settings');
	},

	addOrg: async ({ locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) return fail(401, { error: 'Unauthorized' });

		throw redirect(303, '/onboarding?add=org&from=settings');
	}
};
