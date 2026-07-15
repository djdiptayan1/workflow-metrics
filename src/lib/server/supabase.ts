import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';
import type { Database } from '$lib/types/database';

const supabaseServerUrl = env.SUPABASE_INTERNAL_URL || publicEnv.PUBLIC_SUPABASE_URL;

/** Admin client for explicit privileged server operations. Returns null if the service key is absent. */
export function createSupabaseAdminClient() {
	const key = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!key) return null;
	return createClient<Database>(supabaseServerUrl, key, {
		auth: { persistSession: false }
	});
}

export function createSupabaseServerClient(event: RequestEvent) {
	return createServerClient(supabaseServerUrl, publicEnv.PUBLIC_SUPABASE_ANON_KEY, {
		cookies: {
			getAll() {
				return event.cookies.getAll();
			},
			setAll(
				cookiesToSet: Array<{
					name: string;
					value: string;
					options?: Parameters<typeof event.cookies.set>[2];
				}>
			) {
				cookiesToSet.forEach(({ name, value, options }) =>
					event.cookies.set(name, value, { ...options, path: '/' })
				);
			}
		}
	});
}
