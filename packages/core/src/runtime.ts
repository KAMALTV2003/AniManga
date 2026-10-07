import { NexusError, asNexusError } from './errors.js';
import { createEvent, type EventBus } from './events.js';
import { type NexusLogger, silentLogger } from './logger.js';

export type ComponentHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentHealth {
  readonly status: ComponentHealthStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface LifecycleComponent {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ComponentHealth>;
}

export type RuntimeState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface RuntimeHealth {
  readonly status: ComponentHealthStatus;
  readonly state: RuntimeState;
  readonly components: Readonly<Record<string, ComponentHealth>>;
}

const HEALTH_RANK: Readonly<Record<ComponentHealthStatus, number>> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

export class CoreRuntime {
  readonly #components: LifecycleComponent[];
  readonly #eventBus: EventBus;
  readonly #logger: NexusLogger;
  #state: RuntimeState = 'created';

  constructor(options: {
    readonly components: readonly LifecycleComponent[];
    readonly eventBus: EventBus;
    readonly logger?: NexusLogger;
  }) {
    const names = options.components.map((component) => component.name);
    if (new Set(names).size !== names.length) {
      throw new NexusError({
        code: 'RUNTIME_DUPLICATE_COMPONENT',
        message: 'Runtime component names must be unique',
        component: 'core.runtime',
        severity: 'high',
        details: { names },
      });
    }
    this.#components = [...options.components];
    this.#eventBus = options.eventBus;
    this.#logger = options.logger ?? silentLogger;
  }

  get state(): RuntimeState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== 'created' && this.#state !== 'stopped') {
      throw new NexusError({
        code: 'RUNTIME_INVALID_STATE',
        message: `Cannot start runtime while it is ${this.#state}`,
        component: 'core.runtime',
        details: { state: this.#state },
      });
    }

    this.#state = 'starting';
    const started: LifecycleComponent[] = [];
    try {
      for (const component of this.#components) {
        await component.start();
        started.push(component);
        this.#logger.info({ component: component.name }, 'Runtime component started');
      }
      this.#state = 'running';
      await this.#eventBus.publish(
        createEvent({
          type: 'system.started',
          source: 'core.runtime',
          payload: { components: this.#components.map((component) => component.name) },
        }),
      );
    } catch (error) {
      this.#state = 'failed';
      const rollbackFailures: string[] = [];
      for (const component of started.reverse()) {
        try {
          await component.stop();
        } catch {
          rollbackFailures.push(component.name);
        }
      }
      throw asNexusError(error, {
        code: 'RUNTIME_START_FAILED',
        component: 'core.runtime',
        retryable: true,
        severity: 'critical',
        details: { rollbackFailures },
      });
    }
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'created') {
      this.#state = 'stopped';
      return;
    }
    if (this.#state !== 'running' && this.#state !== 'failed') {
      throw new NexusError({
        code: 'RUNTIME_INVALID_STATE',
        message: `Cannot stop runtime while it is ${this.#state}`,
        component: 'core.runtime',
        details: { state: this.#state },
      });
    }

    this.#state = 'stopping';
    const failures: string[] = [];
    for (const component of [...this.#components].reverse()) {
      try {
        await component.stop();
      } catch (error) {
        failures.push(component.name);
        this.#logger.error({ component: component.name, error }, 'Runtime component stop failed');
      }
    }
    this.#state = failures.length === 0 ? 'stopped' : 'failed';
    if (failures.length > 0) {
      throw new NexusError({
        code: 'RUNTIME_STOP_FAILED',
        message: `Failed to stop ${failures.length} runtime component(s)`,
        component: 'core.runtime',
        retryable: true,
        severity: 'high',
        details: { failures },
      });
    }
    await this.#eventBus.publish(
      createEvent({ type: 'system.stopped', source: 'core.runtime', payload: {} }),
    );
  }

  async health(): Promise<RuntimeHealth> {
    const componentEntries = await Promise.all(
      this.#components.map(async (component) => {
        try {
          return [component.name, await component.health()] as const;
        } catch (error) {
          return [
            component.name,
            {
              status: 'unhealthy',
              details: { error: error instanceof Error ? error.message : String(error) },
            },
          ] as const;
        }
      }),
    );
    const components = Object.fromEntries(componentEntries);
    let status: ComponentHealthStatus = this.#state === 'running' ? 'healthy' : 'unhealthy';
    for (const health of Object.values(components)) {
      if (HEALTH_RANK[health.status] > HEALTH_RANK[status]) {
        status = health.status;
      }
    }
    return { status, state: this.#state, components };
  }
}
