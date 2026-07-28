import { readFile, stat } from "node:fs/promises";

import { ScanFailure } from "../errors";
import type { InputImageFormat, ScanInput } from "../types";
import { detectImageFormat } from "./detect-format";

const MAX_REDIRECTS = 5;
const INITIAL_DOWNLOAD_BUFFER_BYTES = 64 * 1024;
const MAX_INITIAL_CONTENT_LENGTH_ALLOCATION = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const WINDOWS_DRIVE_PATH = /^[a-z]:/i;
const HTTP_URL = /^https?:\/\//i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Represents owned image bytes after size and format validation.
 */
export interface LoadedInput {
  /** Stores an owned view of the validated image bytes. */
  data: Uint8Array;
  /** Reports the validated image size in bytes. */
  size: number;
  /** Identifies the image format detected from its byte signature. */
  format: InputImageFormat;
}

/**
 * Configures request metadata and cancellation while loading an image input.
 */
export interface LoadInputControls {
  /** Supplies HTTP(S) headers that are removed after cross-origin or HTTPS-to-HTTP redirects. */
  requestHeaders?: Readonly<Record<string, string>>;
  /** Cancels an in-progress local file read or remote download when aborted. */
  signal?: AbortSignal;
}

function signalFailure(signal: AbortSignal | undefined): ScanFailure | null {
  if (signal?.aborted !== true) return null;
  return signal.reason instanceof ScanFailure ? signal.reason : new ScanFailure("ABORTED", "Scanning was aborted.", { cause: signal.reason });
}

function validateBytes(data: Uint8Array, maxFileSizeBytes: number): InputImageFormat {
  if (data.byteLength === 0) throw new ScanFailure("INVALID_INPUT", "The image input is empty.");
  if (data.byteLength > maxFileSizeBytes) throw new ScanFailure("FILE_TOO_LARGE", `The image exceeds the configured ${maxFileSizeBytes}-byte limit.`);
  const format = detectImageFormat(data);
  if (format === null) throw new ScanFailure("UNSUPPORTED_FORMAT", "The input bytes do not match a supported JPEG, PNG, WebP, TIFF, AVIF, or HEIF signature.");
  return format;
}

function checkedBytes(data: Uint8Array, maxFileSizeBytes: number, copy: boolean): LoadedInput {
  const format = validateBytes(data, maxFileSizeBytes);
  if (!copy) return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), size: data.byteLength, format };
  const owned = new Uint8Array(data.byteLength);
  owned.set(data);
  return { data: owned, size: owned.byteLength, format };
}

function remoteUrlFromInput(input: string): URL | null {
  const value = input.trim();
  if (value === "") throw new ScanFailure("INVALID_INPUT", "A non-empty image path or HTTP(S) URL is required.");
  if (WINDOWS_DRIVE_PATH.test(value)) return null;
  if (!HTTP_URL.test(value)) {
    if (URI_SCHEME.test(value)) throw new ScanFailure("INVALID_INPUT", "Only complete HTTP and HTTPS remote URLs are accepted.");
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ScanFailure("INVALID_INPUT", "The remote URL is invalid.", { cause: error });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new ScanFailure("INVALID_INPUT", "Only credential-free HTTP and HTTPS URLs are accepted; use requestHeaders for authorization.");
  }
  return url;
}

function remoteHeaders(requestHeaders: Readonly<Record<string, string>> | undefined): Headers {
  const headers = new Headers(requestHeaders === undefined ? undefined : Object.entries(requestHeaders));
  headers.set("accept-encoding", "identity");
  return headers;
}

function stripCallerHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) headers.delete(name);
  headers.set("accept-encoding", "identity");
}

function advertisedSize(response: Response): bigint | null {
  const value = response.headers.get("content-length")?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the primary result.
  }
}

async function readRemoteBody(response: Response, maxFileSizeBytes: number, signal: AbortSignal | undefined): Promise<LoadedInput> {
  const declared = advertisedSize(response);
  if (declared !== null && declared > BigInt(maxFileSizeBytes)) {
    await cancelResponseBody(response);
    throw new ScanFailure("FILE_TOO_LARGE", `The image exceeds the configured ${maxFileSizeBytes}-byte limit.`);
  }
  if (response.body === null) throw new ScanFailure("DOWNLOAD_ERROR", "The remote image response did not contain a body.");

  const body = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let complete = false;
  try {
    const initialSize = Math.min(maxFileSizeBytes, declared === null ? INITIAL_DOWNLOAD_BUFFER_BYTES : Math.min(Number(declared), MAX_INITIAL_CONTENT_LENGTH_ALLOCATION));
    let data = new Uint8Array(initialSize);
    reader = body.getReader();
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value === undefined) continue;
      const required = total + chunk.value.byteLength;
      if (required > maxFileSizeBytes) {
        throw new ScanFailure("FILE_TOO_LARGE", `The image exceeds the configured ${maxFileSizeBytes}-byte limit.`);
      }
      if (required > data.byteLength) {
        const expanded = new Uint8Array(Math.min(maxFileSizeBytes, Math.max(required, data.byteLength === 0 ? INITIAL_DOWNLOAD_BUFFER_BYTES : data.byteLength * 2)));
        expanded.set(data.subarray(0, total));
        data = expanded;
      }
      data.set(chunk.value, total);
      total = required;
    }
    const loaded = checkedBytes(data.subarray(0, total), maxFileSizeBytes, false);
    complete = true;
    return loaded;
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    const stopped = signalFailure(signal);
    if (stopped !== null) throw stopped;
    throw new ScanFailure("DOWNLOAD_ERROR", "The remote image response could not be read.", { cause: error });
  } finally {
    if (!complete) {
      try {
        if (reader === null) await body.cancel();
        else await reader.cancel();
      } catch {
        // Cleanup must not replace the primary result.
      }
    }
    try {
      reader?.releaseLock();
    } catch {
      // Cleanup must not replace the primary result.
    }
  }
}

