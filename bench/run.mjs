import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("./fixtures/", import.meta.url));
const RESULT_DIRECTORY = fileURLToPath(new URL("./results/", import.meta.url));
const DIST_ENTRY = new URL("../dist/index.js", import.meta.url);

const TIMING_KEYS = new Set(["durationMs", "loadDurationMs", "detectionDurationMs", "transformDurationMs", "encodeDurationMs"]);
const PDF_DIGEST = "nao-comparado: pdf-lib grava a data de criacao";

const CASES = [
  { fixture: "photo-perspective.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "photo-perspective.jpg", label: "fast", options: { performance: "fast" } },
  { fixture: "photo-perspective.jpg", label: "accurate", options: { performance: "accurate" } },
  { fixture: "photo-perspective.jpg", label: "balanced detect", api: "detect", options: { performance: "balanced" } },
  { fixture: "photo-perspective.jpg", label: "balanced manual", manual: true, options: { performance: "balanced" } },
  { fixture: "photo-perspective.jpg", label: "balanced jpeg", options: { performance: "balanced", output: { format: "jpeg" } } },
  { fixture: "photo-perspective.jpg", label: "balanced webp", options: { performance: "balanced", output: { format: "webp" } } },
  { fixture: "photo-perspective.jpg", label: "balanced pdf a4", options: { performance: "balanced", output: { format: "pdf" }, paperSize: "a4" } },
  { fixture: "photo-perspective.jpg", label: "balanced base64", options: { performance: "balanced", output: { format: "jpeg", encoding: "base64" } } },
  { fixture: "photo-perspective.jpg", label: "balanced grayscale", options: { performance: "balanced", enhancement: "grayscale" } },
  { fixture: "photo-perspective.jpg", label: "balanced black-white", options: { performance: "balanced", enhancement: "black-white" } },
  { fixture: "photo-perspective.jpg", label: "balanced sem realce", options: { performance: "balanced", enhancement: "none" } },
  { fixture: "photo-flat.png", label: "balanced", options: { performance: "balanced" } },
  { fixture: "photo-flat.png", label: "balanced papel auto", options: { performance: "balanced", paperSize: "auto" } },
  { fixture: "photo-lowcontrast.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "photo-lowcontrast.jpg", label: "accurate", options: { performance: "accurate" } },
  { fixture: "photo-blur.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "photo-blur.jpg", label: "accurate", options: { performance: "accurate" } },
  { fixture: "photo-large.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "photo-large.jpg", label: "fast", options: { performance: "fast" } },
  { fixture: "photo-rotated.webp", label: "balanced", options: { performance: "balanced" } },
  { fixture: "page-scan.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "nodocument.jpg", label: "balanced", options: { performance: "balanced" } },
  { fixture: "nodocument.jpg", label: "accurate", options: { performance: "accurate" } },
];

function parseArguments(argv) {
  const options = { save: null, compare: null, repeats: 1, filter: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--save" || flag === "--compare" || flag === "--filter") {
      if (value === undefined) {
        throw new Error(`${flag} exige um valor.`);
      }
      options[flag.slice(2)] = value;
      index += 1;
    } else if (flag === "--repeats") {
      options.repeats = Number(value);
      if (!Number.isInteger(options.repeats) || options.repeats < 1) {
        throw new Error("--repeats exige um inteiro maior que zero.");
      }
      index += 1;
    } else {
      throw new Error(`Argumento desconhecido: ${flag}`);
    }
  }
  return options;
}

function digestOf(data) {
  if (data === null) return null;
  return createHash("sha256").update(data).digest("hex");
}

function withoutTiming(result) {
  const { data, ...rest } = result;
  const snapshot = JSON.parse(JSON.stringify(rest, (key, value) => (TIMING_KEYS.has(key) ? 0 : value)));
  if (!("data" in result)) return snapshot;
  snapshot.dataDigest = digestOf(data);
  if (snapshot.output !== null && snapshot.output.format === "pdf") {
    snapshot.dataDigest = PDF_DIGEST;
    snapshot.output.byteLength = 0;
  }
  return snapshot;
}

function summarize(result) {
  const confidence = (result.detection?.confidence ?? 0).toFixed(2);
  if (result.output === undefined) return `${result.status.padEnd(9)} ${confidence}  ${result.detection === null ? "sem contorno" : result.detection.method}`;
  if (result.output === null) return `${result.status.padEnd(9)} ${confidence}  sem saída`;
  return `${result.status.padEnd(9)} ${confidence}  ${result.output.width}x${result.output.height} ${result.output.format.padEnd(4)} ${(result.output.byteLength / 1024).toFixed(0).padStart(5)} KiB`;
}

function loadResults(label) {
  const path = join(RESULT_DIRECTORY, `${label}.json`);
  if (!existsSync(path)) {
    throw new Error(`Execução salva não encontrada: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = parseArguments(process.argv.slice(2));

if (!existsSync(FIXTURE_DIRECTORY) || !existsSync(join(FIXTURE_DIRECTORY, "corners.json"))) {
  throw new Error("Fixtures ausentes. Rode `node bench/fixtures.mjs` primeiro.");
}
if (!existsSync(fileURLToPath(DIST_ENTRY))) {
  throw new Error("dist ausente. Rode `npm run build` primeiro.");
}

const { detectDocument, scanDocument, warmupScanner } = await import(DIST_ENTRY.href);
const groundTruth = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "corners.json"), "utf8"));
const selected = options.filter === null ? CASES : CASES.filter((entry) => `${entry.fixture} [${entry.label}]`.includes(options.filter));
if (selected.length === 0) {
  throw new Error(`Nenhum caso corresponde a "${options.filter}".`);
}

await warmupScanner();

const rows = [];
for (const entry of selected) {
  const data = new Uint8Array(readFileSync(join(FIXTURE_DIRECTORY, entry.fixture)));
  const manualCorners = groundTruth[entry.fixture];
  if (entry.manual === true && manualCorners === undefined) {
    throw new Error(`Cantos de referência ausentes para ${entry.fixture}. Rode \`node bench/fixtures.mjs\` de novo.`);
  }
  const scanOptions = entry.manual === true ? { ...entry.options, manualCorners } : entry.options;
  const timings = [];
  let snapshot = null;
  let summary = null;
  for (let attempt = 0; attempt < options.repeats; attempt += 1) {
    const startedAt = process.hrtime.bigint();
    const result = entry.api === "detect" ? await detectDocument(data, scanOptions) : await scanDocument(data, scanOptions);
    timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    snapshot ??= withoutTiming(result);
    summary ??= summarize(result);
  }
  const name = `${entry.fixture} [${entry.label}]`;
  rows.push({ case: name, bestMs: Number(Math.min(...timings).toFixed(1)), snapshot });
  console.log(`  ${name.padEnd(46)} ${Math.min(...timings).toFixed(0).padStart(7)} ms  ${summary}`);
}

const totalMs = rows.reduce((sum, row) => sum + row.bestMs, 0);
console.log(`\ntotal ${totalMs.toFixed(0)} ms`);

if (options.save !== null) {
  mkdirSync(RESULT_DIRECTORY, { recursive: true });
  writeFileSync(join(RESULT_DIRECTORY, `${options.save}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`gravado em bench/results/${options.save}.json`);
}

if (options.compare !== null) {
  const baseline = new Map(loadResults(options.compare).map((row) => [row.case, row]));
  let differences = 0;
  let baselineTotal = 0;
  console.log(`\ncomparando com ${options.compare}\n`);
  console.log(`${"caso".padEnd(46)} ${"antes".padStart(9)} ${"depois".padStart(9)} ${"delta".padStart(8)}   saída`);
  for (const row of rows) {
    const previous = baseline.get(row.case);
    if (previous === undefined) {
      console.log(`${row.case.padEnd(46)} ${"—".padStart(9)} ${String(row.bestMs).padStart(9)} ${"—".padStart(8)}   caso novo`);
      continue;
    }
    baselineTotal += previous.bestMs;
    const identical = JSON.stringify(previous.snapshot) === JSON.stringify(row.snapshot);
    if (!identical) {
      differences += 1;
    }
    const delta = `${((row.bestMs / previous.bestMs - 1) * 100).toFixed(0)}%`;
    console.log(`${row.case.padEnd(46)} ${String(previous.bestMs).padStart(9)} ${String(row.bestMs).padStart(9)} ${delta.padStart(8)}   ${identical ? "idêntica" : "*** DIFERENTE ***"}`);
  }
  if (baselineTotal > 0) {
    console.log(`\ntotal ${baselineTotal.toFixed(0)} ms -> ${totalMs.toFixed(0)} ms  (${((totalMs / baselineTotal - 1) * 100).toFixed(0)}%)`);
  }
  console.log(differences === 0 ? "todas as saídas idênticas" : `${differences} caso(s) com saída diferente`);
  if (differences > 0) {
    process.exitCode = 1;
  }
}
