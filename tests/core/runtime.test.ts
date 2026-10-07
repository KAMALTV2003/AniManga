import { describe, expect, it } from 'vitest';

import {
  CoreRuntime,
  InMemoryEventBus,
  type ComponentHealth,
  type NexusError,
  type LifecycleComponent,
} from '@nexus-ai/core';

class TestComponent implements LifecycleComponent {
  readonly calls: string[] = [];

  constructor(
    readonly name: string,
    private readonly options: { failStart?: boolean; health?: ComponentHealth } = {},
  ) {}

  async start(): Promise<void> {
    this.calls.push('start');
    if (this.options.failStart) throw new Error('start failed');
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }

  async health(): Promise<ComponentHealth> {
    return this.options.health ?? { status: 'healthy' };
  }
}

describe('CoreRuntime', () => {
  it('starts in order, reports health, and stops in reverse order', async () => {
    const first = new TestComponent('first');
    const second = new TestComponent('second', { health: { status: 'degraded' } });
    const runtime = new CoreRuntime({
      components: [first, second],
      eventBus: new InMemoryEventBus(),
    });

    await runtime.start();
    expect(runtime.state).toBe('running');
    expect((await runtime.health()).status).toBe('degraded');
    await runtime.stop();

    expect(first.calls).toEqual(['start', 'stop']);
    expect(second.calls).toEqual(['start', 'stop']);
    expect(runtime.state).toBe('stopped');
  });

  it('rolls back started components when startup fails', async () => {
    const started = new TestComponent('started');
    const failed = new TestComponent('failed', { failStart: true });
    const runtime = new CoreRuntime({
      components: [started, failed],
      eventBus: new InMemoryEventBus(),
    });

    await expect(runtime.start()).rejects.toMatchObject<NexusError>({
      code: 'RUNTIME_START_FAILED',
    });
    expect(started.calls).toEqual(['start', 'stop']);
    expect(runtime.state).toBe('failed');
  });

  it('rejects duplicate component names', () => {
    expect(
      () =>
        new CoreRuntime({
          components: [new TestComponent('same'), new TestComponent('same')],
          eventBus: new InMemoryEventBus(),
        }),
    ).toThrowError(/unique/u);
  });
});
