import { InvalidOptionsError } from "../options";
import type { DocumentCorners, PaperSize, Point } from "../types";

const A4_RATIO = 210 / 297;
const LETTER_RATIO = 8.5 / 11;

/**
 * Calculates the Euclidean distance between two image-space points.
 *
 * @param {Point} a - The first point.
 * @param {Point} b - The second point.
 * @returns {number} The distance between the points in pixels.
 */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Converts named document corners into their canonical clockwise tuple.
 *
 * @param {DocumentCorners} corners - The named top-left, top-right, bottom-right, and bottom-left corners.
 * @returns {[Point, Point, Point, Point]} The corners ordered clockwise from the top-left point.
 */
export function cornersToArray(corners: DocumentCorners): [Point, Point, Point, Point] {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
}

/**
 * Converts a canonical clockwise corner tuple into named document corners.
 *
 * @param {readonly [Point, Point, Point, Point]} points - The corners ordered clockwise from top left.
 * @returns {DocumentCorners} The equivalent named corner object.
 */
export function arrayToCorners(points: readonly [Point, Point, Point, Point]): DocumentCorners {
  return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
}

/**
 * Calculates the absolute area enclosed by an image-space polygon.
 *
 * @param {ReadonlyArray<Point>} points - The polygon vertices in boundary order.
 * @returns {number} The enclosed area in square pixels.
 */
export function polygonArea(points: readonly Point[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current !== undefined && next !== undefined) twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function crossProduct(origin: Point, first: Point, second: Point): number {
  return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
}

function isStrictlyConvex(points: readonly [Point, Point, Point, Point]): boolean {
  let direction = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const following = points[(index + 2) % points.length];
    if (current === undefined || next === undefined || following === undefined) return false;
    const cross = crossProduct(current, next, following);
    if (Math.abs(cross) < 1e-6) return false;
    const sign = Math.sign(cross);
    if (direction !== 0 && sign !== direction) return false;
    direction = sign;
  }
  return true;
}

/**
 * Orders four finite points clockwise from top left and validates their quadrilateral.
 *
 * @param {ReadonlyArray<Point>} points - The four unordered corner points.
 * @returns {DocumentCorners} The validated corners in canonical order.
 * @throws {InvalidOptionsError} If the input does not contain four finite points forming a non-degenerate convex quadrilateral.
 */
export function orderCorners(points: readonly Point[]): DocumentCorners {
  if (points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new InvalidOptionsError("Exactly four finite corner points are required.");
  }
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const clockwise = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const topLeftIndex = clockwise.reduce((best, point, index) => (point.x + point.y < (clockwise[best]?.x ?? 0) + (clockwise[best]?.y ?? 0) ? index : best), 0);
  const rotated = [...clockwise.slice(topLeftIndex), ...clockwise.slice(0, topLeftIndex)];
  const ordered = (rotated[1]?.x ?? 0) >= (rotated[3]?.x ?? 0) ? rotated : [rotated[0], rotated[3], rotated[2], rotated[1]];
  const tuple = ordered as [Point, Point, Point, Point];
  if (polygonArea(tuple) < 1 || !isStrictlyConvex(tuple)) throw new InvalidOptionsError("Corner points must form a non-degenerate convex quadrilateral.");
  return arrayToCorners(tuple);
}

/**
 * Validates and orders manual document corners against the oriented source image.
 *
 * @param {DocumentCorners} corners - The caller-supplied document corners.
 * @param {number} width - The oriented source-image width in pixels.
 * @param {number} height - The oriented source-image height in pixels.
 * @returns {DocumentCorners} The canonical corners after geometric validation.
 * @throws {InvalidOptionsError} If the corners are non-finite, outside the permitted image-boundary tolerance, insufficiently separated, or geometrically unstable.
 */
export function validateCornersWithinImage(corners: DocumentCorners, width: number, height: number): DocumentCorners {
  const ordered = orderCorners(cornersToArray(corners));
  const tolerance = Math.max(width, height) * 0.01;
  if (cornersToArray(ordered).some((point) => point.x < -tolerance || point.y < -tolerance || point.x > width - 1 + tolerance || point.y > height - 1 + tolerance)) {
    throw new InvalidOptionsError("manualCorners must lie within the EXIF-oriented source image.");
  }
  const points = cornersToArray(ordered);
  const minimumSeparation = Math.max(1, Math.min(width, height) * 0.001);
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (distance(points[first]!, points[second]!) < minimumSeparation) {
        throw new InvalidOptionsError("manualCorners points must be distinct and sufficiently separated.");
      }
    }
  }
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length]!;
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const firstLength = distance(current, previous);
    const secondLength = distance(current, next);
    const angleSine = Math.abs(crossProduct(current, previous, next)) / (firstLength * secondLength);
    if (firstLength < minimumSeparation || secondLength < minimumSeparation || angleSine < 0.01) {
      throw new InvalidOptionsError("manualCorners must form a well-conditioned quadrilateral with four usable sides.");
    }
  }
  return ordered;
}

