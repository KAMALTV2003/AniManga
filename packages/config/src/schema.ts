import { z } from 'zod';

const projectId = z.string().regex(/^prj_[a-f0-9-]{16,64}$/u, 'Invalid project ID');
const safePath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), {
    message: 'Paths cannot contain null bytes',
  });

export const NexusConfigSchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(['development', 'test', 'production']).default('development'),
  project: z.strictObject({
    id: projectId,
    name: z.string().trim().min(1).max(128),
  }),
  runtime: z
    .strictObject({
      dataDir: safePath.default('.nexus'),
      shutdownTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    })
    .default({ dataDir: '.nexus', shutdownTimeoutMs: 10_000 }),
  database: z
    .strictObject({
      provider: z.literal('sqlite').default('sqlite'),
      path: safePath.default('.nexus/nexus.db'),
      busyTimeoutMs: z.number().int().min(100).max(120_000).default(5_000),
    })
    .default({ provider: 'sqlite', path: '.nexus/nexus.db', busyTimeoutMs: 5_000 }),
  logging: z
    .strictObject({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      format: z.enum(['json', 'pretty']).default('pretty'),
      destination: z.union([z.literal('stdout'), safePath]).default('stdout'),
      captureContent: z.boolean().default(false),
      extraRedactKeys: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
    })
    .default({
      level: 'info',
      format: 'pretty',
      destination: 'stdout',
      captureContent: false,
      extraRedactKeys: [],
    }),
  security: z
    .strictObject({
      failClosed: z.boolean().default(true),
    })
    .default({ failClosed: true }),
});

export type NexusConfig = z.infer<typeof NexusConfigSchema>;

export interface LoadedNexusConfig {
  readonly config: NexusConfig;
  readonly projectRoot: string;
  readonly configPath: string;
  readonly sources: readonly string[];
}
