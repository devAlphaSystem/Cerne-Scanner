import { WorkGuard } from "./deadline";
import { decodeImage, inspectImage, type ImageInfo, type ImageRegion } from "./document/decode-image";
import { loadInput, type LoadedInput } from "./document/load-input";
import { detectCorners } from "./detection/detect-document";
import { ScanFailure } from "./errors";
import { calculateOutputDimensions, cornersToArray, expandCorners, polygonArea, touchesImageFrame, validateCornersWithinImage } from "./geometry/points";
import { InvalidOptionsError, resolveOptions, type ResolvedOptions } from "./options";
import { encodeOutput, representOutput } from "./output/encode";
import { warpPerspective } from "./processing/warp-perspective";
import { elapsedMilliseconds, startTimer, type MonotonicTimestamp } from "./timing";
import type { DetectionMetadata, DetectionResult, DocumentCorners, DocumentDetection, EncodedScanData, OutputEncoding, ScanErrorInfo, ScanInput, ScanMetadata, ScanOptions, ScanOutputInfo, ScanResult, ScanStatus } from "./types";

/**
 * Holds the loaded input as soon as it exists so cleanup can run even when a later stage fails.
 *
 * A stream stored under the `file` or `auto` policy owns a temporary file that outlives loading: `sharp` reads
 * it during inspection, detection, and transformation. Without this handle, a failure between loading and the
 * assembled context would leave that file on disk.
 */
interface LoadedSlot {
  current: LoadedInput | null;
}

interface DetectionContext {
  options: ResolvedOptions;
  loaded: LoadedInput;
  imageInfo: ImageInfo;
  detectionWidth: number;
  detectionHeight: number;
  detection: DocumentDetection | null;
  detectionDurationMs: number;
  loadDurationMs: number;
  warnings: string[];
  status: ScanStatus;
}

function failureInfo(error: unknown): ScanErrorInfo {
  if (error instanceof InvalidOptionsError) return { code: "INVALID_OPTIONS", message: error.message };
  if (error instanceof ScanFailure) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "AbortError") return { code: "ABORTED", message: "Scanning was aborted." };
  if (error instanceof RangeError) return { code: "RESOURCE_LIMIT", message: "The scan exceeded an available memory or dimension limit." };
  return { code: "PROCESSING_ERROR", message: "The image could not be scanned because an unexpected processing error occurred." };
}

/**
 * Reports whether a boundary came from automatic ranking rather than from the caller or the whole frame.
 *
 * Only ranked boundaries can select the wrong quadrilateral, so the area reservation and the narrow-margin
 * reservation apply to them alone: manual corners are the caller's own geometry and the frame fallback
 * already reports itself as partial.
 *
 * @param {DocumentDetection["method"]} method - The strategy that supplied the boundary.
 * @returns {boolean} `true` when the boundary was ranked by contour or line analysis.
 */
function isRankedMethod(method: DocumentDetection["method"]): boolean {
  return method === "contour" || method === "lines";
}

/**
 * Reports whether a ranked boundary encloses too little of the image to be trusted as the page outline.
 *
 * @param {DocumentDetection} detection - The selected boundary.
 * @param {number} minSuccessAreaRatio - The smallest accepted image share.
 * @returns {boolean} `true` when the boundary is ranked and smaller than the accepted share.
 */
function enclosesTooLittle(detection: DocumentDetection, minSuccessAreaRatio: number): boolean {
  return isRankedMethod(detection.method) && detection.areaRatio < minSuccessAreaRatio;
}

function statusForDetection(detection: DocumentDetection | null, minSuccessAreaRatio: number): ScanStatus {
  if (detection === null) return "not_found";
  if (detection.touchesFrame || detection.method === "frame") return "partial";
  return enclosesTooLittle(detection, minSuccessAreaRatio) ? "partial" : "success";
}

/**
 * Sets how far above `minConfidence` a contour must score before it is reported without a reservation.
 *
 * Contours that clear the threshold by less than this margin are frequently rectangles drawn inside the
 * page — tables, boxed sections, photographs — rather than the page boundary itself, because the score in
 * `detectCorners` rewards straight high-contrast edges without requiring that they enclose the whole sheet.
 */
const MARGINAL_CONFIDENCE_MARGIN = 0.08;

