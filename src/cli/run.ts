import { writeFile } from "node:fs/promises";
import { extname } from "node:path";

import { scanDocument } from "../scanner";
import type { DocumentCorners, EnhancementMode, OutputEncoding, OutputFormat, PaperSize, PerformanceProfile, ScanOptions } from "../types";

interface ParsedArguments {
  input: string;
  outputPath?: string;
  force: boolean;
  pretty: boolean;
  options: ScanOptions<OutputEncoding>;
}

interface CliFailure {
  status: "error";
  success: false;
  error: { code: "INVALID_INPUT" | "PROCESSING_ERROR"; message: string };
}

const HELP = {
  name: "cerne-scanner",
  usage: "cerne-scanner <imagem-ou-url> (--output <arquivo> | --encoding base64|data-url) [opcoes]",
  inputFormats: ["jpeg", "png", "webp", "tiff", "avif", "heif"],
  outputFormats: ["png", "jpeg", "webp", "pdf"],
  options: [
    { name: "--output", value: "<arquivo>", description: "Grava bytes corrigidos sem misturá-los ao JSON do stdout." },
    { name: "--format", value: "png|jpeg|webp|pdf", description: "Define o contêiner de saída; por padrão usa a extensão de --output ou PNG." },
    { name: "--encoding", value: "base64|data-url", description: "Devolve a saída textual no JSON em vez de gravar um arquivo." },
    { name: "--performance", value: "fast|balanced|accurate", description: "Seleciona profundidade e resolução de detecção." },
    { name: "--enhancement", value: "none|color|grayscale|black-white", description: "Aplica melhoria conservadora depois da correção." },
    { name: "--paper-size", value: "detected|auto|a4|letter", description: "Controla a proporção final." },
    { name: "--quality", value: "1..100", description: "Controla qualidade JPEG/WebP e raster do PDF." },
    { name: "--min-confidence", value: "0..1", description: "Define a confiança mínima para correção automática." },
    { name: "--padding", value: "0..0.05", description: "Expande o quadrilátero antes do recorte." },
    { name: "--corners", value: "x,y;x,y;x,y;x,y", description: "Usa cantos manuais na ordem TL,TR,BR,BL da imagem orientada." },
    { name: "--detection-size", value: "320..4096", description: "Sobrescreve o maior eixo usado na análise." },
    { name: "--max-file-size", value: "<bytes>", description: "Limita bytes de entrada local, remota ou em memória." },
    { name: "--max-input-pixels", value: "<pixels>", description: "Limita a área declarada da imagem de origem." },
    { name: "--max-output-pixels", value: "<pixels>", description: "Limita a área do raster corrigido." },
    { name: "--timeout-ms", value: "<ms>", description: "Limita download e processamento; zero desabilita." },
    { name: "--no-frame-fallback", description: "Não preserva o quadro inteiro quando a folha já ocupa a imagem." },
    { name: "--force", description: "Permite substituir o arquivo indicado por --output." },
    { name: "--pretty", description: "Indenta o JSON com dois espaços." },
    { name: "--help", description: "Imprime este descritor JSON." },
  ],
  examples: ["cerne-scanner ./foto.jpg --output ./scan.png --pretty", "cerne-scanner ./foto.jpg --output ./scan.pdf --paper-size a4 --enhancement color", "cerne-scanner https://example.com/documento.webp --encoding base64 --format jpeg"],
};

class ArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ArgumentError(`${name} requires a value.`);
  return value;
}

