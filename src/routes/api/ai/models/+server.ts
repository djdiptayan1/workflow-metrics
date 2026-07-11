import { error, json } from '@sveltejs/kit';
import { fetchAvailableModels, type AIProvider } from '$lib/server/mistral';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { provider?: string; apiKey?: string };
	const provider: AIProvider =
		body.provider === 'gemini' || body.provider === 'mistral' ? body.provider : 'openai';
	let apiKey = body.apiKey?.trim();

	if (!apiKey) {
		const { data } = await locals.supabase
			.from('user_settings')
			.select('ai_api_key')
			.eq('user_id', user.id)
			.single();
		apiKey = data?.ai_api_key ?? undefined;
	}

	if (!apiKey) throw error(400, 'Enter an API key first.');

	try {
		return json({ models: await fetchAvailableModels(provider, apiKey) });
	} catch (e) {
		throw error(400, e instanceof Error ? e.message : 'Could not load models.');
	}
};