function detectionWarnings(detection: DocumentDetection | null, options: ResolvedOptions): string[] {
  if (detection === null) return [];
  const warnings: string[] = [];
  if (detection.method === "frame") warnings.push("Four external page edges could not be proven; the complete image frame was preserved as a partial document.");
  else if (detection.touchesFrame) warnings.push("The detected document touches the image boundary, so content outside the photograph cannot be recovered.");
  else if (enclosesTooLittle(detection, options.minSuccessAreaRatio)) warnings.push(`The detected boundary encloses ${(detection.areaRatio * 100).toFixed(1)}% of the image, below the ${(options.minSuccessAreaRatio * 100).toFixed(1)}% required for an unreserved result, so it may be a region inside the page instead of the page boundary; the crop is reported as partial and the original must be kept.`);
  else if (isRankedMethod(detection.method) && detection.confidence < options.minConfidence + MARGINAL_CONFIDENCE_MARGIN) warnings.push("The detected contour cleared minConfidence by a narrow margin, so it may enclose a region inside the page instead of the page boundary; verify the crop before discarding the original.");
  return warnings;
}

function scaleCorners(corners: DocumentCorners, detectionWidth: number, detectionHeight: number, sourceWidth: number, sourceHeight: number): DocumentCorners {
  const scaleX = (sourceWidth - 1) / Math.max(1, detectionWidth - 1);
  const scaleY = (sourceHeight - 1) / Math.max(1, detectionHeight - 1);
  const points = cornersToArray(corners).map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })) as [typeof corners.topLeft, typeof corners.topRight, typeof corners.bottomRight, typeof corners.bottomLeft];
  return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
}

async function prepareDetection(input: ScanInput, options: ResolvedOptions, guard: WorkGuard, slot: LoadedSlot): Promise<DetectionContext> {
  const loadStarted = startTimer();
  guard.check();
  const loaded = await loadInput(input, options.maxFileSizeBytes, {
    ...(options.requestHeaders === undefined ? {} : { requestHeaders: options.requestHeaders }),
    signal: guard.signal,
    streamStorage: options.streamStorage,
    streamMemoryThresholdBytes: options.streamMemoryThresholdBytes,
    ...(options.streamTempDirectory === undefined ? {} : { streamTempDirectory: options.streamTempDirectory }),
  });
  slot.current = loaded;
  guard.check();
  const imageInfo = await inspectImage(loaded, options.maxInputPixels);
  guard.check();
  const loadDurationMs = elapsedMilliseconds(loadStarted);

  if (options.manualCorners !== undefined) {
    const corners = validateCornersWithinImage(options.manualCorners, imageInfo.width, imageInfo.height);
    const detection: DocumentDetection = {
      corners,
      confidence: 1,
      method: "manual",
      areaRatio: polygonArea(cornersToArray(corners)) / (imageInfo.width * imageInfo.height),
      edgeSupport: 0,
      touchesFrame: touchesImageFrame(corners, imageInfo.width, imageInfo.height),
      candidatesEvaluated: 0,
    };
    const status = statusForDetection(detection, options.minSuccessAreaRatio);
    return { options, loaded, imageInfo, detectionWidth: imageInfo.width, detectionHeight: imageInfo.height, detection, detectionDurationMs: 0, loadDurationMs, warnings: detectionWarnings(detection, options), status };
  }

  const detectionStarted = startTimer();
  const image = await decodeImage(loaded, imageInfo, options.detectionMaxDimension);
  guard.check();
  const detected = await detectCorners(image, options, guard);
  const detectionDurationMs = elapsedMilliseconds(detectionStarted);
  let detection = detected.detection;
  if (detection !== null) {
    const corners = scaleCorners(detection.corners, image.width, image.height, imageInfo.width, imageInfo.height);
    detection = { ...detection, corners, touchesFrame: touchesImageFrame(corners, imageInfo.width, imageInfo.height), candidatesEvaluated: detected.candidatesEvaluated };
  }
  const status = statusForDetection(detection, options.minSuccessAreaRatio);
  return { options, loaded, imageInfo, detectionWidth: image.width, detectionHeight: image.height, detection, detectionDurationMs, loadDurationMs, warnings: detectionWarnings(detection, options), status };
}

function detectionMetadata(context: DetectionContext, startedAt: MonotonicTimestamp, complete: boolean): DetectionMetadata {
  return {
    performance: context.options.performance,
    inputFormat: context.imageInfo.format,
    fileSizeBytes: context.loaded.size,
    sourceWidth: context.imageInfo.width,
    sourceHeight: context.imageInfo.height,
    detectionWidth: context.detectionWidth,
    detectionHeight: context.detectionHeight,
    durationMs: elapsedMilliseconds(startedAt),
    complete,
  };
}

