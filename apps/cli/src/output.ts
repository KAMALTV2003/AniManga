import { asNexusError, redactText, redactValue, type NexusError } from '@nexus-ai/core';

export interface CliOutput {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly json: boolean;
}

export function writeResult(output: CliOutput, value: unknown, human: () => string): void {
  output.stdout.write(
    output.json ? `${JSON.stringify(redactValue(value), null, 2)}\n` : `${redactText(human())}\n`,
  );
}

export function writeError(output: CliOutput, error: unknown): NexusError {
  const nexusError = asNexusError(error, {
    code: 'CLI_COMMAND_FAILED',
    component: 'cli',
    severity: 'high',
  });
  if (output.json) {
    output.stderr.write(`${JSON.stringify({ error: nexusError.toJSON() }, null, 2)}\n`);
  } else {
    output.stderr.write(`Error [${nexusError.code}]: ${nexusError.message}\n`);
    output.stderr.write(`Trace: ${nexusError.traceId}\n`);
  }
  return nexusError;
}
