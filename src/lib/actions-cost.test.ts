import { describe, expect, it } from 'vitest';
import {
	ACTIONS_RUNNER_PRICING,
	calculateActionsCostEstimate,
	normalizeGitHubPlan
} from './actions-cost';
import type { JobMinutesShare, WorkflowMinutesShare } from '$lib/types/metrics';

function workflow(
	runnerType: WorkflowMinutesShare['runnerType'],
	minutes: number,
	runnerDetected = true
): WorkflowMinutesShare {
	return {
		workflowName: 'CI',
		minutes,
		billableMinutes: minutes,
		percentage: 100,
		runnerType,
		runnerDetected
	};
}

describe('GitHub Actions cost estimates', () => {
	it('contains the complete standard, larger, ARM, macOS, and GPU price catalog', () => {
		expect(ACTIONS_RUNNER_PRICING).toHaveLength(35);
		expect(ACTIONS_RUNNER_PRICING).toContainEqual(['linux_96_core', 0.252]);
		expect(ACTIONS_RUNNER_PRICING).toContainEqual(['windows_4_core_gpu', 0.102]);
	});
	it('estimates private Enterprise Linux usage without subtracting account-wide allowance', () => {
		const estimate = calculateActionsCostEstimate(
			[workflow('ubuntu', 1_000)],
			'private',
			'enterprise',
			'workflow-runtime'
		);
		expect(estimate.includedMinutes).toBe(50_000);
		expect(estimate.grossCostUsd).toBe(6);
		expect(estimate.chargeAfterAllowanceUsd).toBe(6);
		expect(estimate.lines[0]).toMatchObject({ rateUsd: 0.006, includedEligible: true });
	});

	it('shows standard runners as free for public repositories', () => {
		const estimate = calculateActionsCostEstimate(
			[workflow('ubuntu', 120), workflow('windows', 30)],
			'public',
			'free',
			'workflow-runtime'
		);
		expect(estimate.grossCostUsd).toBeCloseTo(1.02);
		expect(estimate.chargeAfterAllowanceUsd).toBe(0);
	});

	it('keeps self-hosted usage at zero and excludes unknown runners', () => {
		const estimate = calculateActionsCostEstimate(
			[workflow('self-hosted', 90), workflow('unknown', 45, false)],
			'private',
			'team',
			'workflow-runtime'
		);
		expect(estimate.grossCostUsd).toBe(0);
		expect(estimate.unknownMinutes).toBe(45);
		expect(estimate.confidence).toBe('partial');
		expect(estimate.lines.find((line) => line.runnerType === 'unknown')?.subtotalUsd).toBeNull();
	});

	it('uses already per-job-rounded sampled minutes for workflow detail', () => {
		const jobs: JobMinutesShare[] = [
			{
				jobName: 'build',
				minutes: 7,
				billableMinutes: 7,
				percentage: 100,
				runnerType: 'ubuntu',
				runnerDetected: true
			}
		];
		const estimate = calculateActionsCostEstimate(jobs, 'private', 'pro', 'sampled-jobs');
		expect(estimate.grossCostUsd).toBeCloseTo(0.042);
		expect(estimate.basis).toBe('sampled-jobs');
	});

	it('projects sampled job compute across the selected workflow window', () => {
		const estimate = calculateActionsCostEstimate(
			[
				{
					jobName: 'build',
					minutes: 120,
					billableMinutes: 120,
					percentage: 100,
					runnerType: 'ubuntu',
					runnerDetected: true,
					runnerLabel: 'ubuntu-latest'
				}
			],
			'private',
			'enterprise',
			'sampled-jobs',
			{ sampledRuns: 5, projectedRuns: 177 }
		);
		expect(estimate.lines[0]).toMatchObject({ label: 'ubuntu-latest', minutes: 4_248 });
		expect(estimate.grossCostUsd).toBeCloseTo(25.488);
		expect(estimate).toMatchObject({ sampledRuns: 5, projectedRuns: 177 });
	});

	it('keeps the literal custom runner label when its price cannot be classified', () => {
		const estimate = calculateActionsCostEstimate(
			[
				{
					...workflow('unknown', 60, false),
					runnerLabel: 'kalvi-linux-large'
				}
			],
			'private',
			'enterprise',
			'workflow-runtime'
		);
		expect(estimate.lines[0]).toMatchObject({
			label: 'kalvi-linux-large',
			pricingLabel: null,
			subtotalUsd: null
		});
	});

	it.each([
		['enterprise_cloud', 'enterprise'],
		['business', 'team'],
		['pro', 'pro'],
		['free', 'free'],
		['education', 'unknown'],
		[undefined, 'unknown']
	] as const)('normalizes API plan %s to %s', (value, expected) => {
		expect(normalizeGitHubPlan(value)).toBe(expected);
	});
});