function emptyDetectionMetadata(performance: ResolvedOptions["performance"] | "balanced", startedAt: MonotonicTimestamp): DetectionMetadata {
  return { performance, fileSizeBytes: 0, sourceWidth: 0, sourceHeight: 0, detectionWidth: 0, detectionHeight: 0, durationMs: elapsedMilliseconds(startedAt), complete: false };
}

/**
 * Detects and evaluates a document boundary without transforming or encoding the source image.
 *
 * Validation, loading, and detection failures are represented in the returned result instead of rejecting the promise.
 *
 * @param {ScanInput} input - The local path, HTTP(S) URL, `ArrayBuffer`, or byte array to analyze.
 * @param {Omit<ScanOptions, "output"|"enhancement"|"paperSize"|"maxOutputPixels">} [suppliedOptions={}] - The detection, resource, timeout, and request settings for this run.
 * @returns {Promise<DetectionResult>} Resolves with detected corners, confidence data, metadata, warnings, and any structured failure.
 * @since 0.1.0
 *
 * @example
 * const result = await detectDocument("./photo.jpg", {
 *   performance: "accurate",
 *   minConfidence: 0.7,
 * });
 * if (result.success) console.log(result.detection?.corners);
 */
export async function detectDocument(input: ScanInput, suppliedOptions: Omit<ScanOptions, "output" | "enhancement" | "paperSize" | "maxOutputPixels"> = {}): Promise<DetectionResult> {
  const startedAt = startTimer();
  const slot: LoadedSlot = { current: null };
  let options: ResolvedOptions | undefined;
  let guard: WorkGuard | undefined;
  try {
    options = resolveOptions(suppliedOptions, "detect");
    guard = new WorkGuard(options, startedAt);
    const context = await prepareDetection(input, options, guard, slot);
    return {
      status: context.status,
      success: context.detection !== null,
      detection: context.detection,
      metadata: detectionMetadata(context, startedAt, context.status !== "partial"),
      warnings: context.warnings,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      success: false,
      detection: null,
      metadata: emptyDetectionMetadata(options?.performance ?? "balanced", startedAt),
      warnings: [],
      error: failureInfo(error),
    };
  } finally {
    guard?.dispose();
    await releaseLoaded(slot);
  }
}

/**
 * Removes any scanner-owned temporary file without letting cleanup replace the structured result.
 *
 * It runs after the outcome is decided, so a failing unlink must not reject a promise the contract promises to
 * resolve. Caller-supplied paths are never touched: only a stream spooled by the scanner has a `cleanup`.
 *
 * @param {LoadedSlot} slot - The slot holding the loaded input, if loading got that far.
 * @returns {Promise<void>} Resolves once the attempt settles, successfully or not.
 */
async function releaseLoaded(slot: LoadedSlot): Promise<void> {
  try {
    await slot.current?.cleanup();
  } catch {
    // Cleanup must not replace the primary result.
  }
}

function regionAroundCorners(corners: DocumentCorners, width: number, height: number): ImageRegion {
  const points = cornersToArray(corners);
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.003));
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x)) - margin));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y)) - margin));
  const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x)) + margin + 1));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y)) + margin + 1));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function transformSourceMaxDimension(region: ImageRegion, outputWidth: number, outputHeight: number): number | undefined {
  const regionPixels = region.width * region.height;
  const outputPixels = outputWidth * outputHeight;
  const sourcePixelBudget = Math.ceil(outputPixels * 1.25);
  if (regionPixels <= sourcePixelBudget) return undefined;
  const scale = Math.sqrt(sourcePixelBudget / regionPixels);
  return Math.max(1, Math.floor(Math.max(region.width, region.height) * scale));
}

function scanMetadata(context: DetectionContext, startedAt: MonotonicTimestamp, outputWidth: number, outputHeight: number, paperSize: ScanMetadata["paperSize"], transformDurationMs: number, encodeDurationMs: number, complete: boolean): ScanMetadata {
  return {
    ...detectionMetadata(context, startedAt, complete),
    outputWidth,
    outputHeight,
    paperSize,
    enhancement: context.options.enhancement,
    loadDurationMs: context.loadDurationMs,
    detectionDurationMs: context.detectionDurationMs,
    transformDurationMs,
    encodeDurationMs,
  };
}

