import { json } from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		await (await getRedisClient()).ping();
		return json({ status: 'ok' });
	} catch {
		return json({ status: 'unavailable' }, { status: 503 });
	}
};
