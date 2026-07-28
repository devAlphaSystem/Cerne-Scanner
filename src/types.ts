/**
 * Represents a local path, credential-free HTTP(S) URL, `ArrayBuffer`, `Uint8Array`, or `Buffer` accepted for scanning.
 *
 * @since 0.1.0
 */
export type ScanInput = string | ArrayBuffer | Uint8Array;

/**
 * Identifies an image format supported by the decoding pipeline.
 *
 * @since 0.1.0
 */
export type InputImageFormat = "jpeg" | "png" | "webp" | "tiff" | "avif" | "heif";

/**
 * Selects the resource and detection-accuracy trade-off used during scanning.
 *
 * @since 0.1.0
 */
export type PerformanceProfile = "fast" | "balanced" | "accurate";

/**
 * Identifies an encoded image or document format produced by the scanner.
 *
 * @since 0.1.0
 */
export type OutputFormat = "png" | "jpeg" | "webp" | "pdf";

/**
 * Selects how encoded output data is represented in a scan result.
 *
 * @since 0.1.0
 */
export type OutputEncoding = "buffer" | "base64" | "data-url";

/**
 * Selects the tonal processing applied after perspective correction.
 *
 * @since 0.1.0
 */
export type EnhancementMode = "none" | "color" | "grayscale" | "black-white";

/**
 * Selects whether output proportions follow detected geometry or a standard paper size.
 *
 * @since 0.1.0
 */
export type PaperSize = "detected" | "auto" | "a4" | "letter";

/**
 * Identifies the overall outcome of document detection or scanning.
 *
 * `success` reports only that the selected quadrilateral does not touch the image frame; it is not proof
 * that the crop covers the whole page. A rectangle enclosed by the page never touches the frame, so a crop
 * taken from inside the sheet is also reported as `success`. Check `warnings` and `confidence` when a
 * destructive crop would be unacceptable.
 *
 * @since 0.1.0
 */
export type ScanStatus = "success" | "partial" | "not_found" | "error";

/**
 * Identifies the strategy that supplied the selected document boundary.
 *
 * @since 0.1.0
 */
export type DetectionMethod = "contour" | "lines" | "frame" | "manual";

/**
 * Identifies a stable failure category reported by the scanner API.
 *
 * @since 0.1.0
 */
export type ScanErrorCode = "INVALID_INPUT" | "FILE_NOT_FOUND" | "FILE_TOO_LARGE" | "DOWNLOAD_ERROR" | "INVALID_OPTIONS" | "UNSUPPORTED_FORMAT" | "INVALID_IMAGE" | "TIMEOUT" | "ABORTED" | "RESOURCE_LIMIT" | "PROCESSING_ERROR";

/**
 * Represents a two-dimensional point in image pixel coordinates.
 *
 * @since 0.1.0
 */
export interface Point {
  /** Specifies the horizontal coordinate measured from the image's left edge. */
  x: number;
  /** Specifies the vertical coordinate measured from the image's top edge. */
  y: number;
}

/**
 * Defines an ordered quadrilateral around a document in source-image coordinates.
 *
 * @since 0.1.0
 */
export interface DocumentCorners {
  /** Identifies the document's upper-left corner. */
  topLeft: Point;
  /** Identifies the document's upper-right corner. */
  topRight: Point;
  /** Identifies the document's lower-right corner. */
  bottomRight: Point;
  /** Identifies the document's lower-left corner. */
  bottomLeft: Point;
}

/**
 * Configures the format, representation, and quality of encoded scan output.
 *
 * @template {OutputEncoding} TEncoding - Specifies the representation returned in the scan result.
 * @since 0.1.0
 */
export interface OutputOptions<TEncoding extends OutputEncoding = OutputEncoding> {
  /** Selects the output container, defaulting to `png`. */
  format?: OutputFormat;
  /** Selects the returned data representation, defaulting to `buffer`. */
  encoding?: TEncoding;
  /** Sets JPEG or WebP quality from 1 through 100, defaulting to 92 and applying to lossy PDF rasters but not lossless output. */
  quality?: number;
}

/**
 * Configures loading, detection, perspective correction, enhancement, and output encoding for one scan.
 *
 * @template {OutputEncoding} TEncoding - Specifies the representation returned in the scan result.
 * @since 0.1.0
 */
