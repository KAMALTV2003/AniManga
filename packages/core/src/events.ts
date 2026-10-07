import { createId } from './ids.js';
import { NexusError } from './errors.js';
import { currentTraceId } from './trace-context.js';

export type NexusEventName =
  | 'system.started'
  | 'system.stopped'
  | 'system.failed'
  | 'task.started'
  | 'task.completed'
  | 'agent.started'
  | 'agent.completed'
  | 'skill.loaded'
  | 'skill.updated'
  | 'skill.failed'
  | 'tool.called'
  | 'tool.failed'
  | 'security.blocked'
  | 'evaluation.completed'
  | 'memory.created'
  | 'memory.promoted'
  | 'model.fallback'
  | 'workflow.completed';

export interface NexusEvent<
  TPayload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  readonly type: NexusEventName;
  readonly version: 1;
  readonly occurredAt: string;
  readonly traceId: string;
  readonly source: string;
  readonly payload: TPayload;
}

export type EventHandler = (event: NexusEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export function createEvent<TPayload extends Readonly<Record<string, unknown>>>(options: {
  readonly type: NexusEventName;
  readonly source: string;
  readonly payload: TPayload;
  readonly traceId?: string;
  readonly occurredAt?: Date;
}): NexusEvent<TPayload> {
  if (options.source.trim().length === 0) {
    throw new TypeError('Event source cannot be empty');
  }
  return Object.freeze({
    id: createId('evt'),
    type: options.type,
    version: 1 as const,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    traceId: options.traceId ?? currentTraceId(),
    source: options.source,
    payload: structuredClone(options.payload),
  });
}

export interface EventBus {
  publish(event: NexusEvent): Promise<void>;
  subscribe(type: NexusEventName | '*', handler: EventHandler): Unsubscribe;
}

export class InMemoryEventBus implements EventBus {
  readonly #handlers = new Map<NexusEventName | '*', Set<EventHandler>>();

  subscribe(type: NexusEventName | '*', handler: EventHandler): Unsubscribe {
    const handlers = this.#handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.#handlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.#handlers.delete(type);
      }
    };
  }

  async publish(event: NexusEvent): Promise<void> {
    const handlers = [
      ...(this.#handlers.get(event.type) ?? []),
      ...(this.#handlers.get('*') ?? []),
    ];
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(() => handler(event))),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new NexusError({
        code: 'EVENT_DELIVERY_FAILED',
        message: `Failed to deliver ${event.type} to ${failures.length} subscriber(s)`,
        component: 'core.event-bus',
        retryable: true,
        severity: 'high',
        details: { eventId: event.id, failureCount: failures.length },
      });
    }
  }
}