async function downloadImage(initialUrl: URL, maxFileSizeBytes: number, controls: LoadInputControls): Promise<LoadedInput> {
  let currentUrl = initialUrl;
  const headers = remoteHeaders(controls.requestHeaders);
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, { method: "GET", headers, redirect: "manual", ...(controls.signal === undefined ? {} : { signal: controls.signal }) });
    } catch (error) {
      const stopped = signalFailure(controls.signal);
      if (stopped !== null) throw stopped;
      throw new ScanFailure("DOWNLOAD_ERROR", "The remote image could not be downloaded.", { cause: error });
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (redirects >= MAX_REDIRECTS) throw new ScanFailure("DOWNLOAD_ERROR", `The remote image exceeded the ${MAX_REDIRECTS}-redirect limit.`);
      if (location === null) throw new ScanFailure("DOWNLOAD_ERROR", "The remote image returned a redirect without a destination.");
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch (error) {
        throw new ScanFailure("DOWNLOAD_ERROR", "The remote image returned an invalid redirect destination.", { cause: error });
      }
      if ((nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") || nextUrl.username !== "" || nextUrl.password !== "") throw new ScanFailure("DOWNLOAD_ERROR", "The remote image redirected to an unsupported destination.");
      if (nextUrl.origin !== currentUrl.origin || (currentUrl.protocol === "https:" && nextUrl.protocol === "http:")) stripCallerHeaders(headers);
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) {
      const status = response.status;
      await cancelResponseBody(response);
      throw new ScanFailure("DOWNLOAD_ERROR", `The remote image request returned HTTP status ${status}.`);
    }
    return readRemoteBody(response, maxFileSizeBytes, controls.signal);
  }
}

/**
 * Loads, owns, and validates image bytes from memory, a local path, or an
 * HTTP(S) URL before image decoding begins.
 *
 * @param {ScanInput} input - The in-memory bytes, local path, or HTTP(S) URL to load.
 * @param {number} maxFileSizeBytes - The maximum accepted image size in bytes.
 * @param {LoadInputControls} [controls={}] - Optional request headers and cancellation signal.
 * @param {Readonly<Record<string, string>>} [controls.requestHeaders] - Caller headers for HTTP(S) requests.
 * @param {AbortSignal} [controls.signal] - Cancellation signal for file reads and remote downloads.
 * @returns {Promise<LoadedInput>} Resolves with owned bytes, their size, and the detected format.
 * @throws {ScanFailure} If the input, request controls, image format, file access, download, cancellation, or size is invalid.
 * @throws {TypeError} If request headers are invalid or the supplied `ArrayBuffer` has been detached.
 * @throws {RangeError} If an in-memory input cannot be copied within available memory.
 *
 * @example
 * const abortController = new AbortController();
 * const loaded = await loadInput("https://example.com/document.webp", 40 * 1024 * 1024, {
 *   requestHeaders: { authorization: "Bearer token" },
 *   signal: abortController.signal,
 * });
 */
export async function loadInput(input: ScanInput, maxFileSizeBytes: number, controls: LoadInputControls = {}): Promise<LoadedInput> {
  if (typeof input === "string") {
    const remoteUrl = remoteUrlFromInput(input);
    if (remoteUrl !== null) return downloadImage(remoteUrl, maxFileSizeBytes, controls);
    if (controls.requestHeaders !== undefined) throw new ScanFailure("INVALID_OPTIONS", "requestHeaders can only be used with an HTTP(S) URL input.");
    try {
      const file = await stat(input);
      if (!file.isFile()) throw new ScanFailure("INVALID_INPUT", "The supplied path is not a file.");
      if (file.size > maxFileSizeBytes) throw new ScanFailure("FILE_TOO_LARGE", `The image exceeds the configured ${maxFileSizeBytes}-byte limit.`);
      return checkedBytes(await readFile(input, { signal: controls.signal }), maxFileSizeBytes, false);
    } catch (error) {
      if (error instanceof ScanFailure) throw error;
      const stopped = signalFailure(controls.signal);
      if (stopped !== null) throw stopped;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") throw new ScanFailure("FILE_NOT_FOUND", "The image file was not found.", { cause: error });
      throw new ScanFailure("INVALID_INPUT", "The image file could not be read.", { cause: error });
    }
  }

  if (controls.requestHeaders !== undefined) throw new ScanFailure("INVALID_OPTIONS", "requestHeaders can only be used with an HTTP(S) URL input.");
  if (input instanceof Uint8Array) return checkedBytes(input, maxFileSizeBytes, true);
  if (input instanceof ArrayBuffer) return checkedBytes(new Uint8Array(input), maxFileSizeBytes, true);
  throw new ScanFailure("INVALID_INPUT", "Input must be a local path, HTTP(S) URL, ArrayBuffer, Buffer, or Uint8Array.");
}
