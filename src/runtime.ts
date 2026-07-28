import sharp from "sharp";

/**
 * Releases the process-wide imaging caches that scanning leaves behind.
 *
 * Encoding populates the libvips operation cache, which is bounded but never
 * reclaimed on its own; after a batch it holds tens of megabytes for the
 * lifetime of the process. Call this once the application has finished scanning
 * to return that memory. Later scans still work and only lose the warm cache.
 *
 * The libvips cache is shared by every `sharp` user in the process, so this also
 * drops entries created elsewhere in the application.
 *
 * The OpenCV runtime is deliberately not released: its WebAssembly heap is held
 * by the `@opencvjs/node` module for the lifetime of the process, and
 * WebAssembly memory is never returned to the operating system.
 *
 * @returns {void}
 * @since 0.2.0
 *
 * @example
 * await scanDocument("./foto.jpg");
 * releaseScannerResources();
 */
export function releaseScannerResources(): void {
  const limits = sharp.cache();
  sharp.cache(false);
  sharp.cache({
    memory: limits.memory.max,
    files: limits.files.max,
    items: limits.items.max,
  });
}
