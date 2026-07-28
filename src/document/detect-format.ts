import type { InputImageFormat } from "../types";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function ascii(data: Uint8Array, offset: number, value: string): boolean {
  return data.byteLength >= offset + value.length && [...value].every((character, index) => data[offset + index] === character.charCodeAt(0));
}

function hasPngSignature(data: Uint8Array): boolean {
  return data.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function heifBrand(data: Uint8Array): InputImageFormat | null {
  if (!ascii(data, 4, "ftyp") || data.byteLength < 12) return null;
  const brand = String.fromCharCode(...data.subarray(8, 12));
  if (["avif", "avis"].includes(brand)) return "avif";
  if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heif";
  return null;
}

/**
 * Detects a supported image format from its leading bytes without trusting a file extension.
 *
 * @param {Uint8Array} data - The image bytes to inspect.
 * @returns {InputImageFormat|null} The detected image format, or `null` when no supported signature matches.
 */
export function detectImageFormat(data: Uint8Array): InputImageFormat | null {
  if (hasPngSignature(data)) return "png";
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP")) return "webp";
  if (data.byteLength >= 4 && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0) || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 0x2a))) return "tiff";
  return heifBrand(data);
}