/**
 * Expands document corners around their center while clamping them to image bounds.
 *
 * @param {DocumentCorners} corners - The canonical document corners to expand.
 * @param {number} paddingRatio - The fractional padding applied on each side.
 * @param {number} width - The source-image width in pixels.
 * @param {number} height - The source-image height in pixels.
 * @returns {DocumentCorners} The expanded and image-bounded corners.
 */
export function expandCorners(corners: DocumentCorners, paddingRatio: number, width: number, height: number): DocumentCorners {
  if (paddingRatio === 0) return corners;
  const points = cornersToArray(corners);
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const factor = 1 + paddingRatio * 2;
  return arrayToCorners(points.map((point) => ({ x: Math.min(width - 1, Math.max(0, center.x + (point.x - center.x) * factor)), y: Math.min(height - 1, Math.max(0, center.y + (point.y - center.y) * factor)) })) as [Point, Point, Point, Point]);
}

/**
 * Checks whether any document corner lies within a proportional image-edge margin.
 *
 * @param {DocumentCorners} corners - The document corners to test.
 * @param {number} width - The source-image width in pixels.
 * @param {number} height - The source-image height in pixels.
 * @param {number} [ratio=0.012] - The edge margin as a fraction of the shorter image axis.
 * @returns {boolean} Whether at least one corner touches the configured frame margin.
 */
export function touchesImageFrame(corners: DocumentCorners, width: number, height: number, ratio = 0.012): boolean {
  const margin = Math.min(width, height) * ratio;
  return cornersToArray(corners).some((point) => point.x <= margin || point.y <= margin || point.x >= width - 1 - margin || point.y >= height - 1 - margin);
}

/**
 * Represents bounded raster dimensions selected for perspective-corrected output.
 */
export interface OutputDimensions {
  /** Specifies the output width in pixels. */
  width: number;
  /** Specifies the output height in pixels. */
  height: number;
  /** Identifies the detected or standard paper ratio applied to the output. */
  resolvedPaperSize: PaperSize;
}

function snapRatio(width: number, height: number, paperSize: PaperSize): { ratio: number; resolvedPaperSize: PaperSize } | null {
  const portrait = height >= width;
  const observed = Math.min(width, height) / Math.max(width, height);
  if (paperSize === "detected") return null;
  if (paperSize === "a4") return { ratio: A4_RATIO, resolvedPaperSize: "a4" };
  if (paperSize === "letter") return { ratio: LETTER_RATIO, resolvedPaperSize: "letter" };
  const a4Error = Math.abs(observed - A4_RATIO) / A4_RATIO;
  const letterError = Math.abs(observed - LETTER_RATIO) / LETTER_RATIO;
  if (Math.min(a4Error, letterError) > 0.025) return null;
  const selected = a4Error <= letterError ? { ratio: A4_RATIO, resolvedPaperSize: "a4" as const } : { ratio: LETTER_RATIO, resolvedPaperSize: "letter" as const };
  return portrait ? selected : selected;
}

/**
 * Calculates output dimensions from document geometry, paper-ratio policy, and a pixel budget.
 *
 * @param {DocumentCorners} corners - The canonical source document corners.
 * @param {PaperSize} paperSize - The paper-ratio policy to preserve or apply.
 * @param {number} maxOutputPixels - The maximum permitted output pixel area.
 * @returns {OutputDimensions} The integer dimensions and resolved paper-size classification.
 */
export function calculateOutputDimensions(corners: DocumentCorners, paperSize: PaperSize, maxOutputPixels: number): OutputDimensions {
  const top = distance(corners.topLeft, corners.topRight);
  const bottom = distance(corners.bottomLeft, corners.bottomRight);
  const left = distance(corners.topLeft, corners.bottomLeft);
  const right = distance(corners.topRight, corners.bottomRight);
  let width = (top + bottom) / 2 + 1;
  let height = (left + right) / 2 + 1;
  let resolvedPaperSize: PaperSize = "detected";
  const snapped = snapRatio(width, height, paperSize);
  if (snapped !== null) {
    resolvedPaperSize = snapped.resolvedPaperSize;
    if (height >= width) height = width / snapped.ratio;
    else width = height / snapped.ratio;
  }
  const area = width * height;
  if (area > maxOutputPixels) {
    const scale = Math.sqrt(maxOutputPixels / area);
    width *= scale;
    height *= scale;
  }
  let outputWidth = Math.max(64, Math.round(width));
  let outputHeight = Math.max(64, Math.round(height));
  if (outputWidth * outputHeight > maxOutputPixels) {
    const scale = Math.sqrt(maxOutputPixels / (outputWidth * outputHeight));
    outputWidth = Math.max(64, Math.floor(outputWidth * scale));
    outputHeight = Math.max(64, Math.floor(outputHeight * scale));
  }
  if (outputWidth * outputHeight > maxOutputPixels) {
    if (outputWidth >= outputHeight) outputWidth = Math.max(64, Math.floor(maxOutputPixels / outputHeight));
    else outputHeight = Math.max(64, Math.floor(maxOutputPixels / outputWidth));
  }
  return { width: outputWidth, height: outputHeight, resolvedPaperSize };
}
