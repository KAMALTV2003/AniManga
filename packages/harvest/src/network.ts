import { constants as fsConstants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { NexusError } from '@nexus-ai/core';
import ipaddr from 'ipaddr.js';

import { validateHarvestLimits, type HarvestLimits } from './types.js';

const ALLOWED_ARCHIVE_MEDIA_TYPES = new Set([
  'application/zip',
  'application/octet-stream',
  'application/x-zip-compressed',
]);
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface ValidatedRemote {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
}

export interface DownloadedArchive {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly connectedAddress: string;
}

export async function validatePublicHttpsUrl(
  input: string,
  allowedHosts: readonly string[] = [],
  dnsTimeoutMs = 10_000,
): Promise<ValidatedRemote> {
  if (!Number.isSafeInteger(dnsTimeoutMs) || dnsTimeoutMs < 1) {
    throw new RangeError('DNS timeout must be a positive safe integer');
  }
  if (Buffer.byteLength(input, 'utf8') > 8_192) {
    throw networkError('HARVEST_URL_LIMIT', 'Source URL exceeds 8192 UTF-8 bytes');
  }
  if (allowedHosts.length > 100) {
    throw networkError('HARVEST_HOST_LIMIT', 'Remote host allowlist exceeds 100 entries');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw networkError('HARVEST_URL_INVALID', 'Source URL is not valid', error);
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw networkError(
      'HARVEST_URL_POLICY',
      'Remote sources require credential-free HTTPS on port 443 without a query or fragment',
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname.length === 0 || hostname.length > 253) {
    throw networkError('HARVEST_HOST_INVALID', 'Remote source hostname is invalid');
  }
  const normalizedAllowedHosts = allowedHosts.map(normalizeHostname);
  if (normalizedAllowedHosts.length > 0 && !normalizedAllowedHosts.includes(hostname)) {
    throw networkError('HARVEST_HOST_NOT_ALLOWED', `Remote host is not allowlisted: ${hostname}`);
  }

  const literalFamily = ipaddr.isValid(hostname) ? ipaddr.parse(hostname).kind() : null;
  const resolved =
    literalFamily === null
      ? await withTimeout(
          lookup(hostname, { all: true, verbatim: true }),
          dnsTimeoutMs,
          'HARVEST_DNS_TIMEOUT',
          'Remote hostname resolution timed out',
        ).catch((error: unknown) => {
          if (error instanceof NexusError) throw error;
          throw networkError(
            'HARVEST_DNS_FAILED',
            `Could not resolve remote host: ${hostname}`,
            error,
          );
        })
      : [{ address: hostname, family: literalFamily === 'ipv4' ? 4 : 6 } as const];
  if (resolved.length === 0) {
    throw networkError('HARVEST_DNS_FAILED', `Remote host has no addresses: ${hostname}`);
  }
  if (resolved.length > 100) {
    throw networkError('HARVEST_DNS_LIMIT', 'Remote host resolved to more than 100 addresses');
  }

  const addresses = resolved.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
  for (const record of addresses) {
    if (!isPublicAddress(record.address)) {
      throw networkError(
        'HARVEST_SSRF_BLOCKED',
        `Remote host resolved to a non-public address: ${hostname}`,
      );
    }
  }
  return { url, hostname, addresses };
}

export async function downloadArchive(
  remote: ValidatedRemote,
  destination: string,
  limits: HarvestLimits,
): Promise<DownloadedArchive> {
  validateHarvestLimits(limits);
  assertValidatedRemote(remote);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const selected = remote.addresses[0];
  if (selected === undefined) {
    throw networkError('HARVEST_DNS_FAILED', 'Validated remote has no address');
  }

  const selectedAddress = selected.address;
  return await new Promise<DownloadedArchive>((resolve, reject) => {
    const complete = <T>(callback: (value: T) => void, value: T): void => {
      clearTimeout(deadline);
      callback(value);
    };
    const request = https.request(
      {
        protocol: 'https:',
        hostname: selectedAddress,
        port: 443,
        method: 'GET',
        path: remote.url.pathname,
        ...(ipaddr.isValid(remote.hostname) ? {} : { servername: remote.hostname }),
        rejectUnauthorized: true,
        agent: false,
        headers: {
          Accept: 'application/zip, application/octet-stream;q=0.8',
          Host: remote.hostname.includes(':') ? `[${remote.hostname}]` : remote.hostname,
          'User-Agent': 'NEXUS-AI-Harvester/0.1',
        },
      },
      (response) => {
        void consumeResponse(response).then(
          (result) => complete(resolve, result),
          (error: unknown) => complete(reject, error),
        );
      },
    );
    request.once('error', (error) =>
      complete(
        reject,
        error instanceof NexusError
          ? error
          : networkError('HARVEST_DOWNLOAD_FAILED', error.message, error),
      ),
    );
    const timeoutError = (): NexusError =>
      networkError('HARVEST_DOWNLOAD_TIMEOUT', 'Remote archive download timed out');
    request.setTimeout(limits.networkTimeoutMs, () => request.destroy(timeoutError()));
    const deadline = setTimeout(() => request.destroy(timeoutError()), limits.networkTimeoutMs);
    deadline.unref();
    request.end();
  });

  async function consumeResponse(response: IncomingMessage): Promise<DownloadedArchive> {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      throw networkError(
        'HARVEST_REDIRECT_BLOCKED',
        'Remote redirects are disabled for source acquisition',
      );
    }
    if (status !== 200) {
      response.resume();
      throw networkError('HARVEST_HTTP_STATUS', `Remote archive returned HTTP ${String(status)}`);
    }
    const mediaType = String(response.headers['content-type'] ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType === undefined || !ALLOWED_ARCHIVE_MEDIA_TYPES.has(mediaType)) {
      response.resume();
      throw networkError('HARVEST_MEDIA_TYPE', 'Remote source is not an allowed ZIP media type');
    }
    const encoding = response.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'identity') {
      response.resume();
      throw networkError(
        'HARVEST_CONTENT_ENCODING',
        'Compressed HTTP content encoding is not allowed',
      );
    }
    const declaredLength = Number(response.headers['content-length'] ?? 0);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > limits.maxDownloadBytes
    ) {
      response.resume();
      throw networkError('HARVEST_DOWNLOAD_LIMIT', 'Remote archive exceeds its download limit');
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(
        destination,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o400,
      );
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of response as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > limits.maxDownloadBytes) {
          throw networkError(
            'HARVEST_DOWNLOAD_LIMIT',
            'Remote archive exceeded its download limit',
          );
        }
        hash.update(buffer);
        await writeFully(handle, buffer);
      }
      if (declaredLength > 0 && bytes !== declaredLength) {
        throw networkError(
          'HARVEST_DOWNLOAD_TRUNCATED',
          'Remote archive length did not match its declaration',
        );
      }
      await handle.sync();
      return {
        path: destination,
        sha256: hash.digest('hex'),
        bytes,
        mediaType,
        connectedAddress: selectedAddress,
      };
    } finally {
      await handle?.close();
    }
  }
}

