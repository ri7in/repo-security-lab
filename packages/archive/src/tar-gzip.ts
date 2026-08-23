import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const IO_CHUNK_BYTES = 64 * 1_024;
const PAX_METADATA_BYTES = 64 * 1_024;
const RATIO_ALLOWANCE_BYTES = 2 * 1_024 * 1_024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface ArchiveLimits {
  readonly compressedBytes: number;
  readonly extractedBytes: number;
  readonly individualFileBytes: number;
  readonly entries: number;
  readonly compressionRatio: number;
  readonly pathBytes: number;
  readonly pathDepth: number;
  readonly paxBytes: number;
}

/**
 * Sized against the free GitHub Actions runner that does the scanning: 7 GB of
 * RAM, 14 GB of disk, one repository unpacked at a time, and extraction that
 * streams rather than buffering. The old ceilings were a private-preview
 * caution and refused ordinary projects, which read to a visitor as a broken
 * tool rather than a deliberate limit.
 *
 * The compression ratio, path and depth ceilings deliberately do NOT move.
 * Those defend against archive bombs and traversal, and they are unrelated to
 * how large an honest repository is.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  compressedBytes: 250 * 1_024 * 1_024,
  extractedBytes: 1_024 * 1_024 * 1_024,
  individualFileBytes: 50 * 1_024 * 1_024,
  entries: 200_000,
  compressionRatio: 200,
  pathBytes: 4_096,
  pathDepth: 32,
  paxBytes: PAX_METADATA_BYTES,
});

export const ARCHIVE_ERROR_CODES = [
  "ARCHIVE_LIMIT",
  "ARCHIVE_UNSAFE",
  "ARCHIVE_INVALID",
] as const;

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number];

/** Fixed non-echoing failure: archive paths and parser text never escape. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(code: ArchiveErrorCode) {
    super(code);
    this.name = "ArchiveError";
    this.code = code;
  }
}

export interface ArchiveExtractionReport {
  readonly compressedBytes: number;
  readonly inflatedBytes: number;
  readonly extractedBytes: number;
  readonly entryCount: number;
  readonly regularFileCount: number;
  readonly directoryCount: number;
}

interface MutableCounters {
  compressedBytes: number;
  inflatedBytes: number;
  extractedBytes: number;
  entryCount: number;
  regularFileCount: number;
  directoryCount: number;
}

interface TarHeader {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

interface PaxOverrides {
  readonly path?: string;
  readonly size?: number;
}

class AsyncByteReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #chunk: Buffer | null = null;
  #offset = 0;
  #ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(length: number, allowCleanEof = false): Promise<Buffer | null> {
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = await this.#readSome(length - written);
      if (chunk === null) {
        if (written === 0 && allowCleanEof) return null;
        throw new ArchiveError("ARCHIVE_INVALID");
      }
      chunk.copy(output, written);
      written += chunk.length;
    }
    return output;
  }

  async ensureRemainingZeros(): Promise<void> {
    while (true) {
      const chunk = await this.#readSome(IO_CHUNK_BYTES);
      if (chunk === null) return;
      if (chunk.some((byte) => byte !== 0)) {
        throw new ArchiveError("ARCHIVE_INVALID");
      }
    }
  }

  async #readSome(maximum: number): Promise<Buffer | null> {
    while (!this.#ended) {
      if (this.#chunk !== null && this.#offset < this.#chunk.length) {
        const end = Math.min(this.#chunk.length, this.#offset + maximum);
        const result = this.#chunk.subarray(this.#offset, end);
        this.#offset = end;
        return result;
      }
      const next = await this.#iterator.next();
      if (next.done) {
        this.#ended = true;
        return null;
      }
      this.#chunk = next.value;
      this.#offset = 0;
    }
    return null;
  }
}

function resolvedLimits(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  const result = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_ARCHIVE_LIMITS) as Array<
    keyof ArchiveLimits
  >) {
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] < 1 ||
      result[key] > DEFAULT_ARCHIVE_LIMITS[key]
    ) {
      throw new Error("invalid archive limit configuration");
    }
  }
  return result;
}

function parseOctal(field: Buffer): number {
  if ((field[0] ?? 0) >= 0x80) throw new ArchiveError("ARCHIVE_INVALID");
  const nul = field.indexOf(0);
  const text = field
    .subarray(0, nul === -1 ? field.length : nul)
    .toString("ascii")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError("ARCHIVE_INVALID");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new ArchiveError("ARCHIVE_INVALID");
  return value;
}

function decodeTarField(field: Buffer): string {
  const nul = field.indexOf(0);
  const bytes = field.subarray(0, nul === -1 ? field.length : nul);
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new ArchiveError("ARCHIVE_INVALID");
  }
}

function parseHeader(block: Buffer): TarHeader {
  const expectedChecksum = parseOctal(block.subarray(148, 156));
  let checksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  if (checksum !== expectedChecksum) {
    throw new ArchiveError("ARCHIVE_INVALID");
  }
  const name = decodeTarField(block.subarray(0, 100));
  const prefix = decodeTarField(block.subarray(345, 500));
  const typeByte = block[156] ?? 0;
  return {
    name: prefix === "" ? name : `${prefix}/${name}`,
    size: parseOctal(block.subarray(124, 136)),
    type: typeByte === 0 ? "0" : String.fromCharCode(typeByte),
  };
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function paddingFor(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function parsePax(data: Buffer, global: boolean): PaxOverrides {
  const seen = new Set<string>();
  let offset = 0;
  let pathOverride: string | undefined;
  let sizeOverride: number | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new ArchiveError("ARCHIVE_INVALID");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/.test(lengthText)) {
      throw new ArchiveError("ARCHIVE_INVALID");
    }
    const recordLength = Number(lengthText);
    if (
      !Number.isSafeInteger(recordLength) ||
      recordLength < space - offset + 4 ||
      offset + recordLength > data.length
    ) {
      throw new ArchiveError("ARCHIVE_INVALID");
    }
    const record = data.subarray(space + 1, offset + recordLength);
    if (record.at(-1) !== 0x0a) throw new ArchiveError("ARCHIVE_INVALID");
    let text: string;
    try {
      text = textDecoder.decode(record.subarray(0, -1));
    } catch {
      throw new ArchiveError("ARCHIVE_INVALID");
    }
    const equals = text.indexOf("=");
    if (equals < 1) throw new ArchiveError("ARCHIVE_INVALID");
    const key = text.slice(0, equals);
    const value = text.slice(equals + 1);
    if (
      !/^[A-Za-z0-9_.-]+$/.test(key) ||
      seen.has(key) ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      key.toLowerCase().includes("sparse") ||
      key === "linkpath" ||
      key === "hdrcharset"
    ) {
      throw new ArchiveError("ARCHIVE_UNSAFE");
    }
    seen.add(key);
    if (key === "path") {
      if (global) throw new ArchiveError("ARCHIVE_UNSAFE");
      pathOverride = value;
    } else if (key === "size") {
      if (global || !/^\d+$/.test(value)) {
        throw new ArchiveError("ARCHIVE_UNSAFE");
      }
      const size = Number(value);
      if (!Number.isSafeInteger(size)) {
        throw new ArchiveError("ARCHIVE_LIMIT");
      }
      sizeOverride = size;
    }
    offset += recordLength;
  }
  return {
    ...(pathOverride === undefined ? {} : { path: pathOverride }),
    ...(sizeOverride === undefined ? {} : { size: sizeOverride }),
  };
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safeRelativePath(
  raw: string,
  directory: boolean,
  limits: ArchiveLimits,
): { readonly value: string; readonly collisionKey: string } {
  const value = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = value.split("/");
  if (
    value === "" ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > limits.pathBytes ||
    segments.length > limits.pathDepth ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED.test(segment),
    )
  ) {
    throw new ArchiveError("ARCHIVE_UNSAFE");
  }
  return { value, collisionKey: value.toLocaleLowerCase("en-US") };
}

async function ensurePrivateParents(root: string, relative: string): Promise<void> {
  const parent = path.dirname(relative);
  if (parent === ".") return;
  let current = root;
  for (const segment of parent.split("/")) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error;
    }
  }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.write(data, offset, data.length - offset, null);
    if (result.bytesWritten < 1) throw new ArchiveError("ARCHIVE_INVALID");
    offset += result.bytesWritten;
  }
}

async function extractRegularFile(
  reader: AsyncByteReader,
  root: string,
  relative: string,
  size: number,
): Promise<void> {
  await ensurePrivateParents(root, relative);
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${root}${path.sep}`)) {
    throw new ArchiveError("ARCHIVE_UNSAFE");
  }
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    let remaining = size;
    while (remaining > 0) {
      const chunk = await reader.readExactly(Math.min(remaining, IO_CHUNK_BYTES));
      if (chunk === null) throw new ArchiveError("ARCHIVE_INVALID");
      await writeAll(handle, chunk);
      remaining -= chunk.length;
    }
  } finally {
    await handle?.close();
  }
}

async function skipPadding(reader: AsyncByteReader, size: number): Promise<void> {
  const padding = paddingFor(size);
  if (padding === 0) return;
  const bytes = await reader.readExactly(padding);
  if (bytes === null || bytes.some((byte) => byte !== 0)) {
    throw new ArchiveError("ARCHIVE_INVALID");
  }
}

export async function extractTarGzip(
  source: AsyncIterable<Uint8Array>,
  destination: string,
  limitOverrides: Partial<ArchiveLimits> = {},
): Promise<ArchiveExtractionReport> {
  const limits = resolvedLimits(limitOverrides);
  const root = path.resolve(destination);
  const counters: MutableCounters = {
    compressedBytes: 0,
    inflatedBytes: 0,
    extractedBytes: 0,
    entryCount: 0,
    regularFileCount: 0,
    directoryCount: 0,
  };
  const collisionKeys = new Set<string>();
  const pathSpellings = new Map<string, string>();
  const inflatedLimit =
    limits.extractedBytes +
    limits.entries * TAR_BLOCK_BYTES * 2 +
    limits.paxBytes +
    TAR_BLOCK_BYTES * 2;
  let input: Readable | null = null;
  let rootCreated = false;
  const gunzip = createGunzip();

  async function* countedCompressed(): AsyncIterable<Buffer> {
    for await (const value of source) {
      const chunk = Buffer.from(value);
      counters.compressedBytes += chunk.length;
      if (counters.compressedBytes > limits.compressedBytes) {
        throw new ArchiveError("ARCHIVE_LIMIT");
      }
      yield chunk;
    }
  }

  async function* countedInflated(): AsyncIterable<Buffer> {
    for await (const value of gunzip) {
      const chunk = Buffer.from(value as Uint8Array);
      counters.inflatedBytes += chunk.length;
      if (
        counters.inflatedBytes > inflatedLimit ||
        (counters.inflatedBytes > RATIO_ALLOWANCE_BYTES &&
          counters.inflatedBytes >
            counters.compressedBytes * limits.compressionRatio +
              RATIO_ALLOWANCE_BYTES)
      ) {
        throw new ArchiveError("ARCHIVE_LIMIT");
      }
      yield chunk;
    }
  }

  try {
    await mkdir(root, { mode: 0o700 });
    rootCreated = true;
    input = Readable.from(countedCompressed());
    input.on("error", (error) => gunzip.destroy(error));
    input.pipe(gunzip);
    const reader = new AsyncByteReader(countedInflated());
    let pendingPax: PaxOverrides | null = null;

    while (true) {
      const block = await reader.readExactly(TAR_BLOCK_BYTES, true);
      if (block === null || isZeroBlock(block)) {
        if (block === null) throw new ArchiveError("ARCHIVE_INVALID");
        const second = await reader.readExactly(TAR_BLOCK_BYTES);
        if (second === null || !isZeroBlock(second) || pendingPax !== null) {
          throw new ArchiveError("ARCHIVE_INVALID");
        }
        await reader.ensureRemainingZeros();
        break;
      }

      counters.entryCount += 1;
      if (counters.entryCount > limits.entries) {
        throw new ArchiveError("ARCHIVE_LIMIT");
      }
      const header = parseHeader(block);
      if (header.type === "x" || header.type === "g") {
        if (pendingPax !== null || header.size > limits.paxBytes) {
          throw new ArchiveError(
            header.size > limits.paxBytes ? "ARCHIVE_LIMIT" : "ARCHIVE_INVALID",
          );
        }
        safeRelativePath(header.name, false, limits);
        const data = await reader.readExactly(header.size);
        if (data === null) throw new ArchiveError("ARCHIVE_INVALID");
        const parsed = parsePax(data, header.type === "g");
        if (header.type === "x") pendingPax = parsed;
        await skipPadding(reader, header.size);
        continue;
      }

      if (header.type !== "0" && header.type !== "5") {
        throw new ArchiveError("ARCHIVE_UNSAFE");
      }
      const size = pendingPax?.size ?? header.size;
      const rawName = pendingPax?.path ?? header.name;
      pendingPax = null;
      const directory = header.type === "5";
      const safePath = safeRelativePath(rawName, directory, limits);
      const segments = safePath.value.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        const spelling = segments.slice(0, index).join("/");
        const key = spelling.toLocaleLowerCase("en-US");
        const existing = pathSpellings.get(key);
        if (existing !== undefined && existing !== spelling) {
          throw new ArchiveError("ARCHIVE_UNSAFE");
        }
        pathSpellings.set(key, spelling);
      }
      if (collisionKeys.has(safePath.collisionKey)) {
        throw new ArchiveError("ARCHIVE_UNSAFE");
      }
      collisionKeys.add(safePath.collisionKey);

      if (directory) {
        if (size !== 0) throw new ArchiveError("ARCHIVE_INVALID");
        await ensurePrivateParents(root, `${safePath.value}/placeholder`);
        const directoryPath = path.resolve(root, safePath.value);
        try {
          await mkdir(directoryPath, { mode: 0o700 });
        } catch {
          const metadata = await lstat(directoryPath);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new ArchiveError("ARCHIVE_UNSAFE");
          }
        }
        counters.directoryCount += 1;
      } else {
        if (size > limits.individualFileBytes) {
          throw new ArchiveError("ARCHIVE_LIMIT");
        }
        counters.extractedBytes += size;
        if (counters.extractedBytes > limits.extractedBytes) {
          throw new ArchiveError("ARCHIVE_LIMIT");
        }
        await extractRegularFile(reader, root, safePath.value, size);
        counters.regularFileCount += 1;
      }
      await skipPadding(reader, size);
    }

    if (counters.compressedBytes === 0) {
      throw new ArchiveError("ARCHIVE_INVALID");
    }
    return { ...counters };
  } catch (error) {
    if (rootCreated) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("ARCHIVE_INVALID");
  } finally {
    input?.destroy();
    gunzip.destroy();
  }
}
