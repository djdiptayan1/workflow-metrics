const MINIMUM_COMPRESSION_BYTES = 1024;

function acceptsGzip(header: string | null) {
	let wildcardQuality: number | null = null;
	for (const entry of (header ?? '').split(',')) {
		const [encoding, ...parameters] = entry.trim().toLowerCase().split(';');
		const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
		const value = quality ? Number(quality.split('=')[1]) : 1;
		if (encoding === 'gzip') return value > 0;
		if (encoding === '*') wildcardQuality = value;
	}
	return wildcardQuality !== null && wildcardQuality > 0;
}

function isCompressible(contentType: string | null) {
	return /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i.test(
		contentType ?? ''
	);
}

export function compressResponse(request: Request, response: Response) {
	const contentLengthHeader = response.headers.get('content-length');
	const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
	const contentType = response.headers.get('content-type') ?? '';
	if (
		request.method === 'HEAD' ||
		!response.body ||
		response.status === 204 ||
		response.status === 304 ||
		!acceptsGzip(request.headers.get('accept-encoding')) ||
		!isCompressible(contentType) ||
		response.headers.has('content-encoding') ||
		response.headers.has('content-range') ||
		response.headers.get('cache-control')?.toLowerCase().includes('no-transform') ||
		contentType.toLowerCase().startsWith('text/event-stream') ||
		(contentLength !== null &&
			Number.isFinite(contentLength) &&
			contentLength < MINIMUM_COMPRESSION_BYTES)
	) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set('content-encoding', 'gzip');
	headers.delete('content-length');
	const vary = new Set(
		(headers.get('vary') ?? '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean)
	);
	vary.add('Origin');
	vary.add('Accept-Encoding');
	headers.set('vary', [...vary].join(', '));

	return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