export interface ScanOptions<TEncoding extends OutputEncoding = OutputEncoding> {
  /** Selects resource limits and detection thoroughness, defaulting to `balanced`. */
  performance?: PerformanceProfile;
  /** Configures the encoded result format, representation, and quality. */
  output?: OutputOptions<TEncoding>;
  /** Selects post-correction tonal processing, defaulting to `color`. */
  enhancement?: EnhancementMode;
  /** Controls output proportions, defaulting to detected geometry; `auto` snaps shapes within 2.5% of A4 or Letter. */
  paperSize?: PaperSize;
  /** Supplies corners in EXIF-oriented source-image coordinates that bypass automatic document detection. */
  manualCorners?: DocumentCorners;
  /** Sets the minimum accepted detection confidence from zero through one, defaulting to 0.58. */
  minConfidence?: number;
  /** Sets the minimum document-to-image area ratio for automatic detection from 0.02 through 0.95, defaulting to 0.12. */
  minDocumentAreaRatio?: number;
  /**
   * Sets the smallest share of the image an automatically detected boundary must enclose to be reported as
   * `success` instead of `partial`, from zero through 0.95 and defaulting to 0.20.
   *
   * The boundary score rewards straight, high-contrast, right-angled edges without requiring that they enclose
   * the whole sheet, so a table or a framed section printed inside the page can outrank the page outline and
   * still clear `minConfidence`. Confidence alone does not separate the two cases; the enclosed area does.
   * Boundaries below this share still produce output, but the `partial` status marks the crop as unverified so
   * an automated pipeline does not discard the original.
   *
   * The default is calibrated against observed regressions rather than a labelled corpus: measured internal
   * regions enclosed about 0.14 of the image and the smallest correct page about 0.25. Raise it when losing a
   * distant page is cheaper than accepting a wrong crop, and set it to zero to restore the previous behaviour.
   */
  minSuccessAreaRatio?: number;
  /** Expands selected corners before scan output transformation by a ratio from zero through 0.05, defaulting to 0.003; it has no effect in `detectDocument`. */
  paddingRatio?: number;
  /** Allows the full image frame to serve as a partial document fallback, defaulting to `true`. */
  allowFrameFallback?: boolean;
  /** Limits the longest automatic-detection raster edge from 320 through 4,096 pixels, defaulting to 960, 1,440, or 2,048 by profile; manual detection uses source-image coordinates directly. */
  detectionMaxDimension?: number;
  /** Limits accepted source size from one byte through 1 GiB, defaulting to 40 MiB. */
  maxFileSizeBytes?: number;
  /** Limits the validated EXIF-oriented source-image area before raster decoding from 250,000 through 250 million pixels, defaulting to 60, 100, or 160 million by profile. */
  maxInputPixels?: number;
  /** Limits corrected output-image area from 250,000 through 100 million pixels, defaulting to 4, 8, or 16 million by profile. */
  maxOutputPixels?: number;
  /** Sets the deadline from zero through 3,600,000 milliseconds, defaulting to 20, 60, or 120 seconds by profile; zero disables it. */
  timeoutMs?: number;
  /** Supplies validated HTTP(S) headers that are removed after cross-origin or HTTPS-to-HTTP redirects. */
  requestHeaders?: Readonly<Record<string, string>>;
  /** Aborts source loading and image processing when triggered. */
  signal?: AbortSignal;
}

/**
 * Configures source loading and document detection while excluding output format, enhancement, paper-size, and output-pixel controls.
 *
 * @since 0.1.0
 */
export type DetectOptions = Omit<ScanOptions, "output" | "enhancement" | "paperSize" | "maxOutputPixels">;

/**
 * Describes the selected document boundary and the evidence supporting it.
 *
 * @since 0.1.0
 */
export interface DocumentDetection {
  /** Contains the ordered document boundary in source-image pixel coordinates. */
  corners: DocumentCorners;
  /** Reports the normalized boundary confidence score from zero through one. */
  confidence: number;
  /** Identifies the strategy that supplied the selected boundary. */
  method: DetectionMethod;
  /** Reports the fraction of the source image enclosed by the boundary. */
  areaRatio: number;
  /** Reports the fraction of sampled boundary positions supported by detected edges. */
  edgeSupport: number;
  /** Indicates whether any selected corner lies near the source-image frame. */
  touchesFrame: boolean;
  /** Reports how many candidate quadrilaterals were evaluated before selection. */
  candidatesEvaluated: number;
}

/**
 * Represents a structured scanning failure safe to return to callers.
 *
 * @since 0.1.0
 */
export interface ScanErrorInfo {
  /** Identifies the stable failure category. */
  code: ScanErrorCode;
  /** Explains the failure without exposing the original exception object. */
  message: string;
}

/**
 * Describes source characteristics, detection dimensions, and operation completeness.
 *
 * @since 0.1.0
 */
