import { loadOpenCV } from "@opencvjs/node";

/**
 * Represents the asynchronously initialized OpenCV.js runtime used by detection and warping.
 */
export type CvRuntime = Awaited<ReturnType<typeof loadOpenCV>>;
/**
 * Represents an OpenCV matrix allocated by the scanner's shared runtime.
 */
export type CvMat = InstanceType<CvRuntime["Mat"]>;

let runtimePromise: Promise<CvRuntime> | undefined;

/**
 * Returns the shared OpenCV runtime, initializing it on first use.
 *
 * @returns {Promise<CvRuntime>} Resolves with the initialized OpenCV runtime.
 * @throws {Error} If the OpenCV runtime cannot be loaded or initialized.
 */
export function getOpenCv(): Promise<CvRuntime> {
  runtimePromise ??= loadOpenCV();
  return runtimePromise;
}

/**
 * Initializes the shared OpenCV runtime before the first scan to avoid cold-start latency.
 *
 * @returns {Promise<void>} Resolves when the scanner runtime is ready.
 * @throws {Error} If the OpenCV runtime cannot be loaded or initialized.
 * @since 0.1.0
 */
export async function warmupScanner(): Promise<void> {
  await getOpenCv();
}
