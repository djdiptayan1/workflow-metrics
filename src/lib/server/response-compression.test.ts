import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compressResponse } from './response-compression';

function request(acceptEncoding = 'gzip') {
	return new Request('http://localhost/api/test', {
		headers: { 'Accept-Encoding': acceptEncoding }
	});
}

describe('compressResponse', () => {
	it('streams large JSON responses as gzip and preserves Vary', async () => {
		const body = JSON.stringify({
			runs: Array.from({ length: 500 }, (_, index) => ({ id: index }))
		});
		const response = new Response(body, {
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': String(Buffer.byteLength(body)),
				Vary: 'Origin'
			}
		});

		const compressed = compressResponse(request(), response);

		expect(compressed.headers.get('content-encoding')).toBe('gzip');
		expect(compressed.headers.get('content-length')).toBeNull();
		expect(compressed.headers.get('vary')).toBe('Origin, Accept-Encoding');
		expect(gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString()).toBe(body);
	});

	it('leaves small, event-stream, and rejected gzip responses unchanged', () => {
		const small = new Response('{}', {
			headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }
		});
		const eventStream = new Response('data: ready\n\n', {
			headers: { 'Content-Type': 'text/event-stream' }
		});
		const rejected = new Response('x'.repeat(2048), {
			headers: { 'Content-Type': 'text/plain', 'Content-Length': '2048' }
		});
		const explicitlyRejected = new Response('x'.repeat(2048), {
			headers: { 'Content-Type': 'text/plain', 'Content-Length': '2048' }
		});

		expect(compressResponse(request(), small)).toBe(small);
		expect(compressResponse(request(), eventStream)).toBe(eventStream);
		expect(compressResponse(request('gzip;q=0, identity'), rejected)).toBe(rejected);
		expect(compressResponse(request('*;q=1, gzip;q=0'), explicitlyRejected)).toBe(
			explicitlyRejected
		);
	});
});
