import { validateHeaderName, validateHeaderValue } from "node:http";

import type { DetectOptions, DocumentCorners, EnhancementMode, OutputEncoding, OutputFormat, PaperSize, PerformanceProfile, ScanOptions } from "./types";

const MEBIBYTE = 1024 * 1024;
const BLOCKED_REQUEST_HEADERS = new Set(["accept-encoding", "connection", "content-length", "expect", "host", "if-range", "keep-alive", "proxy-connection", "range", "te", "trailer", "transfer-encoding", "upgrade"]);

interface ProfileDefaults {
  detectionMaxDimension: number;
  maxInputPixels: number;
  maxOutputPixels: number;
  timeoutMs: number;
}

/**
 * Bounds the corrected raster, which is what actually sizes the process.
 *
 * The output canvas is allocated twice at full size — once as an OpenCV matrix
 * in the WebAssembly heap and once as the copy handed to encoding — so every
 * megapixel here costs eight megabytes of peak memory. Since that heap only
 * ever grows, a single oversized scan raises the floor of a long-lived process
 * for good, which makes a generous default expensive in a way that never shows
 * up in a one-shot command.
 *
 * The defaults are therefore expressed in scanning terms rather than camera
 * terms: eight megapixels is an A4 page at roughly 300 DPI, the resolution
 * document capture and OCR are specified against, and no sheet of paper carries
 * detail beyond it. Callers that genuinely need a larger raster can still raise
 * `maxOutputPixels` per scan.
 */
const PROFILE_DEFAULTS: Record<PerformanceProfile, ProfileDefaults> = {
  fast: { detectionMaxDimension: 960, maxInputPixels: 60_000_000, maxOutputPixels: 4_000_000, timeoutMs: 20_000 },
  balanced: { detectionMaxDimension: 1440, maxInputPixels: 100_000_000, maxOutputPixels: 8_000_000, timeoutMs: 60_000 },
  accurate: { detectionMaxDimension: 2048, maxInputPixels: 160_000_000, maxOutputPixels: 16_000_000, timeoutMs: 120_000 },
};

/**
 * Represents validated scanner settings after operation and performance-profile defaults are applied.
 */
export interface ResolvedOptions {
  /** Selects the processing profile, which defaults to `balanced`. */
  performance: PerformanceProfile;
  /** Selects the output container, which defaults to `png`. */
  format: OutputFormat;
  /** Selects the output representation, which defaults to `buffer`. */
  encoding: OutputEncoding;
  /** Sets the integer JPEG, WebP, or PDF raster quality from 1 through 100, defaulting to 92. */
  quality: number;
  /** Selects the enhancement mode, defaulting to `color` for scans and `none` for detection. */
  enhancement: EnhancementMode;
  /** Selects the output aspect-ratio policy, which defaults to `detected`. */
  paperSize: PaperSize;
  /** Supplies finite corners in EXIF-oriented source-image coordinates when manual detection is requested. */
  manualCorners?: DocumentCorners;
  /** Sets the accepted confidence threshold from zero through one, defaulting to 0.58. */
  minConfidence: number;
  /** Sets the minimum document-to-image area ratio for automatic detection from 0.02 through 0.95, defaulting to 0.12. */
  minDocumentAreaRatio: number;
  /** Sets the smallest image share an automatic boundary must enclose to be reported as `success` instead of `partial`, from zero through 0.95 and defaulting to 0.20. */
  minSuccessAreaRatio: number;
  /** Expands selected corners before scan output transformation by a ratio from zero through 0.05, defaulting to 0.003; detection-only operations do not apply it. */
  paddingRatio: number;
  /** Controls whether the full image frame may be returned as a partial detection, defaulting to `true`. */
  allowFrameFallback: boolean;
  /** Limits the automatic-detection raster's longest axis from 320 through 4,096 pixels, defaulting to 960 for `fast`, 1,440 for `balanced`, and 2,048 for `accurate`; manual detection does not decode this raster. */
  detectionMaxDimension: number;
  /** Limits input size from one byte through 1 GiB, defaulting to 40 MiB; this bounds transfer and storage, not memory, because a small file may still decode to a very large raster. */
  maxFileSizeBytes: number;
  /** Limits the validated EXIF-oriented source-image area before raster decoding from 250,000 through 250,000,000 pixels, defaulting to 60 million for `fast`, 100 million for `balanced`, and 160 million for `accurate`. */
  maxInputPixels: number;
  /** Limits output area from 250,000 through 100,000,000 pixels, defaulting to 4 million for `fast`, 8 million for `balanced`, and 16 million for `accurate`; this is the dominant control over peak memory. */
  maxOutputPixels: number;
  /** Limits processing to 0 through 3,600,000 milliseconds, defaulting to 20 seconds for `fast`, 60 seconds for `balanced`, and 120 seconds for `accurate`; zero disables the deadline. */
  timeoutMs: number;
  /** Stores validated, lowercased, and frozen headers for HTTP(S) image requests. */
  requestHeaders?: Readonly<Record<string, string>>;
  /** Preserves the caller's cancellation signal for the scanner work guard. */
  signal?: AbortSignal;
}

