import { randomBytes } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { failureFromSignal } from "../deadline";
import { ScanFailure } from "../errors";
import type { StreamStorage } from "../types";

/**
 * Bounds the prefix retained for signature detection when the bytes live in a temporary file.
 *
 * Every supported container is identified within its first few bytes, so a small prefix removes the need to read
 * a spooled file back before the format is known.
 */
const HEADER_PREFIX_BYTES = 4096;

/** Sets the entropy of a temporary file name, which is never derived from caller-supplied names. */
const TEMPORARY_NAME_BYTES = 24;

/** Bounds retries when an exclusive create loses to an existing name. */
const TEMPORARY_NAME_ATTEMPTS = 3;

const EMPTY_CHUNK = new Uint8Array(0);

interface CapturedStreamFields {
  /** Provides the leading bytes of the stream for signature detection regardless of storage. */
  header: Uint8Array;
  /** Reports how many bytes actually arrived, independent of anything the producer advertised. */
  size: number;
  /** Removes the scanner-owned temporary file, if any. It is idempotent and never touches caller-supplied paths. */
  cleanup: () => Promise<void>;
}

/**
 * Represents a stream that was accumulated in process memory.
 */
export interface CapturedBytes extends CapturedStreamFields {
  /** Holds the complete received bytes. */
  data: Uint8Array;
  /** Marks the capture as memory-resident. */
  path: null;
}

/**
 * Represents a stream that was written to a scanner-owned temporary file.
 */
export interface CapturedFile extends CapturedStreamFields {
  /** Marks the capture as file-backed. */
  data: null;
  /** Locates the scanner-owned temporary file holding the received bytes. */
  path: string;
}

/**
 * Represents the bytes received from a stream together with where they were stored.
 */
export type CapturedStream = CapturedBytes | CapturedFile;

/**
 * Configures how one streamed input is received, bounded, and stored.
 */
export interface StreamCaptureSettings {
  /** Selects the memory, file, or threshold-driven storage policy. */
  storage: StreamStorage;
  /** Sets the byte count `auto` may hold in memory before migrating to a temporary file. */
  memoryThresholdBytes: number;
  /** Selects the existing directory that receives scanner-owned temporary files. */
  temporaryDirectory: string;
  /** Limits the accepted stream size in bytes. */
  maxFileSizeBytes: number;
  /** Cancels the read and the spooled write when aborted. */
  signal?: AbortSignal;
}

interface TemporarySpool {
  handle: FileHandle;
  path: string;
}

/**
 * Reports whether a value can be consumed as an asynchronous sequence of chunks.
 *
 * @param {unknown} value - The candidate input to inspect.
 * @returns {boolean} `true` when the value exposes an async-iterator factory.
 */
export function isAsyncByteSource(value: unknown): value is AsyncIterable<Uint8Array> {
  if (typeof value !== "object" || value === null) return false;
  const iterable = value as Partial<AsyncIterable<Uint8Array>>;
  return typeof iterable[Symbol.asyncIterator] === "function";
}

function chunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  throw new ScanFailure("INVALID_INPUT", "Every stream chunk must be a Uint8Array or Buffer.");
}

function shouldSpill(settings: StreamCaptureSettings, buffered: number, incoming: number): boolean {
  if (settings.storage === "memory") return false;
  if (settings.storage === "file") return true;
  return buffered + incoming > settings.memoryThresholdBytes;
}

function isNameCollision(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String(error.code) === "EEXIST";
}

/**
 * Creates an exclusive, unpredictably named temporary file inside the configured directory.
 *
 * The name carries no caller-supplied text and the file is opened with `wx`, so an existing entry — including a
 * planted symbolic link — fails the create instead of being followed or overwritten.
 *
 * @param {string} directory - The existing directory that receives the file.
 * @returns {Promise<TemporarySpool>} Resolves with the open handle and its path.
 * @throws {ScanFailure} If the file cannot be created exclusively.
 */
async function createTemporaryFile(directory: string): Promise<TemporarySpool> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const path = join(directory, `cerne-scanner-${randomBytes(TEMPORARY_NAME_BYTES).toString("hex")}.tmp`);
    try {
      return { handle: await open(path, "wx", 0o600), path };
    } catch (error) {
      lastError = error;
      if (!isNameCollision(error)) break;
    }
  }
  throw new ScanFailure("RESOURCE_LIMIT", "The stream could not be buffered into temporary storage.", { cause: lastError });
}

async function writeChunk(spool: TemporarySpool, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await spool.handle.write(bytes, offset, bytes.byteLength - offset));
    } catch (error) {
      throw new ScanFailure("RESOURCE_LIMIT", "The stream could not be buffered into temporary storage.", { cause: error });
    }
    if (bytesWritten <= 0) throw new ScanFailure("RESOURCE_LIMIT", "The stream could not be buffered into temporary storage.");
    offset += bytesWritten;
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Cleanup must not replace the primary result.
  }
}

