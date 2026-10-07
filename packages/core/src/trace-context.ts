import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  readonly traceId: string;
  readonly requestId?: string;
  readonly executionId?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function createTraceId(): string {
  return `trace_${randomUUID()}`;
}

export function currentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function currentTraceId(): string {
  return currentTraceContext()?.traceId ?? createTraceId();
}

export function runWithTrace<T>(context: TraceContext, operation: () => T): T {
  return traceStorage.run(context, operation);
}