/**
 * Represents a scanner option that violates its supported type, value, or safety contract.
 *
 * @class
 */
export class InvalidOptionsError extends Error {
  /**
   * Creates an option-validation error with a human-readable diagnostic.
   *
   * @param {string} message - Describes the scanner option contract that was violated.
   */
  public constructor(message: string) {
    super(message);
    this.name = "InvalidOptionsError";
  }
}

function numberInRange(name: string, value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new InvalidOptionsError(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function integerInRange(name: string, value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = numberInRange(name, value, fallback, minimum, maximum);
  if (!Number.isInteger(resolved)) {
    throw new InvalidOptionsError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function normalizeRequestHeaders(requestHeaders: ScanOptions["requestHeaders"]): Readonly<Record<string, string>> | undefined {
  if (requestHeaders === undefined) {
    return undefined;
  }
  if (typeof requestHeaders !== "object" || requestHeaders === null || Array.isArray(requestHeaders)) {
    throw new InvalidOptionsError("requestHeaders must be a record of strings.");
  }

  let prototype: object | null;
  let entries: [string, unknown][];
  try {
    prototype = Object.getPrototypeOf(requestHeaders) as object | null;
    entries = Object.entries(requestHeaders);
  } catch {
    throw new InvalidOptionsError("requestHeaders could not be read.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidOptionsError("requestHeaders must be a record of strings.");
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries) {
    if (typeof value !== "string") {
      throw new InvalidOptionsError("Every requestHeaders value must be a string.");
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      throw new InvalidOptionsError("requestHeaders contains an invalid header.");
    }
    const normalizedName = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(normalizedName)) {
      throw new InvalidOptionsError("requestHeaders contains a header that cannot be overridden.");
    }
    if (Object.hasOwn(normalized, normalizedName)) {
      throw new InvalidOptionsError("requestHeaders contains duplicate case-insensitive names.");
    }
    normalized[normalizedName] = value;
  }
  return Object.freeze(normalized);
}

function normalizeManualCorners(corners: ScanOptions["manualCorners"]): DocumentCorners | undefined {
  if (corners === undefined) return undefined;
  if (typeof corners !== "object" || corners === null || Array.isArray(corners)) throw new InvalidOptionsError("manualCorners must contain topLeft, topRight, bottomRight, and bottomLeft points.");
  try {
    const clonePoint = (value: unknown): { x: number; y: number } => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidOptionsError("Every manualCorners point must contain finite x and y coordinates.");
      const point = value as { x?: unknown; y?: unknown };
      if (typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new InvalidOptionsError("Every manualCorners point must contain finite x and y coordinates.");
      return { x: point.x, y: point.y };
    };
    return { topLeft: clonePoint(corners.topLeft), topRight: clonePoint(corners.topRight), bottomRight: clonePoint(corners.bottomRight), bottomLeft: clonePoint(corners.bottomLeft) };
  } catch (error) {
    if (error instanceof InvalidOptionsError) throw error;
    throw new InvalidOptionsError("manualCorners could not be read.");
  }
}

function validateSignal(signal: ScanOptions["signal"]): void {
  if (signal === undefined) return;
  if (typeof signal !== "object" || signal === null || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new InvalidOptionsError("signal must be an AbortSignal.");
  }
}

/**
 * Validates scanner options and resolves operation-specific defaults into flat processing settings.
 *
 * @param {ScanOptions|DetectOptions} [options={}] - The caller-supplied scan or detection options to validate.
 * @param {"scan"|"detect"} [operation="scan"] - The operation whose enhancement defaults should be applied.
 * @returns {ResolvedOptions} The validated options with output settings and profile defaults resolved.
 * @throws {InvalidOptionsError} If an option has an unsupported type or value, a numeric limit is out of range, request headers are unsafe, manual corners are malformed, or the cancellation signal is invalid.
 *
 * @example
 * const options = resolveOptions({
 *   performance: "fast",
 *   output: { format: "jpeg", quality: 85 },
 * });
 */
export function resolveOptions(options: ScanOptions | DetectOptions = {}, operation: "scan" | "detect" = "scan"): ResolvedOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new InvalidOptionsError("Options must be an object.");
  const performance = options.performance ?? "balanced";
  if (!isOneOf(performance, ["fast", "balanced", "accurate"] as const)) {
    throw new InvalidOptionsError("performance must be fast, balanced, or accurate.");
  }
  const profile = PROFILE_DEFAULTS[performance];
  const output = "output" in options ? options.output : undefined;
  if (output !== undefined && (typeof output !== "object" || output === null || Array.isArray(output))) throw new InvalidOptionsError("output must be an object.");
  const format = output?.format ?? "png";
  const encoding = output?.encoding ?? "buffer";
  const enhancement = ("enhancement" in options ? options.enhancement : undefined) ?? (operation === "scan" ? "color" : "none");
  const paperSize = ("paperSize" in options ? options.paperSize : undefined) ?? "detected";

  if (!isOneOf(format, ["png", "jpeg", "webp", "pdf"] as const)) {
    throw new InvalidOptionsError("output.format must be png, jpeg, webp, or pdf.");
  }
  if (!isOneOf(encoding, ["buffer", "base64", "data-url"] as const)) {
    throw new InvalidOptionsError("output.encoding must be buffer, base64, or data-url.");
  }
  if (!isOneOf(enhancement, ["none", "color", "grayscale", "black-white"] as const)) {
    throw new InvalidOptionsError("enhancement must be none, color, grayscale, or black-white.");
  }
  if (!isOneOf(paperSize, ["detected", "auto", "a4", "letter"] as const)) {
    throw new InvalidOptionsError("paperSize must be detected, auto, a4, or letter.");
  }

  if (options.allowFrameFallback !== undefined && typeof options.allowFrameFallback !== "boolean") throw new InvalidOptionsError("allowFrameFallback must be a boolean.");
  validateSignal(options.signal);
  const requestHeaders = normalizeRequestHeaders(options.requestHeaders);
  const manualCorners = normalizeManualCorners(options.manualCorners);
  return {
    performance,
    format,
    encoding,
    quality: integerInRange("output.quality", output?.quality, 92, 1, 100),
    enhancement,
    paperSize,
    ...(manualCorners === undefined ? {} : { manualCorners }),
    minConfidence: numberInRange("minConfidence", options.minConfidence, 0.58, 0, 1),
    minDocumentAreaRatio: numberInRange("minDocumentAreaRatio", options.minDocumentAreaRatio, 0.12, 0.02, 0.95),
    minSuccessAreaRatio: numberInRange("minSuccessAreaRatio", options.minSuccessAreaRatio, 0.2, 0, 0.95),
    paddingRatio: numberInRange("paddingRatio", options.paddingRatio, 0.003, 0, 0.05),
    allowFrameFallback: options.allowFrameFallback ?? true,
    detectionMaxDimension: integerInRange("detectionMaxDimension", options.detectionMaxDimension, profile.detectionMaxDimension, 320, 4096),
    maxFileSizeBytes: integerInRange("maxFileSizeBytes", options.maxFileSizeBytes, 40 * MEBIBYTE, 1, 1024 * MEBIBYTE),
    maxInputPixels: integerInRange("maxInputPixels", options.maxInputPixels, profile.maxInputPixels, 250_000, 250_000_000),
    maxOutputPixels: integerInRange("maxOutputPixels", "maxOutputPixels" in options ? options.maxOutputPixels : undefined, profile.maxOutputPixels, 250_000, 100_000_000),
    timeoutMs: integerInRange("timeoutMs", options.timeoutMs, profile.timeoutMs, 0, 3_600_000),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}