export function gitCurlResolve(remote: ValidatedRemote): string {
  assertValidatedRemote(remote);
  const addresses = remote.addresses
    .map((record) => (record.family === 6 ? `[${record.address}]` : record.address))
    .join(',');
  const hostname = remote.hostname.includes(':') ? `[${remote.hostname}]` : remote.hostname;
  return `+${hostname}:443:${addresses}`;
}

function assertValidatedRemote(remote: ValidatedRemote): void {
  if (
    remote.url.protocol !== 'https:' ||
    remote.url.username !== '' ||
    remote.url.password !== '' ||
    remote.url.search !== '' ||
    remote.url.hash !== '' ||
    (remote.url.port !== '' && remote.url.port !== '443') ||
    normalizeHostname(remote.url.hostname) !== remote.hostname ||
    remote.addresses.length === 0 ||
    remote.addresses.length > 100 ||
    remote.addresses.some(
      (record) =>
        !ipaddr.isValid(record.address) ||
        (ipaddr.parse(record.address).kind() === 'ipv4' ? 4 : 6) !== record.family ||
        !isPublicAddress(record.address),
    )
  ) {
    throw networkError('HARVEST_REMOTE_INVALID', 'Remote validation evidence is invalid');
  }
}

function isPublicAddress(value: string): boolean {
  const address = ipaddr.parse(value);
  if (address.kind() === 'ipv6') {
    const ipv6 = address as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() === 'unicast';
  }
  return address.range() === 'unicast';
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase();
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) {
      throw networkError(
        'HARVEST_DOWNLOAD_WRITE_FAILED',
        'Archive download made no write progress',
      );
    }
    offset += bytesWritten;
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(networkError(code, message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function networkError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({
    code,
    component: 'harvest.network',
    severity: 'high',
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}
