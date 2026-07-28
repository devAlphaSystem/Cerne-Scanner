import sharp from "sharp";

import { ScanFailure } from "../errors";
import type { InputImageFormat } from "../types";
import type { LoadedInput } from "./load-input";

const MAX_OPENCV_AXIS = 32_767;

/**
 * Describes a validated image format and the dimensions represented at the current processing stage.
 */
export interface ImageInfo {
  /** Identifies the image container detected from the input bytes. */
  format: InputImageFormat;
  /** Reports the represented EXIF-oriented image or raster width in pixels. */
  width: number;
  /** Reports the represented EXIF-oriented image or raster height in pixels. */
  height: number;
}

/**
 * Describes an oriented RGBA raster and its mapping to source-image coordinates.
 */
export interface DecodedImage extends ImageInfo {
  /** Stores raw RGBA pixels in row-major order. */
  data: Uint8Array;
  /** Reports the decoded region's horizontal origin in source-image pixels. */
  offsetX: number;
  /** Reports the decoded region's vertical origin in source-image pixels. */
  offsetY: number;
  /** Converts horizontal source-coordinate offsets into decoded-raster coordinates. */
  coordinateScaleX: number;
  /** Converts vertical source-coordinate offsets into decoded-raster coordinates. */
  coordinateScaleY: number;
}

/**
 * Describes a rectangular region within the EXIF-oriented source image.
 */
export interface ImageRegion {
  /** Specifies the zero-based horizontal origin in source-image pixels. */
  left: number;
  /** Specifies the zero-based vertical origin in source-image pixels. */
  top: number;
  /** Specifies the region width in pixels. */
  width: number;
  /** Specifies the region height in pixels. */
  height: number;
}

/**
 * Resolves a loaded input into the source `sharp` should read.
 *
 * A file-backed input is handed to `sharp` as a path so libvips reads the spooled bytes itself; the document
 * never has to be materialized in the process just to be decoded. `loadInput` guarantees that a spool only ever
 * reaches this point in a format libvips reads eagerly, because a lazily decoded one would leave its descriptor
 * open and strand the temporary file; see `FORMATS_DECODED_FROM_MEMORY` in `load-input.ts`.
 *
 * @param {LoadedInput} input - The validated image bytes or their temporary file.
 * @returns {Buffer|string} The in-memory bytes, or the path holding them.
 */
function sharpSource(input: LoadedInput): Buffer | string {
  if (input.data === null) return input.path;
  return Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
}

/**
 * Inspects image metadata and validates dimensions before raster decoding.
 *
 * @param {LoadedInput} input - The validated image bytes and detected container format.
 * @param {number} maxInputPixels - The maximum accepted source-image area in pixels.
 * @returns {Promise<ImageInfo>} Resolves with the EXIF-oriented format and dimensions.
 * @throws {ScanFailure} If metadata cannot be decoded or the image violates dimension, area, or page-count limits.
 */
export async function inspectImage(input: LoadedInput, maxInputPixels: number): Promise<ImageInfo> {
  try {
    const metadata = await sharp(sharpSource(input), { failOn: "warning", limitInputPixels: false, pages: 1 }).metadata();
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new ScanFailure("INVALID_IMAGE", "The image does not declare valid dimensions.");
    if (width > MAX_OPENCV_AXIS || height > MAX_OPENCV_AXIS) throw new ScanFailure("RESOURCE_LIMIT", `Each image axis must not exceed ${MAX_OPENCV_AXIS} pixels.`);
    if (width * height > maxInputPixels) throw new ScanFailure("RESOURCE_LIMIT", `The image exceeds the configured ${maxInputPixels}-pixel limit.`);
    if ((metadata.pages ?? 1) !== 1) throw new ScanFailure("UNSUPPORTED_FORMAT", "Animated or multi-page images are not supported; supply one still page.");
    return { format: input.format, width, height };
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure("INVALID_IMAGE", "The image could not be decoded safely.", { cause: error });
  }
}

/**
 * Decodes validated image bytes into an oriented RGBA raster, optionally
 * restricting the source region and longest output dimension.
 *
 * @param {LoadedInput} input - The validated image bytes to decode.
 * @param {ImageInfo} info - The previously validated source format and dimensions.
 * @param {number} [maxDimension] - The maximum decoded width or height in pixels.
 * @param {ImageRegion} [region] - The source-image rectangle to decode.
 * @returns {Promise<DecodedImage>} Resolves with RGBA pixels and their source-coordinate mapping.
 * @throws {ScanFailure} If decoding fails or the raster does not match the requested dimensions and four-channel RGBA layout.
 */
export async function decodeImage(input: LoadedInput, info: ImageInfo, maxDimension?: number, region?: ImageRegion): Promise<DecodedImage> {
  const sourceWidth = region?.width ?? info.width;
  const sourceHeight = region?.height ?? info.height;
  const scale = maxDimension === undefined ? 1 : Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  try {
    let pipeline = sharp(sharpSource(input), { failOn: "warning", limitInputPixels: info.width * info.height, pages: 1 }).autoOrient().flatten({ background: "#ffffff" }).toColourspace("srgb");
    if (region !== undefined) pipeline = pipeline.extract(region);
    if (scale < 1) pipeline = pipeline.resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 });
    const decoded = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== targetWidth || decoded.info.height !== targetHeight || decoded.info.channels !== 4) throw new ScanFailure("INVALID_IMAGE", "The decoded image dimensions did not match its validated metadata.");
    return {
      format: info.format,
      width: decoded.info.width,
      height: decoded.info.height,
      data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      offsetX: region?.left ?? 0,
      offsetY: region?.top ?? 0,
      coordinateScaleX: sourceWidth <= 1 ? 1 : (decoded.info.width - 1) / (sourceWidth - 1),
      coordinateScaleY: sourceHeight <= 1 ? 1 : (decoded.info.height - 1) / (sourceHeight - 1),
    };
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure("INVALID_IMAGE", "The image raster could not be decoded.", { cause: error });
  }
}
