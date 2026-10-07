import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export async function readBoundedJsonFile(
  startDir: string,
  filePath: string,
  label: string,
  maximumBytes = 1_000_000,
): Promise<unknown> {
  const absolute = path.resolve(startDir, filePath);
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new RangeError(
        `${label} must be a real JSON file no larger than ${maximumBytes} bytes`,
      );
    }
    const bounded = Buffer.allocUnsafe(maximumBytes + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
    const after = await handle.stat();
    if (bytesRead > maximumBytes) {
      throw new RangeError(`${label} exceeded the ${maximumBytes}-byte read limit`);
    }
    if (before.size !== after.size || bytesRead !== before.size) {
      throw new Error(`${label} changed while being read`);
    }
    bytes = bounded.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new SyntaxError(`${label} is not valid JSON: ${String(error)}`, { cause: error });
  }
}
