import type {
	ActionsCostEstimate,
	ActionsCostLine,
	GitHubPlan,
	JobMinutesShare,
	RunnerType,
	WorkflowMinutesShare
} from '$lib/types/metrics';

export const ACTIONS_PRICING_URL =
	'https://docs.github.com/en/billing/reference/actions-runner-pricing';
export const ACTIONS_INCLUDED_USAGE_URL =
	'https://docs.github.com/en/billing/reference/product-usage-included';
export const ACTIONS_PRICING_VERIFIED_AT = '2026-07-19';

const INCLUDED_MINUTES: Record<Exclude<GitHubPlan, 'unknown'>, number> = {
	free: 2_000,
	pro: 3_000,
	team: 3_000,
	enterprise: 50_000
};

/** Complete published runner-price catalog. Custom larger-runner names cannot be mapped safely. */
export const ACTIONS_RUNNER_PRICING = [
	['actions_linux_slim', 0.002],
	['actions_linux', 0.006],
	['actions_linux_arm', 0.005],
	['actions_windows', 0.01],
	['actions_windows_arm', 0.01],
	['actions_macos', 0.062],
	['linux_2_core_advanced', 0.006],
	['linux_4_core', 0.012],
	['linux_8_core', 0.022],
	['linux_16_core', 0.042],
	['linux_32_core', 0.082],
	['linux_64_core', 0.162],
	['linux_96_core', 0.252],
	['windows_4_core', 0.022],
	['windows_8_core', 0.042],
	['windows_16_core', 0.082],
	['windows_32_core', 0.162],
	['windows_64_core', 0.322],
	['windows_96_core', 0.552],
	['macos_l', 0.077],
	['linux_2_core_arm', 0.005],
	['linux_4_core_arm', 0.008],
	['linux_8_core_arm', 0.014],
	['linux_16_core_arm', 0.026],
	['linux_32_core_arm', 0.05],
	['linux_64_core_arm', 0.098],
	['windows_2_core_arm', 0.008],
	['windows_4_core_arm', 0.014],
	['windows_8_core_arm', 0.026],
	['windows_16_core_arm', 0.05],
	['windows_32_core_arm', 0.098],
	['windows_64_core_arm', 0.194],
	['macos_xl', 0.102],
	['linux_4_core_gpu', 0.052],
	['windows_4_core_gpu', 0.102]
] as const;

const rate = (sku: (typeof ACTIONS_RUNNER_PRICING)[number][0]) =>
	ACTIONS_RUNNER_PRICING.find(([candidate]) => candidate === sku)![1];

const RUNNERS: Partial<
	Record<RunnerType, { label: string; sku: string; rateUsd: number; includedEligible: boolean }>
> = {
	ubuntu: {
		label: 'Linux 2-core (x64)',
		sku: 'actions_linux',
		rateUsd: rate('actions_linux'),
		includedEligible: true
	},
	'ubuntu-slim': {
		label: 'Linux 1-core (x64)',
		sku: 'actions_linux_slim',
		rateUsd: rate('actions_linux_slim'),
		includedEligible: true
	},
	'ubuntu-arm': {
		label: 'Linux 2-core (arm64)',
		sku: 'actions_linux_arm',
		rateUsd: rate('actions_linux_arm'),
		includedEligible: true
	},
	windows: {
		label: 'Windows 2-core (x64)',
		sku: 'actions_windows',
		rateUsd: rate('actions_windows'),
		includedEligible: true
	},
	'windows-arm': {
		label: 'Windows 2-core (arm64)',
		sku: 'actions_windows_arm',
		rateUsd: rate('actions_windows_arm'),
		includedEligible: true
	},
	macos: {
		label: 'macOS standard',
		sku: 'actions_macos',
		rateUsd: rate('actions_macos'),
		includedEligible: true
	},
	'macos-large': {
		label: 'macOS 12-core larger runner',
		sku: 'macos_l',
		rateUsd: rate('macos_l'),
		includedEligible: false
	},
	'macos-xlarge': {
		label: 'macOS 5-core larger runner',
		sku: 'macos_xl',
		rateUsd: rate('macos_xl'),
		includedEligible: false
	},
	'self-hosted': {
		label: 'Self-hosted runner',
		sku: 'self_hosted',
		rateUsd: 0,
		includedEligible: false
	}
};

