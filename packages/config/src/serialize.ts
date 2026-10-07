import { stringify } from 'yaml';

import type { NexusConfig } from './schema.js';

export function serializeConfig(config: NexusConfig): string {
  return stringify(config, {
    indent: 2,
    lineWidth: 100,
    sortMapEntries: false,
  });
}
