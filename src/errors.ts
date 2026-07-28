import type { ScanErrorCode } from "./types";

/**
 * Represents a categorized scanner failure that can be exposed through a structured result.
 *
 * @class
 */
export class ScanFailure extends Error {
  /** Identifies the stable machine-readable failure category. */
  public readonly code: ScanErrorCode;

  /**
   * Creates a categorized scanner failure while preserving an optional underlying cause.
   *
   * @param {ScanErrorCode} code - The stable scanner failure category.
   * @param {string} message - The safe human-readable failure message.
   * @param {ErrorOptions} [options] - Native error options such as the underlying cause.
   */
  public constructor(code: ScanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScanFailure";
    this.code = code;
  }
}
