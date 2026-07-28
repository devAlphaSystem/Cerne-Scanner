import { PDFDocument } from "pdf-lib";
import sharp, { type Sharp } from "sharp";

import type { WarpedImage } from "../processing/warp-perspective";
import type { EnhancementMode, OutputEncoding, OutputFormat, PaperSize } from "../types";

/**
 * Represents encoded output bytes together with their media type.
 */
export interface EncodedOutput {
  /** Contains the encoded document or image bytes. */
  bytes: Buffer;
  /** Identifies the media type associated with the encoded bytes. */
  mimeType: string;
}

const SHARPEN = { sigma: 0.7, m1: 0.35, m2: 0.8, x1: 3, y2: 4, y3: 7 } as const;

/**
 * Caps the contrast-limiting window, whose cost in libvips grows with its area.
 *
 * An eight-by-eight grid is the classic CLAHE tiling, but on a large scan it
 * produces windows of several hundred pixels that dominate both time and memory
 * without changing the result: capping at this size moves output by at most one
 * level in two hundred and fifty-five. Smaller scans keep the proportional
 * window untouched, because it already falls below the cap.
 */
const MAX_CLAHE_WINDOW = 192;

/**
 * Writes a pipeline to an intermediate raster and reopens it as a new source.
 *
 * @param {Sharp} pipeline - The pipeline whose result should be materialized.
 * @returns {Promise<Sharp>} Resolves with a pipeline reading the materialized raster.
 * @throws {Error} If the intermediate raster cannot be produced.
 */
async function materialize(pipeline: Sharp): Promise<Sharp> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
}

/**
 * Builds the enhancement pipeline for a warped raster.
 *
 * `clahe` is the expensive step: libvips buffers its input once per worker
 * thread, so running it over a live pipeline makes peak memory scale with
 * `sharp.concurrency()`. Materializing everything that precedes it bounds that
 * to a single copy. libvips also runs `sharpen` before `clahe` regardless of
 * call order, so putting `sharpen` in the first stage keeps the operation order
 * — and therefore the output bytes — unchanged.
 *
 * @param {WarpedImage} image - The perspective-corrected RGBA raster to enhance.
 * @param {EnhancementMode} enhancement - The tonal enhancement to apply.
 * @returns {Promise<Sharp>} Resolves with the pipeline that produces the enhanced image.
 * @throws {Error} If an intermediate raster cannot be produced.
 */
async function enhancedPipeline(image: WarpedImage, enhancement: EnhancementMode): Promise<Sharp> {
  const source = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), { raw: { width: image.width, height: image.height, channels: 4 } }).flatten({ background: "#ffffff" });
  if (enhancement === "none") return source;

  const window = {
    width: Math.min(MAX_CLAHE_WINDOW, Math.max(32, Math.round(image.width / 8))),
    height: Math.min(MAX_CLAHE_WINDOW, Math.max(32, Math.round(image.height / 8))),
    maxSlope: enhancement === "black-white" ? 2 : 1,
  };
  if (enhancement === "black-white") return (await materialize(source.greyscale())).greyscale().clahe(window).threshold(178);
  if (enhancement === "grayscale") return (await materialize(source.greyscale().sharpen(SHARPEN))).greyscale().clahe(window);
  return (await materialize(source.sharpen(SHARPEN))).clahe(window);
}

async function encodeRaster(image: WarpedImage, enhancement: EnhancementMode, format: Exclude<OutputFormat, "pdf">, quality: number): Promise<Buffer> {
  const pipeline = await enhancedPipeline(image, enhancement);
  if (format === "jpeg") return pipeline.jpeg({ quality, chromaSubsampling: "4:4:4", progressive: true }).toBuffer();
  if (format === "webp") return pipeline.webp({ quality, smartSubsample: true }).toBuffer();
  return pipeline.png({ compressionLevel: 6, adaptiveFiltering: true, palette: enhancement === "black-white" }).toBuffer();
}

function pdfDimensions(width: number, height: number, paperSize: PaperSize): [number, number] {
  const landscape = width > height;
  if (paperSize === "a4") return landscape ? [841.89, 595.28] : [595.28, 841.89];
  if (paperSize === "letter") return landscape ? [792, 612] : [612, 792];
  const longEdge = 841.89;
  return landscape ? [longEdge, (longEdge * height) / width] : [(longEdge * width) / height, longEdge];
}

async function encodePdf(image: WarpedImage, enhancement: EnhancementMode, quality: number, paperSize: PaperSize): Promise<Buffer> {
  const usePng = enhancement === "black-white";
  const raster = await encodeRaster(image, enhancement, usePng ? "png" : "jpeg", quality);
  const document = await PDFDocument.create();
  const embedded = usePng ? await document.embedPng(raster) : await document.embedJpg(raster);
  const [pageWidth, pageHeight] = pdfDimensions(image.width, image.height, paperSize);
  const page = document.addPage([pageWidth, pageHeight]);
  page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Encodes a perspective-corrected image in the requested raster or PDF format.
 *
 * @param {WarpedImage} image - The RGBA image produced by perspective correction.
 * @param {EnhancementMode} enhancement - The tonal enhancement to apply before encoding.
 * @param {OutputFormat} format - The output container to produce.
 * @param {number} quality - The JPEG or WebP quality from 1 through 100, also used for lossy PDF rasters and ignored for lossless output.
 * @param {PaperSize} paperSize - The page dimensions to use when producing PDF output.
 * @returns {Promise<EncodedOutput>} Resolves with the encoded bytes and their media type.
 * @throws {Error} If image enhancement, raster encoding, or PDF generation fails.
 */
export async function encodeOutput(image: WarpedImage, enhancement: EnhancementMode, format: OutputFormat, quality: number, paperSize: PaperSize): Promise<EncodedOutput> {
  if (format === "pdf") return { bytes: await encodePdf(image, enhancement, quality, paperSize), mimeType: "application/pdf" };
  const mimeType = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
  return { bytes: await encodeRaster(image, enhancement, format, quality), mimeType };
}

/**
 * Represents encoded bytes in the binary or textual form requested by the caller.
 *
 * @param {Buffer} bytes - The encoded document or image bytes.
 * @param {string} mimeType - The media type to include in a data URL.
 * @param {OutputEncoding} encoding - The representation to return.
 * @returns {Buffer|string} The original buffer, a base64 string, or a data URL.
 */
export function representOutput(bytes: Buffer, mimeType: string, encoding: OutputEncoding): Buffer | string {
  if (encoding === "buffer") return bytes;
  const base64 = bytes.toString("base64");
  return encoding === "base64" ? base64 : `data:${mimeType};base64,${base64}`;
}
