import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import yazl from 'yazl';

export async function createValidSkill(
  parent: string,
  name = 'release-notes',
  options: {
    readonly version?: string | null;
    readonly description?: string;
    readonly body?: string;
    readonly executableScript?: boolean;
  } = {},
): Promise<string> {
  const root = path.join(parent, name);
  await mkdir(path.join(root, 'references'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  const metadataLine =
    options.version === null
      ? ''
      : `metadata:\n  version: ${options.version ?? '1.0.0'}\n  author: Test Author\n`;
  await writeFile(
    path.join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${options.description ?? 'Create accurate release notes. Use when preparing a software release.'}\nlicense: Apache-2.0\n${metadataLine}allowed-tools: Read Grep\n---\n# Instructions\n\n${options.body ?? 'Read [the guide](references/guide.md) before writing release notes.'}\n`,
  );
  await writeFile(path.join(root, 'references', 'guide.md'), '# Guide\n\nBe concise.\n');
  await writeFile(
    path.join(root, 'scripts', 'never-run.sh'),
    '#!/bin/sh\nprintf imported-code-ran\n',
    {
      mode: options.executableScript === false ? 0o600 : 0o700,
    },
  );
  return root;
}

export async function writeZip(
  destination: string,
  entries: readonly {
    readonly name: string;
    readonly data: string | Buffer;
    readonly mode?: number;
    readonly compress?: boolean;
  }[],
): Promise<void> {
  const archive = new yazl.ZipFile();
  for (const entry of entries) {
    archive.addBuffer(
      Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
      entry.name,
      {
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.compress === undefined ? {} : { compress: entry.compress }),
      },
    );
  }
  archive.end();
  const stream = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  archive.outputStream.pipe(stream);
  await finished(stream);
}

export interface RawZipEntry {
  readonly name: string;
  readonly data?: Buffer;
  readonly flags?: number;
  readonly compressionMethod?: number;
  readonly unixMode?: number;
  readonly declaredUncompressedSize?: number;
  readonly declaredCompressedSize?: number;
}

export async function writeRawZip(
  destination: string,
  entries: readonly RawZipEntry[],
): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const flags = entry.flags ?? 0;
    const method = entry.compressionMethod ?? 0;
    const compressedSize = entry.declaredCompressedSize ?? data.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100600) * 65_536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...localParts, ...centralParts, end]), {
    flag: 'wx',
    mode: 0o600,
  });
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
