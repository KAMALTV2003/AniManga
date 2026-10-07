import { currentTraceId } from './trace-context.js';
import { redactText, redactValue } from './redaction.js';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface NexusErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly component: string;
  readonly retryable?: boolean;
  readonly severity?: ErrorSeverity;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly traceId?: string;
  readonly cause?: unknown;
}

export interface SerializedNexusError {
  readonly code: string;
  readonly message: string;
  readonly component: string;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
  readonly details: Readonly<Record<string, unknown>>;
  readonly trace_id: string;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;

export class NexusError extends Error {
  readonly code: string;
  readonly component: string;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
  readonly details: Readonly<Record<string, unknown>>;
  readonly traceId: string;

  constructor(options: NexusErrorOptions) {
    if (!CODE_PATTERN.test(options.code)) {
      throw new TypeError(`Invalid NEXUS error code: ${options.code}`);
    }
    super(redactText(options.message), { cause: options.cause });
    this.name = 'NexusError';
    this.code = options.code;
    this.component = options.component;
    this.retryable = options.retryable ?? false;
    this.severity = options.severity ?? 'medium';
    this.traceId = options.traceId ?? currentTraceId();
    this.details = (redactValue(options.details ?? {}) ?? {}) as Readonly<Record<string, unknown>>;
  }

  toJSON(): SerializedNexusError {
    return {
      code: this.code,
      message: this.message,
      component: this.component,
      retryable: this.retryable,
      severity: this.severity,
      details: this.details,
      trace_id: this.traceId,
    };
  }
}

export function asNexusError(
  error: unknown,
  fallback: Omit<NexusErrorOptions, 'message' | 'cause'> & { readonly message?: string },
): NexusError {
  if (error instanceof NexusError) {
    return error;
  }
  const sourceMessage = error instanceof Error ? error.message : String(error);
  return new NexusError({
    ...fallback,
    message: fallback.message ?? sourceMessage,
    cause: error,
  });
}
