import { createClient, type RedisClientType } from 'redis';
import { env } from '$env/dynamic/private';

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
	if (client?.isReady) return client;
	if (connecting) return connecting;
	const url = env.REDIS_URL;
	if (!url) throw new Error('REDIS_URL is required');

	const next = createClient({
		url,
		disableOfflineQueue: true,
		socket: {
			connectTimeout: 3_000,
			reconnectStrategy: (retries) => (retries >= 3 ? false : Math.min(200 * 2 ** retries, 1_000))
		}
	});
	next.on('error', (error) => console.error('[redis]', error));
	connecting = next
		.connect()
		.then(() => {
			client = next as RedisClientType;
			return client;
		})
		.finally(() => {
			connecting = null;
		});
	return connecting;
}

export async function closeRedisClient(): Promise<void> {
	if (client?.isOpen) await client.close();
	client = null;
}
