import { error, json } from '@sveltejs/kit';
import { fetchAvailableModels, type AIProvider } from '$lib/server/mistral';
import { getAiApiKey } from '$lib/server/secrets';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { provider?: string; apiKey?: string };
	const provider: AIProvider =
		body.provider === 'gemini' || body.provider === 'mistral' ? body.provider : 'openai';
	let apiKey = body.apiKey?.trim();

	if (!apiKey) apiKey = (await getAiApiKey(user.id)) ?? undefined;

	if (!apiKey) throw error(400, 'Enter an API key first.');

	try {
		return json({ models: await fetchAvailableModels(provider, apiKey) });
	} catch (cause) {
		console.error('[api/ai/models] Could not load models', cause);
		throw error(400, 'Could not load models.');
	}
};
