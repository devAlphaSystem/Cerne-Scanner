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

function enhancedPipeline(image: WarpedImage, enhancement: EnhancementMode): Sharp {
  let pipeline = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), { raw: { width: image.width, height: image.height, channels: 4 } }).flatten({ background: "#ffffff" });
  const regionWidth = Math.max(32, Math.round(image.width / 8));
  const regionHeight = Math.max(32, Math.round(image.height / 8));
  const sharpen = { sigma: 0.7, m1: 0.35, m2: 0.8, x1: 3, y2: 4, y3: 7 } as const;
  if (enhancement === "color") pipeline = pipeline.clahe({ width: regionWidth, height: regionHeight, maxSlope: 1 }).sharpen(sharpen);
  if (enhancement === "grayscale") pipeline = pipeline.greyscale().clahe({ width: regionWidth, height: regionHeight, maxSlope: 1 }).sharpen(sharpen);
  if (enhancement === "black-white") pipeline = pipeline.greyscale().clahe({ width: regionWidth, height: regionHeight, maxSlope: 2 }).threshold(178);
  return pipeline;
}

async function encodeRaster(image: WarpedImage, enhancement: EnhancementMode, format: Exclude<OutputFormat, "pdf">, quality: number): Promise<Buffer> {
  const pipeline = enhancedPipeline(image, enhancement);
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
