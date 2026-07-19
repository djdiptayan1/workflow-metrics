<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { ActionsCostEstimate } from '$lib/types/metrics';
	import { formatMinutes } from '$lib/utils';

	let {
		estimate,
		windowLabel,
		onClose
	}: { estimate: ActionsCostEstimate; windowLabel: string; onClose: () => void } = $props();

	const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
	const planLabel = $derived(
		estimate.plan === 'unknown'
			? 'Plan unavailable'
			: `GitHub ${estimate.plan[0].toUpperCase()}${estimate.plan.slice(1)}`
	);
	const unavoidableCharge = $derived(
		estimate.lines
			.filter((line) => !line.includedEligible)
			.reduce((sum, line) => sum + (line.githubChargeUsd ?? 0), 0)
	);
</script>

<Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
	<Dialog.Portal>
		<Dialog.Overlay class="bg-background/80 fixed inset-0 z-50 backdrop-blur-sm" />
		<Dialog.Content
			class="border-border bg-card fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border p-6 shadow-xl"
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<Dialog.Title class="text-foreground text-lg font-semibold"
						>GitHub Actions cost estimate</Dialog.Title
					>
					<Dialog.Description class="text-muted-foreground mt-1 text-sm">
						{windowLabel} · {estimate.visibility} repository · {planLabel}
					</Dialog.Description>
				</div>
				<button
					type="button"
					onclick={onClose}
					class="text-muted-foreground hover:text-foreground focus:ring-ring rounded-md p-1 focus:ring-2 focus:outline-none"
					aria-label="Close cost estimate">✕</button
				>
			</div>

			<div class="mt-5 grid gap-3 sm:grid-cols-3">
				<div class="bg-muted/40 rounded-lg p-4">
					<p class="text-muted-foreground text-xs">On-demand runner value</p>
					<p class="text-foreground mt-1 text-xl font-semibold tabular-nums">
						{usd.format(estimate.grossCostUsd)}
					</p>
				</div>
				<div class="bg-muted/40 rounded-lg p-4">
					<p class="text-muted-foreground text-xs">Included standard minutes</p>
					<p class="text-foreground mt-1 text-xl font-semibold tabular-nums">
						{estimate.includedMinutes === null
							? 'Unknown'
							: estimate.includedMinutes.toLocaleString()}
					</p>
					<p class="text-muted-foreground text-xs">per account each month</p>
				</div>
				<div class="bg-muted/40 rounded-lg p-4">
					<p class="text-muted-foreground text-xs">After allowance is exhausted</p>
					<p class="text-foreground mt-1 text-xl font-semibold tabular-nums">
						{usd.format(estimate.chargeAfterAllowanceUsd)}
					</p>
				</div>
			</div>

			<div class="border-border mt-4 rounded-lg border p-4 text-sm">
				{#if estimate.visibility === 'public' && estimate.chargeAfterAllowanceUsd === unavoidableCharge}
					<p class="text-foreground">
						Standard GitHub-hosted runners are free for this public repository.
					</p>
				{:else}
					<p class="text-foreground">
						With account allowance remaining, the GitHub charge could be as low as
						<strong>{usd.format(unavoidableCharge)}</strong>.
					</p>
					<p class="text-muted-foreground mt-1 text-xs">
						Allowance is monthly and shared by every repository owned by the account, so this is not
						an actual bill.
					</p>
				{/if}
			</div>

			<div class="border-border mt-5 overflow-x-auto rounded-lg border">
				<table class="w-full min-w-[620px] text-sm">
					<thead class="bg-muted/40 text-muted-foreground text-xs">
						<tr
							><th class="px-4 py-3 text-left font-medium">Runner</th><th
								class="px-4 py-3 text-right font-medium">Minutes</th
							><th class="px-4 py-3 text-right font-medium">Rate</th><th
								class="px-4 py-3 text-right font-medium">Value</th
							></tr
						>
					</thead>
					<tbody>
						{#each estimate.lines as line (`${line.runnerType}:${line.label}`)}
							<tr class="border-border border-t">
								<td class="px-4 py-3"
									><p class="text-foreground font-medium">{line.label}</p>
									<p class="text-muted-foreground text-xs">
										{line.pricingLabel
											? `${line.pricingLabel} · ${line.sku}`
											: 'Pricing unavailable for this runner label'}
									</p></td
								>
								<td class="text-foreground px-4 py-3 text-right tabular-nums"
									>{formatMinutes(line.minutes)}</td
								>
								<td class="text-muted-foreground px-4 py-3 text-right tabular-nums"
									>{line.rateUsd === null ? '—' : `${usd.format(line.rateUsd)}/min`}</td
								>
								<td class="text-foreground px-4 py-3 text-right font-medium tabular-nums"
									>{line.subtotalUsd === null ? 'Excluded' : usd.format(line.subtotalUsd)}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if estimate.unknownMinutes > 0}
				<p
					class="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
				>
					{formatMinutes(estimate.unknownMinutes)} use dynamic, mixed, or custom runner labels and are
					excluded rather than guessed.
				</p>
			{/if}
			<p class="text-muted-foreground mt-4 text-xs">
				{estimate.basis === 'sampled-jobs'
					? `Runner mix sampled from ${estimate.sampledRuns ?? 0} recent completed runs and extrapolated across ${estimate.projectedRuns ?? 0} completed runs in this window.`
					: 'Based on workflow elapsed time; parallel jobs can make actual billed compute higher.'}
				Rates verified {estimate.verifiedAt} from
				<a
					class="text-primary hover:underline"
					href={estimate.pricingUrl}
					target="_blank"
					rel="noreferrer">GitHub runner pricing</a
				>
				and
				<a
					class="text-primary hover:underline"
					href={estimate.includedUsageUrl}
					target="_blank"
					rel="noreferrer">included usage</a
				>.
			</p>
			<p class="text-muted-foreground mt-2 text-xs">
				Cost uses GitHub's per-job rounded compute minutes; the Build Minutes card uses workflow
				elapsed time. Parallel jobs mean the two totals do not match one-to-one.
			</p>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