function numericValue(name: string, value: string): number {
  if (value.trim() === "") throw new ArgumentError(`${name} requires a numeric value.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ArgumentError(`${name} requires a finite numeric value.`);
  return parsed;
}

function enumValue<T extends string>(name: string, value: string, accepted: readonly T[]): T {
  if (!accepted.includes(value as T)) throw new ArgumentError(`${name} must be ${accepted.join(", ")}.`);
  return value as T;
}

function parseCorners(value: string): DocumentCorners {
  const points = value.split(";").map((pair) => {
    const coordinates = pair.split(",");
    if (coordinates.length !== 2) throw new ArgumentError("--corners requires x,y;x,y;x,y;x,y.");
    return { x: numericValue("--corners", coordinates[0] ?? ""), y: numericValue("--corners", coordinates[1] ?? "") };
  });
  if (points.length !== 4) throw new ArgumentError("--corners requires exactly four points.");
  return { topLeft: points[0]!, topRight: points[1]!, bottomRight: points[2]!, bottomLeft: points[3]! };
}

function formatFromPath(path: string): OutputFormat | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  if (extension === ".webp") return "webp";
  if (extension === ".pdf") return "pdf";
  return null;
}

function parseArguments(args: string[]): ParsedArguments {
  const sources: string[] = [];
  let outputPath: string | undefined;
  let format: OutputFormat | undefined;
  let encoding: OutputEncoding = "buffer";
  let performance: PerformanceProfile | undefined;
  let enhancement: EnhancementMode | undefined;
  let paperSize: PaperSize | undefined;
  let quality: number | undefined;
  let minConfidence: number | undefined;
  let paddingRatio: number | undefined;
  let manualCorners: DocumentCorners | undefined;
  let detectionMaxDimension: number | undefined;
  let maxFileSizeBytes: number | undefined;
  let maxInputPixels: number | undefined;
  let maxOutputPixels: number | undefined;
  let timeoutMs: number | undefined;
  let allowFrameFallback = true;
  let force = false;
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      sources.push(argument);
      continue;
    }
    if (argument === "--pretty") pretty = true;
    else if (argument === "--force") force = true;
    else if (argument === "--no-frame-fallback") allowFrameFallback = false;
    else if (argument === "--output") outputPath = optionValue(args, index++, argument);
    else if (argument === "--format") format = enumValue(argument, optionValue(args, index++, argument), ["png", "jpeg", "webp", "pdf"] as const);
    else if (argument === "--encoding") encoding = enumValue(argument, optionValue(args, index++, argument), ["base64", "data-url"] as const);
    else if (argument === "--performance") performance = enumValue(argument, optionValue(args, index++, argument), ["fast", "balanced", "accurate"] as const);
    else if (argument === "--enhancement") enhancement = enumValue(argument, optionValue(args, index++, argument), ["none", "color", "grayscale", "black-white"] as const);
    else if (argument === "--paper-size") paperSize = enumValue(argument, optionValue(args, index++, argument), ["detected", "auto", "a4", "letter"] as const);
    else if (argument === "--quality") quality = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--min-confidence") minConfidence = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--padding") paddingRatio = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--corners") manualCorners = parseCorners(optionValue(args, index++, argument));
    else if (argument === "--detection-size") detectionMaxDimension = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--max-file-size") maxFileSizeBytes = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--max-input-pixels") maxInputPixels = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--max-output-pixels") maxOutputPixels = numericValue(argument, optionValue(args, index++, argument));
    else if (argument === "--timeout-ms") timeoutMs = numericValue(argument, optionValue(args, index++, argument));
    else throw new ArgumentError(`Unknown option: ${argument}.`);
  }

  if (sources.length !== 1) throw new ArgumentError("Exactly one image path or HTTP(S) URL is required.");
  if (outputPath === undefined && encoding === "buffer") throw new ArgumentError("Use --output for binary output, or select --encoding base64|data-url.");
  if (outputPath !== undefined && encoding !== "buffer") throw new ArgumentError("--output and textual --encoding are mutually exclusive.");
  const inferredFormat = outputPath === undefined ? null : formatFromPath(outputPath);
  if (format !== undefined && inferredFormat !== null && format !== inferredFormat) throw new ArgumentError("--format conflicts with the extension of --output.");
  format ??= inferredFormat ?? "png";

  return {
    input: sources[0]!,
    ...(outputPath === undefined ? {} : { outputPath }),
    force,
    pretty,
    options: {
      output: { format, encoding, ...(quality === undefined ? {} : { quality }) },
      ...(performance === undefined ? {} : { performance }),
      ...(enhancement === undefined ? {} : { enhancement }),
      ...(paperSize === undefined ? {} : { paperSize }),
      ...(minConfidence === undefined ? {} : { minConfidence }),
      ...(paddingRatio === undefined ? {} : { paddingRatio }),
      ...(manualCorners === undefined ? {} : { manualCorners }),
      ...(detectionMaxDimension === undefined ? {} : { detectionMaxDimension }),
      ...(maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes }),
      ...(maxInputPixels === undefined ? {} : { maxInputPixels }),
      ...(maxOutputPixels === undefined ? {} : { maxOutputPixels }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      allowFrameFallback,
    },
  };
}

function printJson(value: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function argumentFailure(error: unknown): CliFailure {
  return { status: "error", success: false, error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : "Invalid command-line arguments." } };
}

/**
 * Runs one scanner CLI invocation and reports its outcome through JSON and a process exit code.
 *
 * @param {Array<string>} args - The command-line arguments excluding the executable and script paths.
 * @returns {Promise<number>} Resolves with zero for help or a scan result containing output, including partial detection; two for `not_found`; or one otherwise.
 * @throws {Error} If a JSON response cannot be written to standard output.
 */
export async function runCli(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    printJson(HELP, args.includes("--pretty"));
    return 0;
  }

  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    printJson(argumentFailure(error), args.includes("--pretty"));
    return 1;
  }

  const result = await scanDocument(parsed.input, parsed.options);
  if (result.success && parsed.outputPath !== undefined) {
    if (!Buffer.isBuffer(result.data)) {
      printJson({ status: "error", success: false, error: { code: "PROCESSING_ERROR", message: "The scanner did not return binary output for --output." } }, parsed.pretty);
      return 1;
    }
    try {
      await writeFile(parsed.outputPath, result.data, { flag: parsed.force ? "w" : "wx" });
    } catch {
      printJson({ status: "error", success: false, error: { code: "PROCESSING_ERROR", message: "The output file could not be written. Use --force only when replacing it is intentional." } }, parsed.pretty);
      return 1;
    }
  }

  const response = parsed.outputPath === undefined ? result : { ...result, data: undefined, outputWritten: result.success };
  printJson(response, parsed.pretty);
  if (result.success) return 0;
  return result.status === "not_found" ? 2 : 1;
}
