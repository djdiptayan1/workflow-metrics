import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { WorkflowMetrics, OptimizationResult } from '$lib/types/metrics';

export type AIProvider = 'openai' | 'gemini' | 'mistral';

export const AI_PROVIDER_MODELS: Record<AIProvider, string> = {
	openai: 'gpt-4.1-mini',
	gemini: 'gemini-2.5-flash',
	mistral: 'mistral-small-latest'
};

export const AI_PROVIDER_LABELS: Record<AIProvider, string> = {
	openai: 'OpenAI',
	gemini: 'Google Gemini',
	mistral: 'Mistral AI'
};

export function createAIModel(provider: AIProvider, apiKey: string, model?: string | null) {
	const modelId = model || AI_PROVIDER_MODELS[provider];
	if (provider === 'gemini') return createGoogleGenerativeAI({ apiKey })(modelId);
	if (provider === 'mistral') return createMistral({ apiKey })(modelId);
	return createOpenAI({ apiKey })(modelId);
}

export async function fetchAvailableModels(provider: AIProvider, apiKey: string): Promise<string[]> {
	const response = await fetch(
		provider === 'gemini'
			? `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`
			: provider === 'mistral'
				? 'https://api.mistral.ai/v1/models'
				: 'https://api.openai.com/v1/models',
		provider === 'gemini' ? undefined : { headers: { Authorization: `Bearer ${apiKey}` } }
	);

	if (!response.ok) {
		throw new Error(response.status === 401 || response.status === 403
			? 'The API key was rejected by the selected provider.'
			: `The provider returned an error (${response.status}).`);
	}

	if (provider === 'gemini') {
		const data = (await response.json()) as {
			models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
		};
		return (data.models ?? [])
			.filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
			.map((model) => model.name.replace(/^models\//, ''))
			.sort();
	}

	if (provider === 'mistral') {
		const data = (await response.json()) as {
			data?: Array<{ id: string; capabilities?: { completion_chat?: boolean } }>;
		};
		return (data.data ?? [])
			.filter((model) => model.capabilities?.completion_chat !== false)
			.map((model) => model.id)
			.sort();
	}

	const data = (await response.json()) as { data?: Array<{ id: string }> };
	// ponytail: OpenAI's list endpoint has no capability field; expand this filter if new text families appear.
	return (data.data ?? [])
		.map((model) => model.id)
		.filter((id) => /^(gpt-|o\d)/.test(id) && !/(audio|image|realtime|transcribe|tts)/.test(id))
		.sort();
}

const OptimizationItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	category: z.enum(['performance', 'cost', 'reliability', 'security', 'maintenance']),
	explanation: z.string(),
	codeExample: z.string().optional(),
	estimatedImpact: z.string().optional(),
	effort: z.enum(['Low', 'Medium', 'High'])
});

const OptimizationSchema = z.object({
	optimizations: z.array(OptimizationItemSchema),
	summary: z.object({
		expectedAvgDuration: z.string().optional(),
		expectedSuccessRate: z.string().optional(),
		expectedP95Duration: z.string().optional(),
		notes: z.string().optional()
	})
});

export function buildOptimizationPrompt(
	workflowName: string,
	workflowYaml: string,
	metrics: WorkflowMetrics
): string {
	const successRate = metrics.successRate.toFixed(1);
	const avgDuration = Math.round(metrics.avgDurationMs / 1000);
	const p95Duration = Math.round(metrics.p95DurationMs / 1000);

	return `You are an expert in GitHub Actions workflow optimization. Analyze the following workflow and provide specific, actionable optimization recommendations.

## Workflow: ${workflowName}

### Current Metrics (last 30 days)
- Total runs: ${metrics.totalRuns}
- Success rate: ${successRate}%
- Average duration: ${avgDuration}s
- P95 duration: ${p95Duration}s
- Failure count: ${metrics.failureCount}

### Workflow YAML
\`\`\`yaml
${workflowYaml}
\`\`\`

### Instructions

Return a JSON object with an "optimizations" array and a "summary" object.

Each optimization must have:
- id: a short kebab-case identifier (e.g. "add-npm-cache", "parallel-test-lint")
- title: a short human-readable title (3-5 words, e.g. "Better npm caching", "Parallel test jobs")
- category: one of "performance", "cost", "reliability", "security", "maintenance"
- explanation: 2-4 sentences explaining the problem and the fix
- codeExample: (optional) relevant YAML snippet showing the change
- estimatedImpact: (optional) concise expected impact (e.g. "20-40% faster builds", "50% fewer failures")
- effort: "Low", "Medium", or "High"

Cover these areas where applicable:
1. Caching (npm, pip, cargo, etc.)
2. Parallelization (jobs or steps that can run concurrently)
3. Runner optimization
4. Conditional steps (skip work when files haven't changed)
5. Action version pinning (security)
6. Failure reduction based on the ${metrics.failureCount} failures
7. Quick wins

The "summary" object should have:
- expectedAvgDuration: target average duration range after all changes (e.g. "40-60s")
- expectedSuccessRate: target success rate range (e.g. "85-95%")
- expectedP95Duration: target P95 range (e.g. "70-90s")
- notes: (optional) one sentence with any important caveats`;
}

export async function generateOptimizationReport(
	apiKey: string,
	workflowName: string,
	workflowYaml: string,
	metrics: WorkflowMetrics,
	provider: AIProvider = 'openai',
	model?: string | null
): Promise<{ result: OptimizationResult; usage: { promptTokens: number; completionTokens: number } }> {
	const prompt = buildOptimizationPrompt(workflowName, workflowYaml, metrics);

	const { output, usage } = await generateText({
		model: createAIModel(provider, apiKey, model),
		output: Output.object({ schema: OptimizationSchema }),
		prompt,
		maxOutputTokens: 4096
	});

	return {
		result: output as OptimizationResult,
		usage: {
			promptTokens: usage.inputTokens ?? 0,
			completionTokens: usage.outputTokens ?? 0
		}
	};
}