/**
 * Copies the retained chunks into one exactly sized array, releasing each chunk as it is consumed.
 *
 * @param {Array<Uint8Array>} chunks - The retained chunks, which are emptied in place.
 * @param {number} total - The exact number of received bytes.
 * @returns {Uint8Array} The owned contiguous bytes.
 */
function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? EMPTY_CHUNK;
    data.set(chunk, offset);
    offset += chunk.byteLength;
    chunks[index] = EMPTY_CHUNK;
  }
  return data;
}

/**
 * Receives a caller-supplied stream under an explicit storage policy without outrunning its destination.
 *
 * Chunks are pulled one at a time and each spooled write is awaited before the next chunk is requested, so the
 * producer is throttled by the slower of memory and disk instead of being drained into an unbounded queue. The
 * accepted size is measured from the bytes that actually arrive, never from a length the producer advertises.
 *
 * @param {AsyncIterable<Uint8Array>} source - The `Readable` or async iterable to consume.
 * @param {StreamCaptureSettings} settings - The storage policy, limits, temporary directory, and cancellation signal.
 * @returns {Promise<CapturedStream>} Resolves with the received bytes, their storage, and a cleanup operation.
 * @throws {ScanFailure} If the stream is cancelled, exceeds `maxFileSizeBytes`, yields a non-byte chunk, cannot be read, or cannot be spooled.
 */
export async function captureStream(source: AsyncIterable<Uint8Array>, settings: StreamCaptureSettings): Promise<CapturedStream> {
  const stopped = failureFromSignal(settings.signal);
  if (stopped !== null) throw stopped;

  const readable = source instanceof Readable ? source : null;
  const header = new Uint8Array(HEADER_PREFIX_BYTES);
  const chunks: Uint8Array[] = [];
  let headerLength = 0;
  let buffered = 0;
  let total = 0;
  let spool: TemporarySpool | null = null;
  let closed = false;

  const abortListener = (): void => {
    readable?.destroy();
  };
  settings.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    for await (const chunk of source) {
      const cancelled = failureFromSignal(settings.signal);
      if (cancelled !== null) throw cancelled;
      const bytes = chunkBytes(chunk);
      if (bytes.byteLength === 0) continue;
      if (total + bytes.byteLength > settings.maxFileSizeBytes) throw new ScanFailure("FILE_TOO_LARGE", `The image exceeds the configured ${settings.maxFileSizeBytes}-byte limit.`);
      total += bytes.byteLength;
      if (headerLength < HEADER_PREFIX_BYTES) {
        const copied = Math.min(bytes.byteLength, HEADER_PREFIX_BYTES - headerLength);
        header.set(bytes.subarray(0, copied), headerLength);
        headerLength += copied;
      }

      if (spool === null && shouldSpill(settings, buffered, bytes.byteLength)) {
        spool = await createTemporaryFile(settings.temporaryDirectory);
        for (let index = 0; index < chunks.length; index += 1) {
          await writeChunk(spool, chunks[index] ?? EMPTY_CHUNK);
          chunks[index] = EMPTY_CHUNK;
        }
        chunks.length = 0;
        buffered = 0;
      }

      if (spool === null) {
        chunks.push(bytes);
        buffered += bytes.byteLength;
        continue;
      }

      await writeChunk(spool, bytes);
      const interrupted = failureFromSignal(settings.signal);
      if (interrupted !== null) throw interrupted;
    }

    if (spool === null) {
      const data = joinChunks(chunks, total);
      return { data, path: null, header: data.subarray(0, Math.min(total, HEADER_PREFIX_BYTES)), size: total, cleanup: (): Promise<void> => Promise.resolve() };
    }

    const { path } = spool;
    closed = true;
    await spool.handle.close();
    return { data: null, path, header: header.subarray(0, headerLength), size: total, cleanup: (): Promise<void> => removeTemporaryFile(path) };
  } catch (error) {
    readable?.destroy();
    if (spool !== null) {
      if (!closed) {
        try {
          await spool.handle.close();
        } catch {
          // Cleanup must not replace the primary error.
        }
      }
      await removeTemporaryFile(spool.path);
    }
    if (error instanceof ScanFailure) throw error;
    const cancelled = failureFromSignal(settings.signal);
    if (cancelled !== null) throw cancelled;
    throw new ScanFailure("INVALID_INPUT", "The input stream could not be read.", { cause: error });
  } finally {
    settings.signal?.removeEventListener("abort", abortListener);
  }
}
