import { ScanFailure } from "./errors";
import type { ResolvedOptions } from "./options";
import { elapsedMilliseconds, startTimer, type MonotonicTimestamp } from "./timing";

/**
 * Coordinates caller cancellation and elapsed-time limits for scanner operations.
 *
 * @class
 */
export class WorkGuard {
  readonly #startedAt: MonotonicTimestamp;
  readonly #options: ResolvedOptions;
  readonly #controller = new AbortController();
  readonly #abortListener?: () => void;
  readonly #timeout?: NodeJS.Timeout;
  #stopReason: "aborted" | "timeout" | null = null;

  /**
   * Creates a guard tied to resolved scanner options and a monotonic start time.
   *
   * @param {ResolvedOptions} options - The validated timeout and cancellation settings.
   * @param {MonotonicTimestamp} [startedAt=startTimer()] - The timestamp from which the deadline is measured.
   */
  public constructor(options: ResolvedOptions, startedAt = startTimer()) {
    this.#options = options;
    this.#startedAt = startedAt;
    if (options.signal?.aborted === true) {
      this.#stop("aborted");
    } else if (options.signal !== undefined) {
      this.#abortListener = (): void => this.#stop("aborted");
      options.signal.addEventListener("abort", this.#abortListener, { once: true });
    }
    if (options.timeoutMs > 0 && this.#stopReason === null) {
      this.#timeout = setTimeout(() => this.#stop("timeout"), Math.max(0, options.timeoutMs - elapsedMilliseconds(this.#startedAt)));
      this.#timeout.unref();
    }
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Stops processing when caller cancellation or the configured deadline is active.
   *
   * @throws {ScanFailure} If the caller aborted scanning or the deadline has elapsed.
   */
  public check(): void {
    if (this.#stopReason === "aborted") {
      throw new ScanFailure("ABORTED", "Scanning was aborted.");
    }
    if (this.#stopReason === "timeout") {
      throw new ScanFailure("TIMEOUT", "Scanning exceeded its configured deadline.");
    }
    if (this.#options.signal?.aborted === true) {
      this.#stop("aborted");
      throw new ScanFailure("ABORTED", "Scanning was aborted.");
    }
    if (this.#options.timeoutMs > 0 && elapsedMilliseconds(this.#startedAt) >= this.#options.timeoutMs) {
      this.#stop("timeout");
      throw new ScanFailure("TIMEOUT", "Scanning exceeded its configured deadline.");
    }
  }

  /** Releases the timer and external abort listener owned by the guard. */
  public dispose(): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    if (this.#abortListener !== undefined && this.#options.signal !== undefined) this.#options.signal.removeEventListener("abort", this.#abortListener);
  }

  #stop(reason: "aborted" | "timeout"): void {
    if (this.#stopReason !== null) return;
    this.#stopReason = reason;
    this.#controller.abort(reason === "timeout" ? new ScanFailure("TIMEOUT", "Scanning exceeded its configured deadline.") : new ScanFailure("ABORTED", "Scanning was aborted."));
  }
}
