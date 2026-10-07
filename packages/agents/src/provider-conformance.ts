import { stableStringify } from '@nexus-ai/core';

import { ModelGateway } from './gateway.js';
import type { ModelProvider } from './types.js';
import { requireInteger, requireKey, rounded, sha256 } from './validation.js';

export interface ModelProviderConformanceOptions {
  readonly model: string;
  readonly maximumLatencyMs?: number;
}

export interface ModelProviderConformanceReport {
  readonly provider: string;
  readonly model: string;
  readonly passed: boolean;
  readonly probeHash: string;
  readonly checks: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  }[];
}

const PROBE =
  'Return one short sentence confirming that bounded English and Arabic input was received: تحقق من الحدود.';

export async function runModelProviderConformance(
  provider: ModelProvider,
  options: ModelProviderConformanceOptions,
): Promise<ModelProviderConformanceReport> {
  const providerName = requireKey(provider.provider, 'provider', 128).toLocaleLowerCase('en-US');
  const model = requireKey(options.model, 'model', 192);
  const maximumLatencyMs = requireInteger(
    options.maximumLatencyMs ?? 30_000,
    'maximumLatencyMs',
    1,
    300_000,
  );
  const invocation = await new ModelGateway().invoke(
    provider,
    {
      requestId: 'conformance-request-v1',
      model,
      messages: [{ role: 'user', content: PROBE }],
      maxOutputTokens: 128,
      temperature: 0,
      responseFormat: { type: 'text' },
    },
    { timeoutMs: maximumLatencyMs },
  );
  const checks: ModelProviderConformanceReport['checks'][number][] = [
    {
      id: 'identity',
      passed: invocation.response.provider === providerName && invocation.response.model === model,
      details: {
        provider: invocation.response.provider,
        model: invocation.response.model,
      },
    },
    {
      id: 'bounded-text-output',
      passed: Buffer.byteLength(invocation.response.text, 'utf8') > 0,
      details: { outputBytes: Buffer.byteLength(invocation.response.text, 'utf8') },
    },
    {
      id: 'usage-accounting',
      passed:
        invocation.response.usage.inputTokens > 0 && invocation.response.usage.outputTokens > 0,
      details: invocation.response.usage,
    },
    {
      id: 'latency',
      passed: invocation.latencyMs <= maximumLatencyMs,
      details: {
        maximumLatencyMs,
        actualLatencyMs: rounded(invocation.latencyMs),
      },
    },
  ];
  return {
    provider: providerName,
    model,
    passed: checks.every((check) => check.passed),
    probeHash: sha256(stableStringify([PROBE])),
    checks,
  };
}
