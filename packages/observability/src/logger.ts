import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { redactText, redactValue, type NexusLogger } from '@nexus-ai/core';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import pretty from 'pino-pretty';

export interface LoggerOptions {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly format: 'json' | 'pretty';
  readonly destination: string;
  readonly service?: string;
  readonly environment?: string;
  readonly extraRedactKeys?: readonly string[];
}

export interface FlushableNexusLogger extends NexusLogger {
  flush(): void;
}

function createStream(options: LoggerOptions): DestinationStream {
  if (options.destination !== 'stdout') {
    mkdirSync(dirname(options.destination), { recursive: true, mode: 0o700 });
  }
  if (options.format === 'pretty') {
    return pretty({
      colorize: options.destination === 'stdout' && process.stdout.isTTY,
      destination: options.destination === 'stdout' ? 1 : options.destination,
      singleLine: false,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      sync: true,
    });
  }
  return options.destination === 'stdout'
    ? process.stdout
    : pino.destination({ dest: options.destination, sync: false, mkdir: true });
}

function safeBindings(
  bindings: Readonly<Record<string, unknown>>,
  extraKeys: readonly string[],
): Record<string, unknown> {
  return redactValue(bindings, extraKeys) as Record<string, unknown>;
}

export function createLogger(options: LoggerOptions): FlushableNexusLogger {
  const stream = createStream(options);
  const baseLogger: PinoLogger = pino(
    {
      level: options.level,
      base: {
        service: options.service ?? 'nexus-ai',
        environment: options.environment ?? 'development',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'message',
    },
    stream,
  );
  const extraKeys = options.extraRedactKeys ?? [];

  return {
    debug: (bindings, message) =>
      baseLogger.debug(safeBindings(bindings, extraKeys), redactText(message)),
    info: (bindings, message) =>
      baseLogger.info(safeBindings(bindings, extraKeys), redactText(message)),
    warn: (bindings, message) =>
      baseLogger.warn(safeBindings(bindings, extraKeys), redactText(message)),
    error: (bindings, message) =>
      baseLogger.error(safeBindings(bindings, extraKeys), redactText(message)),
    flush: () => baseLogger.flush(),
  };
}
