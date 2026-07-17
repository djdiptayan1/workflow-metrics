<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { WorkflowMetrics } from '$lib/types/metrics';

	interface Props {
		workflows: WorkflowMetrics[];
		selectedIds: number[];
		onSave: (ids: number[]) => Promise<void>;
		onClose: () => void;
	}

	let { workflows, selectedIds, onSave, onClose }: Props = $props();

	// Use a plain $state array for selections — SvelteSet cannot be $state-wrapped per eslint rule,
	// but using an array with $state gives us full reactivity.
	let localSelection = $derived([...selectedIds]);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let query = $state('');
	const filteredWorkflows = $derived(
		workflows.filter((workflow) => {
			if (workflow.workflowPath.startsWith('historical/')) return false;
			const term = query.trim().toLowerCase();
			return (
				term === '' ||
				`${workflow.workflowName} ${workflow.workflowPath}`.toLowerCase().includes(term)
			);
		})
	);

	function isSelected(workflowId: number) {
		return localSelection.includes(workflowId);
	}

	function toggleWorkflow(workflowId: number) {
		if (localSelection.includes(workflowId)) {
			localSelection = localSelection.filter((id) => id !== workflowId);
		} else {
			localSelection = [...localSelection, workflowId];
		}
	}

	async function handleSave() {
		saving = true;
		error = null;
		try {
			await onSave(Array.from(localSelection));
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save workflow selection';
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
	<Dialog.Portal>
		<Dialog.Overlay
			class="bg-background/80 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fixed inset-0 z-50 backdrop-blur-sm"
		/>
		<Dialog.Content
			class="border-border bg-card data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 fixed top-1/2 left-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border p-6 shadow-lg"
		>
			<!-- Header -->
			<div class="mb-4">
				<Dialog.Title id="dialog-title" class="text-foreground text-lg font-semibold">
					Select Production Workflows
				</Dialog.Title>
				<Dialog.Description id="dialog-description" class="text-muted-foreground mt-1 text-sm">
					Check the workflows that deploy to production. DORA metrics will only include these
					workflows.
				</Dialog.Description>
			</div>
			<label class="relative mb-4 block">
				<span class="sr-only">Search workflows</span>
				<input
					bind:value={query}
					type="search"
					placeholder="Search workflows"
					class="border-border bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border py-2 pr-3 pl-9 text-sm focus:ring-2 focus:outline-none"
				/>
				<svg
					class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
				>
			</label>

			<!-- Workflow List -->
			<div
				class="border-border bg-background mb-4 max-h-96 space-y-2 overflow-y-auto rounded-md border p-4"
			>
				{#if filteredWorkflows.length === 0}
					<p class="text-muted-foreground py-4 text-center text-sm">
						{query.trim()
							? `No workflows match “${query.trim()}”.`
							: 'No workflows found for this repository.'}
					</p>
				{:else}
					{#each filteredWorkflows as workflow (workflow.workflowId)}
						<label
							class="hover:bg-accent flex cursor-pointer items-start gap-3 rounded-md p-3 transition-colors"
						>
							<input
								type="checkbox"
								checked={isSelected(workflow.workflowId)}
								onchange={() => toggleWorkflow(workflow.workflowId)}
								class="border-border text-primary focus:ring-ring mt-0.5 size-4 rounded focus:ring-2 focus:ring-offset-2"
							/>
							<div class="min-w-0 flex-1">
								<div class="text-foreground text-sm font-medium">
									{workflow.workflowName}
								</div>
								<div class="text-muted-foreground truncate text-xs">
									{workflow.workflowPath}
								</div>
								<div class="text-muted-foreground mt-1 flex gap-3 text-xs">
									<span>{workflow.totalRuns} runs</span>
									<span>{workflow.successRate.toFixed(1)}% success</span>
								</div>
							</div>
						</label>
					{/each}
				{/if}
			</div>

			{#if error}
				<div class="bg-destructive/10 text-destructive mb-4 rounded-md p-3 text-sm" role="alert">
					{error}
				</div>
			{/if}

			<!-- Footer -->
			<div class="flex items-center justify-between">
				<p class="text-muted-foreground text-xs">
					{localSelection.length} workflow{localSelection.length === 1 ? '' : 's'} selected
				</p>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={onClose}
						disabled={saving}
						class="text-foreground bg-secondary hover:bg-secondary/80 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={handleSave}
						disabled={saving}
						class="text-primary-foreground bg-primary hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
					>
						{saving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