export function normalizeGitHubPlan(value: string | null | undefined): GitHubPlan {
	const plan = value?.toLowerCase() ?? '';
	if (plan.includes('enterprise')) return 'enterprise';
	if (plan === 'team' || plan.includes('business')) return 'team';
	if (plan === 'pro') return 'pro';
	if (plan === 'free') return 'free';
	return 'unknown';
}

export function calculateActionsCostEstimate(
	segments: Array<WorkflowMinutesShare | JobMinutesShare>,
	visibility: 'public' | 'private',
	plan: GitHubPlan,
	basis: ActionsCostEstimate['basis'],
	projection?: { sampledRuns: number; projectedRuns: number }
): ActionsCostEstimate {
	const scale = projection?.sampledRuns ? projection.projectedRuns / projection.sampledRuns : 1;
	const totals = new Map<
		string,
		{ runnerType: RunnerType; runnerLabel?: string; minutes: number }
	>();
	for (const segment of segments) {
		const runnerType = segment.runnerType ?? 'unknown';
		const runnerLabel = segment.runnerLabel;
		const key = `${runnerType}:${runnerLabel ?? ''}`;
		const current = totals.get(key);
		totals.set(key, {
			runnerType,
			runnerLabel,
			minutes: (current?.minutes ?? 0) + segment.minutes * scale
		});
	}

	const lines: ActionsCostLine[] = [...totals.values()].map(
		({ runnerType, runnerLabel, minutes }) => {
			const runner = RUNNERS[runnerType];
			if (!runner) {
				return {
					runnerType,
					label: runnerLabel ?? (runnerType === 'mixed' ? 'Mixed runners' : 'Unknown runner'),
					pricingLabel: null,
					sku: null,
					minutes,
					rateUsd: null,
					subtotalUsd: null,
					githubChargeUsd: null,
					includedEligible: false
				};
			}
			const subtotalUsd = minutes * runner.rateUsd;
			const freeStandardRunner = visibility === 'public' && runner.includedEligible;
			return {
				runnerType,
				label: runnerLabel ?? runner.label,
				pricingLabel: runner.label,
				sku: runner.sku,
				minutes,
				rateUsd: runner.rateUsd,
				subtotalUsd,
				githubChargeUsd: freeStandardRunner ? 0 : subtotalUsd,
				includedEligible: runner.includedEligible
			};
		}
	);
	const knownLines = lines.filter(
		(line): line is ActionsCostLine & { subtotalUsd: number; githubChargeUsd: number } =>
			line.subtotalUsd !== null && line.githubChargeUsd !== null
	);
	const unknownMinutes = lines
		.filter((line) => line.subtotalUsd === null)
		.reduce((sum, line) => sum + line.minutes, 0);

	return {
		visibility,
		plan,
		includedMinutes: plan === 'unknown' ? null : INCLUDED_MINUTES[plan],
		grossCostUsd: knownLines.reduce((sum, line) => sum + line.subtotalUsd, 0),
		chargeAfterAllowanceUsd: knownLines.reduce((sum, line) => sum + line.githubChargeUsd, 0),
		unknownMinutes,
		confidence: unknownMinutes > 0 ? 'partial' : 'estimated',
		basis,
		sampledRuns: projection?.sampledRuns,
		projectedRuns: projection?.projectedRuns,
		lines,
		verifiedAt: ACTIONS_PRICING_VERIFIED_AT,
		pricingUrl: ACTIONS_PRICING_URL,
		includedUsageUrl: ACTIONS_INCLUDED_USAGE_URL
	};
}