export interface DetectionMetadata {
  /** Identifies the resolved performance profile, or `balanced` when option validation failed. */
  performance: PerformanceProfile;
  /** Identifies the detected input format when a detection context completed, and is omitted in early-error metadata. */
  inputFormat?: InputImageFormat;
  /** Reports the loaded source size in bytes, or zero when a complete detection context is unavailable. */
  fileSizeBytes: number;
  /** Reports the validated EXIF-oriented source-image width in pixels, or zero when a complete detection context is unavailable. */
  sourceWidth: number;
  /** Reports the validated EXIF-oriented source-image height in pixels, or zero when a complete detection context is unavailable. */
  sourceHeight: number;
  /** Reports the boundary-selection coordinate-space width: the source width for manual corners or the decoded detection-raster width for automatic detection, and zero when unavailable. */
  detectionWidth: number;
  /** Reports the boundary-selection coordinate-space height: the source height for manual corners or the decoded detection-raster height for automatic detection, and zero when unavailable. */
  detectionHeight: number;
  /** Reports total elapsed operation time in milliseconds. */
  durationMs: number;
  /** Indicates whether detection completed without a partial boundary or terminal error. */
  complete: boolean;
}

/**
 * Represents the complete outcome of locating a document boundary in one image source.
 *
 * @since 0.1.0
 */
export interface DetectionResult {
  /** Identifies whether detection succeeded, completed partially, found nothing, or failed. */
  status: ScanStatus;
  /** Indicates whether `detection` contains a selected document boundary. */
  success: boolean;
  /** Contains the selected boundary, or `null` when none was found or detection failed. */
  detection: DocumentDetection | null;
  /** Describes the source, resolved profile, dimensions, timing, and completeness. */
  metadata: DetectionMetadata;
  /** Lists non-fatal boundary conditions observed during detection. */
  warnings: string[];
  /** Contains the terminal processing failure when one occurred, otherwise `null`. */
  error: ScanErrorInfo | null;
}

/**
 * Resolves encoded scan data to bytes for buffer output and text for string encodings.
 *
 * @template {OutputEncoding} TEncoding - Specifies the requested output representation.
 * @since 0.1.0
 */
export type EncodedScanData<TEncoding extends OutputEncoding> = TEncoding extends "buffer" ? Buffer : string;

/**
 * Describes the encoded artifact produced by a successful scan.
 *
 * @template {OutputEncoding} TEncoding - Specifies the representation used for the encoded artifact.
 * @since 0.1.0
 */
export interface ScanOutputInfo<TEncoding extends OutputEncoding> {
  /** Identifies the encoded image or document container. */
  format: OutputFormat;
  /** Identifies how the encoded data is represented in the result. */
  encoding: TEncoding;
  /** Identifies the media type of the encoded bytes. */
  mimeType: string;
  /** Reports the encoded byte count before string representation. */
  byteLength: number;
  /** Reports the corrected raster width in pixels. */
  width: number;
  /** Reports the corrected raster height in pixels. */
  height: number;
}

/**
 * Extends detection metadata with transformation, enhancement, and output details.
 *
 * @since 0.1.0
 */
export interface ScanMetadata extends DetectionMetadata {
  /** Reports the corrected output width in pixels, or zero when no output was produced. */
  outputWidth: number;
  /** Reports the corrected output height in pixels, or zero when no output was produced. */
  outputHeight: number;
  /** Identifies the resolved output paper mode, or the requested mode or `detected` fallback when no output exists. */
  paperSize: PaperSize;
  /** Identifies the resolved tonal enhancement mode, or `none` when option validation failed. */
  enhancement: EnhancementMode;
  /** Reports completed source loading and inspection time in milliseconds, or zero when no complete detection context was established. */
  loadDurationMs: number;
  /** Reports completed document-boundary detection time in milliseconds, or zero if that phase did not complete. */
  detectionDurationMs: number;
  /** Reports source-region decoding and perspective-correction time for produced output, or zero when no output was produced. */
  transformDurationMs: number;
  /** Reports output-encoding time for produced output, or zero when no output was produced. */
  encodeDurationMs: number;
}

/**
 * Represents the complete outcome of detecting, correcting, enhancing, and encoding one document image.
 *
 * @template {OutputEncoding} TEncoding - Specifies the representation of successful output data.
 * @since 0.1.0
 */
export interface ScanResult<TEncoding extends OutputEncoding = "buffer"> {
  /** Identifies whether scanning succeeded, completed partially, found nothing, or failed. */
  status: ScanStatus;
  /** Indicates whether encoded output is present, including output from a partial boundary. */
  success: boolean;
  /** Reports the selected boundary confidence from zero through one, or zero when unavailable. */
  confidence: number;
  /** Contains encoded document data, or `null` when no output was produced. */
  data: EncodedScanData<TEncoding> | null;
  /** Describes the encoded artifact, or `null` when no output was produced. */
  output: ScanOutputInfo<TEncoding> | null;
  /** Contains the selected source-image boundary, or `null` when none was available. */
  detection: DocumentDetection | null;
  /** Describes source inspection, detection, transformation, encoding, and elapsed time. */
  metadata: ScanMetadata;
  /** Lists non-fatal boundary conditions observed during scanning. */
  warnings: string[];
  /** Contains the terminal processing failure when one occurred, otherwise `null`. */
  error: ScanErrorInfo | null;
}
