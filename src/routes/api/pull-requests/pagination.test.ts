import { describe, expect, it } from 'vitest';
import { _parsePullRequestListParams } from './+server';

describe('parsePullRequestListParams', () => {
	it('uses a bounded first page by default', () => {
		expect(_parsePullRequestListParams(new URL('http://localhost/api/pull-requests'))).toEqual({
			filter: 'open',
			pageSize: 20,
			cursor: null
		});
	});

	it('accepts supported state, size, and cursor values', () => {
		const url = new URL(
			'http://localhost/api/pull-requests?state=merged&pageSize=100&cursor=cursor-2'
		);
		expect(_parsePullRequestListParams(url)).toEqual({
			filter: 'merged',
			pageSize: 100,
			cursor: 'cursor-2'
		});
	});

	it.each([
		['state=draft', 400],
		['pageSize=25', 400],
		[`cursor=${'x'.repeat(513)}`, 400]
	])('rejects invalid pagination input: %s', (query, status) => {
		expect(() =>
			_parsePullRequestListParams(new URL(`http://localhost/api/pull-requests?${query}`))
		).toThrow(expect.objectContaining({ status }));
	});
});
