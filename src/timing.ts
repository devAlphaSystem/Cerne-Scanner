/**
 * Represents a monotonic high-resolution timestamp measured in nanoseconds.
 */
export type MonotonicTimestamp = bigint;

/**
 * Captures a monotonic timestamp for measuring an operation's elapsed duration.
 *
 * @returns {MonotonicTimestamp} The current high-resolution process timestamp.
 */
export function startTimer(): MonotonicTimestamp {
  return process.hrtime.bigint();
}

/**
 * Calculates elapsed milliseconds from a monotonic high-resolution timestamp.
 *
 * @param {MonotonicTimestamp} startedAt - The timestamp captured when the operation began.
 * @returns {number} The elapsed duration in milliseconds.
 */
export function elapsedMilliseconds(startedAt: MonotonicTimestamp): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
