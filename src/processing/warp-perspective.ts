import type { WorkGuard } from "../deadline";
import { cornersToArray } from "../geometry/points";
import { getOpenCv, type CvMat } from "../opencv";
import type { DecodedImage } from "../document/decode-image";
import type { DocumentCorners, PerformanceProfile } from "../types";

/**
 * Represents a perspective-corrected image in RGBA pixel form.
 */
export interface WarpedImage {
  /** Contains the corrected image's interleaved RGBA bytes. */
  data: Uint8Array;
  /** Specifies the corrected image width in pixels. */
  width: number;
  /** Specifies the corrected image height in pixels. */
  height: number;
}

/**
 * Corrects document perspective by mapping detected corners onto a rectangular output canvas.
 *
 * @param {DecodedImage} image - The decoded source image and its coordinate transform.
 * @param {DocumentCorners} sourceCorners - The document corners in oriented source-image coordinates.
 * @param {number} width - The target canvas width in pixels.
 * @param {number} height - The target canvas height in pixels.
 * @param {PerformanceProfile} performance - The profile that selects interpolation quality.
 * @param {WorkGuard} guard - The operation guard used to enforce cancellation and deadlines.
 * @returns {Promise<WarpedImage>} Resolves with a perspective-corrected RGBA image.
 * @throws {ScanFailure} If the operation is aborted or exceeds its deadline.
 * @throws {Error} If OpenCV initialization or perspective transformation fails.
 */
export async function warpPerspective(image: DecodedImage, sourceCorners: DocumentCorners, width: number, height: number, performance: PerformanceProfile, guard: WorkGuard): Promise<WarpedImage> {
  const cv = await getOpenCv();
  guard.check();
  const localCorners = cornersToArray(sourceCorners).map((point) => ({ x: (point.x - image.offsetX) * image.coordinateScaleX, y: (point.y - image.offsetY) * image.coordinateScaleY }));
  let source: CvMat | null = null;
  let destination: CvMat | null = null;
  let sourcePoints: CvMat | null = null;
  let destinationPoints: CvMat | null = null;
  let transform: CvMat | null = null;
  try {
    source = cv.matFromArray(image.height, image.width, cv.CV_8UC4, image.data);
    destination = new cv.Mat();
    sourcePoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      localCorners.flatMap((point) => [point.x, point.y]),
    );
    destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    const interpolation = performance === "accurate" ? cv.INTER_CUBIC : cv.INTER_LINEAR;
    cv.warpPerspective(source, destination, transform, new cv.Size(width, height), interpolation, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    guard.check();
    const data = new Uint8Array(destination.data.length);
    data.set(destination.data);
    return { data, width, height };
  } finally {
    transform?.delete();
    destinationPoints?.delete();
    sourcePoints?.delete();
    destination?.delete();
    source?.delete();
  }
}
