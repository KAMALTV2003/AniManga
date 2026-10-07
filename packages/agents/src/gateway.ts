import { performance } from 'node:perf_hooks';

import { stableStringify } from '@nexus-ai/core';

import {
  type ModelInvocationResult,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStopReason,
} from './types.js';
import {
  agentError,
  canonicalRecord,
  requireInteger,
  requireKey,
  requireText,
} from './validation.js';

const ROLES = ['system', 'user', 'assistant'] as const;
const STOP_REASONS: readonly ModelStopReason[] = [
  'completed',
  'max_output_tokens',
  'tool_call',
  'content_filter',
  'cancelled',
  'error',
  'unknown',
];

export class ModelGateway {
  async invoke(
    provider: ModelProvider,
    request: ModelRequest,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ModelInvocationResult> {
    const providerName = requireKey(provider.provider, 'provider', 128).toLocaleLowerCase('en-US');
    const normalizedRequest = normalizeModelRequest(request);
    const timeoutMs = requireInteger(options.timeoutMs ?? 60_000, 'timeoutMs', 1, 300_000);
    const timeoutController = new AbortController();
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([timeoutController.signal, options.signal]);
    if (signal.aborted) {
      throw agentError(
        'MODEL_INVOCATION_CANCELLED',
        'Model invocation was cancelled before dispatch',
        undefined,
        signal.reason,
      );
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new Error('model invocation timed out'));
    }, timeoutMs);
    timer.unref();
    const started = performance.now();
    const abortError = () =>
      agentError(
        timedOut ? 'MODEL_INVOCATION_TIMEOUT' : 'MODEL_INVOCATION_CANCELLED',
        timedOut ? 'Model invocation exceeded its timeout' : 'Model invocation was cancelled',
        { timeoutMs },
        signal.reason,
      );
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(abortError());
      signal.addEventListener('abort', abortHandler, { once: true });
    });
    let raw: ModelResponse;
    try {
      raw = await Promise.race([
        Promise.resolve()
          .then(() => provider.invoke(normalizedRequest, signal))
          .catch((error: unknown) => {
            if (signal.aborted) throw abortError();
            throw agentError(
              'MODEL_PROVIDER_FAILURE',
              'Model provider invocation failed',
              { provider: providerName, model: normalizedRequest.model },
              error,
            );
          }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      if (abortHandler !== undefined) signal.removeEventListener('abort', abortHandler);
    }
    const response = normalizeModelResponse(raw, normalizedRequest, providerName);
    return {
      response,
      latencyMs: Number((performance.now() - started).toFixed(3)),
    };
  }
}

export function normalizeModelRequest(input: ModelRequest): ModelRequest {
  const requestId = requireKey(input.requestId, 'requestId', 256);
  const model = requireKey(input.model, 'model', 192);
  const rawMessages: unknown = input.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length < 1 || rawMessages.length > 200) {
    throw new RangeError('messages must contain between 1 and 200 entries');
  }
  const messages: ModelMessage[] = rawMessages.map((message: unknown, index: number) => {
    if (message === null || Array.isArray(message) || typeof message !== 'object') {
      throw new TypeError(`messages[${index}] must be an object`);
    }
    const record = message as Readonly<Record<string, unknown>>;
    const role = record['role'];
    const content = record['content'];
    if (typeof role !== 'string' || !ROLES.includes(role as ModelMessage['role'])) {
      throw new RangeError(`messages[${index}] has invalid role`);
    }
    if (typeof content !== 'string') {
      throw new TypeError(`messages[${index}].content must be a string`);
    }
    return {
      role: role as ModelMessage['role'],
      content: requireText(content, `messages[${index}].content`, 262_144),
    };
  });
  const totalMessageBytes = messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
    0,
  );
  if (totalMessageBytes > 1_000_000) {
    throw new RangeError('Combined model message content must not exceed 1000000 UTF-8 bytes');
  }
  const maxOutputTokens = requireInteger(input.maxOutputTokens, 'maxOutputTokens', 1, 1_000_000);
  let temperature: number | undefined;
  if (input.temperature !== undefined) {
    if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
      throw new RangeError('temperature must be a finite number between 0 and 2');
    }
    temperature = input.temperature;
  }
  let responseFormat: ModelRequest['responseFormat'];
  const rawResponseFormat: unknown = input.responseFormat;
  if (rawResponseFormat !== undefined) {
    if (
      rawResponseFormat === null ||
      Array.isArray(rawResponseFormat) ||
      typeof rawResponseFormat !== 'object'
    ) {
      throw new TypeError('responseFormat must be an object');
    }
    const format = rawResponseFormat as Readonly<Record<string, unknown>>;
    if (format['type'] === 'text') responseFormat = { type: 'text' };
    else if (format['type'] === 'json_schema') {
      if (typeof format['name'] !== 'string') {
        throw new TypeError('response schema name must be a string');
      }
      if (
        format['schema'] === null ||
        Array.isArray(format['schema']) ||
        typeof format['schema'] !== 'object'
      ) {
        throw new TypeError('response schema must be an object');
      }
      responseFormat = {
        type: 'json_schema',
        name: requireKey(format['name'], 'response schema name'),
        schema: canonicalRecord(
          format['schema'] as Readonly<Record<string, unknown>>,
          'response schema',
          65_536,
        ),
      };
    } else {
      throw new RangeError('Unsupported response format');
    }
  }
  return {
    requestId,
    model,
    messages,
    maxOutputTokens,
    ...(temperature === undefined ? {} : { temperature }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
  };
}

export function normalizeModelResponse(
  input: ModelResponse,
  request: ModelRequest,
  provider: string,
): ModelResponse {
  if (input.requestId !== request.requestId) {
    throw agentError('MODEL_RESPONSE_MISMATCH', 'Model response request identity does not match');
  }
  const responseProvider = requireKey(input.provider, 'response provider', 128).toLocaleLowerCase(
    'en-US',
  );
  if (responseProvider !== provider || input.model !== request.model) {
    throw agentError('MODEL_RESPONSE_MISMATCH', 'Model response provider or model does not match');
  }
  if (!STOP_REASONS.includes(input.stopReason)) {
    throw new RangeError('Model response has unsupported stop reason');
  }
  const providerRequestId =
    input.providerRequestId === null
      ? null
      : requireText(input.providerRequestId, 'providerRequestId', 256);
  const costMicrounits =
    input.costMicrounits === null
      ? null
      : requireInteger(input.costMicrounits, 'costMicrounits', 0, 1_000_000_000_000_000);
  const response = {
    requestId: request.requestId,
    providerRequestId,
    provider: responseProvider,
    model: request.model,
    text: requireText(input.text, 'response text', 4_000_000, true),
    stopReason: input.stopReason,
    usage: {
      inputTokens: requireInteger(input.usage.inputTokens, 'inputTokens', 0, 100_000_000),
      outputTokens: requireInteger(input.usage.outputTokens, 'outputTokens', 0, 100_000_000),
    },
    costMicrounits,
  } satisfies ModelResponse;
  if (Buffer.byteLength(stableStringify(response), 'utf8') > 4_100_000) {
    throw new RangeError('Normalized model response exceeds its evidence bound');
  }
  return response;
}
