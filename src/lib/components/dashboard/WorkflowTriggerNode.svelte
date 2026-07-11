<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { NodeProps } from '@xyflow/svelte';

	let {
		data,
		sourcePosition = Position.Right
	}: NodeProps = $props();

	const compact = $derived(data?.compact ?? false);
</script>

<div
	class="flex flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-primary/60 bg-primary/10 font-medium text-primary shadow {compact
		? 'w-[80px] px-2 py-2 text-[10px]'
		: 'w-[100px] px-3 py-3 text-xs'}"
>
	<div class="flex items-center gap-1 text-[10px] text-primary">
		<i class="fa-solid fa-bolt shrink-0 text-[10px]"></i>
		<span class="font-semibold uppercase tracking-wide">Trigger</span>
	</div>
	<div class="flex items-center gap-1 text-[10px] text-primary/80">
		<i class="fa-solid fa-code-commit shrink-0 text-[10px]"></i>
		<span>push</span>
	</div>
</div>
<Handle type="source" position={sourcePosition} />
