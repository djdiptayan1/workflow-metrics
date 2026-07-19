import type { Octokit } from '@octokit/rest';
import { normalizeGitHubPlan } from '$lib/actions-cost';
import type { GitHubPlan } from '$lib/types/metrics';

export async function getGitHubOwnerPlan(octokit: Octokit, owner: string): Promise<GitHubPlan> {
	try {
		const { data } = await octokit.rest.orgs.get({ org: owner });
		return normalizeGitHubPlan((data as { plan?: { name?: string } }).plan?.name);
	} catch {
		try {
			const { data } = await octokit.rest.users.getAuthenticated();
			if (data.login.toLowerCase() !== owner.toLowerCase()) return 'unknown';
			return normalizeGitHubPlan((data as { plan?: { name?: string } }).plan?.name);
		} catch {
			return 'unknown';
		}
	}
}
