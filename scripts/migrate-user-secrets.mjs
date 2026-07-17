import { createCipheriv, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// This script is intentionally not imported by the application. Run it after migration 021
// and before migration 022 when moving an existing deployment off plaintext credential columns.
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SECRETS_ENCRYPTION_KEY'];
for (const name of required) {
	if (!process.env[name]) throw new Error(`${name} is required.`);
}

const key = Buffer.from(process.env.SECRETS_ENCRYPTION_KEY, 'base64url');
if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');

function encrypt(plaintext) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [
		'v1',
		iv.toString('base64url'),
		ciphertext.toString('base64url'),
		cipher.getAuthTag().toString('base64url')
	].join('.');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false }
});
const dryRun = process.argv.includes('--dry-run');

const [{ data: connections, error: connectionsError }, { data: settings, error: settingsError }] =
	await Promise.all([
		supabase.from('github_connections').select('user_id, access_token'),
		supabase.from('user_settings').select('user_id, ai_api_key')
	]);

if (connectionsError || settingsError)
	throw new Error('Unable to read existing credential rows. Ensure migration 021 is applied first.');

const githubTokens = new Map(
	(connections ?? [])
		.filter((row) => typeof row.access_token === 'string' && row.access_token.length > 0)
		.map((row) => [row.user_id, row.access_token])
);
const aiKeys = new Map(
	(settings ?? [])
		.filter((row) => typeof row.ai_api_key === 'string' && row.ai_api_key.length > 0)
		.map((row) => [row.user_id, row.ai_api_key])
);
const userIds = new Set([...githubTokens.keys(), ...aiKeys.keys()]);

if (!dryRun) {
	for (const userId of userIds) {
		const { error } = await supabase.rpc('upsert_user_secret_ciphertexts', {
			p_user_id: userId,
			p_github_access_token_ciphertext: githubTokens.has(userId)
				? encrypt(githubTokens.get(userId))
				: null,
			p_ai_api_key_ciphertext: aiKeys.has(userId) ? encrypt(aiKeys.get(userId)) : null
		});
		if (error) throw new Error('Unable to write encrypted credential rows.');
	}
}

console.log(
	JSON.stringify({
		dryRun,
		usersWithCredentials: userIds.size,
		githubTokens: githubTokens.size,
		aiApiKeys: aiKeys.size
	})
);
