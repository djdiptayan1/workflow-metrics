import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { createSupabaseAdminClient } from '$lib/server/supabase';

const CIPHER = 'aes-256-gcm';
const VERSION = 'v1';

type SecretCiphertexts = {
	github_access_token_ciphertext: string | null;
	ai_api_key_ciphertext: string | null;
	encryption_version: number;
};

function encryptionKey(): Buffer {
	const encoded = env.SECRETS_ENCRYPTION_KEY;
	if (!encoded) throw new Error('SECRETS_ENCRYPTION_KEY is required for credential operations.');

	let key: Buffer;
	try {
		key = Buffer.from(encoded, 'base64url');
	} catch {
		throw new Error('SECRETS_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
	}
	if (key.length !== 32)
		throw new Error('SECRETS_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
	return key;
}

function encrypt(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

function decrypt(payload: string): string {
	const [version, ivEncoded, ciphertextEncoded, tagEncoded, ...extra] = payload.split('.');
	if (version !== VERSION || !ivEncoded || !ciphertextEncoded || !tagEncoded || extra.length > 0)
		throw new Error('Stored credential has an invalid encryption format.');

	try {
		const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(ivEncoded, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new Error('Stored credential could not be decrypted.');
	}
}

function adminClient() {
	const admin = createSupabaseAdminClient();
	if (!admin) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for credential operations.');
	return admin;
}

async function getCiphertexts(userId: string): Promise<SecretCiphertexts | null> {
	const { data, error } = await adminClient().rpc('get_user_secret_ciphertexts', {
		p_user_id: userId
	});
	if (error) throw new Error('Unable to retrieve stored credentials.');
	return data?.[0] ?? null;
}

async function upsertCiphertexts(
	userId: string,
	ciphertexts: { githubAccessToken?: string; aiApiKey?: string }
): Promise<void> {
	const { error } = await adminClient().rpc('upsert_user_secret_ciphertexts', {
		p_user_id: userId,
		p_github_access_token_ciphertext: ciphertexts.githubAccessToken,
		p_ai_api_key_ciphertext: ciphertexts.aiApiKey
	});
	if (error) throw new Error('Unable to store credential securely.');
}

export async function storeGitHubAccessToken(userId: string, accessToken: string): Promise<void> {
	await upsertCiphertexts(userId, { githubAccessToken: encrypt(accessToken) });
}

export async function getGitHubAccessToken(userId: string): Promise<string | null> {
	const ciphertexts = await getCiphertexts(userId);
	return ciphertexts?.github_access_token_ciphertext
		? decrypt(ciphertexts.github_access_token_ciphertext)
		: null;
}

export async function storeAiApiKey(userId: string, apiKey: string): Promise<void> {
	await upsertCiphertexts(userId, { aiApiKey: encrypt(apiKey) });
}

export async function getAiApiKey(userId: string): Promise<string | null> {
	const ciphertexts = await getCiphertexts(userId);
	return ciphertexts?.ai_api_key_ciphertext ? decrypt(ciphertexts.ai_api_key_ciphertext) : null;
}

export async function hasAiApiKey(userId: string): Promise<boolean> {
	return (await getAiApiKey(userId)) !== null;
}

export async function clearAiApiKey(userId: string): Promise<void> {
	const { error } = await adminClient().rpc('clear_user_ai_api_key_ciphertext', {
		p_user_id: userId
	});
	if (error) throw new Error('Unable to remove stored credential.');
}

export const secretCrypto = { decrypt, encrypt };
