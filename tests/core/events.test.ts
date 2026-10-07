import { describe, expect, it, vi } from 'vitest';

import { createEvent, InMemoryEventBus, type NexusError } from '@nexus-ai/core';

describe('InMemoryEventBus', () => {
  it('delivers typed and wildcard subscriptions and supports unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const typed = vi.fn();
    const wildcard = vi.fn();
    const unsubscribe = bus.subscribe('task.started', typed);
    bus.subscribe('*', wildcard);
    const event = createEvent({ type: 'task.started', source: 'test', payload: { task: 'x' } });

    await bus.publish(event);
    unsubscribe();
    await bus.publish(event);

    expect(typed).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(event.payload).toEqual({ task: 'x' });
  });

  it('fails explicitly when a subscriber rejects', async () => {
    const bus = new InMemoryEventBus();
    bus.subscribe('*', () => {
      throw new Error('sink offline');
    });

    await expect(
      bus.publish(createEvent({ type: 'tool.failed', source: 'test', payload: {} })),
    ).rejects.toMatchObject<NexusError>({ code: 'EVENT_DELIVERY_FAILED' });
  });
});