function emptyScanMetadata(options: ResolvedOptions | undefined, startedAt: MonotonicTimestamp): ScanMetadata {
  return {
    ...emptyDetectionMetadata(options?.performance ?? "balanced", startedAt),
    outputWidth: 0,
    outputHeight: 0,
    paperSize: options?.paperSize ?? "detected",
    enhancement: options?.enhancement ?? "none",
    loadDurationMs: 0,
    detectionDurationMs: 0,
    transformDurationMs: 0,
    encodeDurationMs: 0,
  };
}

/**
 * Scans a document image by detecting its boundary, correcting perspective, applying enhancement, and encoding the requested output.
 *
 * Validation, loading, detection, transformation, and encoding failures are represented in the returned result instead of rejecting the promise.
 *
 * @template {OutputEncoding} TEncoding - Associates the requested encoding with the returned data representation.
 * @param {ScanInput} input - The local path, HTTP(S) URL, `ArrayBuffer`, or byte array to scan.
 * @param {ScanOptions<TEncoding>} [suppliedOptions={}] - The detection, transformation, output, resource, timeout, and request settings for this run.
 * @returns {Promise<ScanResult<TEncoding>>} Resolves with the encoded scan, detection details, timing metadata, warnings, and any structured failure.
 * @since 0.1.0
 *
 * @example
 * const result = await scanDocument("./photo.jpg", {
 *   output: { format: "pdf", encoding: "buffer" },
 *   enhancement: "color",
 *   paperSize: "a4",
 * });
 * if (result.success) console.log(result.output?.mimeType);
 */
export async function scanDocument<TEncoding extends OutputEncoding = "buffer">(input: ScanInput, suppliedOptions: ScanOptions<TEncoding> = {}): Promise<ScanResult<TEncoding>> {
  const startedAt = startTimer();
  const slot: LoadedSlot = { current: null };
  let options: ResolvedOptions | undefined;
  let guard: WorkGuard | undefined;
  let context: DetectionContext | undefined;
  try {
    options = resolveOptions(suppliedOptions, "scan");
    guard = new WorkGuard(options, startedAt);
    context = await prepareDetection(input, options, guard, slot);
    if (context.detection === null) {
      return {
        status: "not_found",
        success: false,
        confidence: 0,
        data: null,
        output: null,
        detection: null,
        metadata: scanMetadata(context, startedAt, 0, 0, options.paperSize, 0, 0, true),
        warnings: [],
        error: null,
      };
    }

    const correctedCorners = expandCorners(context.detection.corners, options.paddingRatio, context.imageInfo.width, context.imageInfo.height);
    const dimensions = calculateOutputDimensions(correctedCorners, options.paperSize, options.maxOutputPixels);
    const transformStarted = startTimer();
    const region = regionAroundCorners(correctedCorners, context.imageInfo.width, context.imageInfo.height);
    const source = await decodeImage(context.loaded, context.imageInfo, transformSourceMaxDimension(region, dimensions.width, dimensions.height), region);
    const warped = await warpPerspective(source, correctedCorners, dimensions.width, dimensions.height, options.performance, guard);
    const transformDurationMs = elapsedMilliseconds(transformStarted);

    guard.check();
    const encodeStarted = startTimer();
    const encoded = await encodeOutput(warped, options.enhancement, options.format, options.quality, dimensions.resolvedPaperSize);
    const encodeDurationMs = elapsedMilliseconds(encodeStarted);
    guard.check();
    const data = representOutput(encoded.bytes, encoded.mimeType, options.encoding) as EncodedScanData<TEncoding>;
    const output: ScanOutputInfo<TEncoding> = {
      format: options.format,
      encoding: options.encoding as TEncoding,
      mimeType: encoded.mimeType,
      byteLength: encoded.bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
    };
    return {
      status: context.status,
      success: true,
      confidence: context.detection.confidence,
      data,
      output,
      detection: context.detection,
      metadata: scanMetadata(context, startedAt, dimensions.width, dimensions.height, dimensions.resolvedPaperSize, transformDurationMs, encodeDurationMs, context.status !== "partial"),
      warnings: context.warnings,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      success: false,
      confidence: context?.detection?.confidence ?? 0,
      data: null,
      output: null,
      detection: context?.detection ?? null,
      metadata: context === undefined ? emptyScanMetadata(options, startedAt) : scanMetadata(context, startedAt, 0, 0, options?.paperSize ?? "detected", 0, 0, false),
      warnings: context?.warnings ?? [],
      error: failureInfo(error),
    };
  } finally {
    guard?.dispose();
    await releaseLoaded(slot);
  }
}
