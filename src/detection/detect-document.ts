import type { WorkGuard } from "../deadline";
import { arrayToCorners, cornersToArray, distance, orderCorners, polygonArea, touchesImageFrame } from "../geometry/points";
import { getOpenCv, type CvMat, type CvRuntime } from "../opencv";
import type { ResolvedOptions } from "../options";
import type { DecodedImage } from "../document/decode-image";
import type { DetectionMethod, DocumentDetection, Point } from "../types";

interface Candidate {
  points: [Point, Point, Point, Point];
  method: Exclude<DetectionMethod, "frame" | "manual">;
  areaRatio: number;
  edgeSupport: number;
  score: number;
}

interface LineSegment {
  start: Point;
  end: Point;
  length: number;
  rho: number;
}

interface FittedLine {
  point: Point;
  direction: Point;
}

/**
 * Describes the outcome of document-candidate analysis for one decoded image.
 */
interface DetectionStats {
  /** Reports how many contour, line, and frame candidates were evaluated. */
  candidatesEvaluated: number;
  /** Provides the selected document detection, or `null` when none qualifies. */
  detection: DocumentDetection | null;
}

const clamp = (value: number, minimum = 0, maximum = 1): number => Math.min(maximum, Math.max(minimum, value));

function medianLuminance(gray: CvMat): number {
  const histogram = new Uint32Array(256);
  for (const value of gray.data) histogram[value] = (histogram[value] ?? 0) + 1;
  const middle = gray.rows * gray.cols * 0.5;
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value] ?? 0;
    if (count >= middle) return value;
  }
  return 127;
}

function closeEdges(cv: CvRuntime, source: CvMat, size: number): CvMat {
  const result = new cv.Mat();
  let kernel: CvMat | null = null;
  let complete = false;
  try {
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
    cv.morphologyEx(source, result, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    complete = true;
    return result;
  } finally {
    kernel?.delete();
    if (!complete) result.delete();
  }
}

function buildEdgeMaps(cv: CvRuntime, gray: CvMat, profile: ResolvedOptions["performance"]): { maps: CvMat[]; combined: CvMat } {
  const owned: CvMat[] = [];
  const maps: CvMat[] = [];
  let combined: CvMat | null = null;
  try {
    const blur = new cv.Mat();
    owned.push(blur);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    const median = medianLuminance(blur);
    const adaptive = new cv.Mat();
    owned.push(adaptive);
    cv.Canny(blur, adaptive, Math.max(12, median * 0.1), Math.max(55, median * 0.34), 3, true);
    maps.push(closeEdges(cv, adaptive, profile === "fast" ? 3 : 5));

    if (profile !== "fast") {
      const strong = new cv.Mat();
      owned.push(strong);
      cv.Canny(blur, strong, 45, 135, 3, true);
      maps.push(closeEdges(cv, strong, 5));

      const binary = new cv.Mat();
      const binaryEdges = new cv.Mat();
      owned.push(binary, binaryEdges);
      cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.Canny(binary, binaryEdges, 20, 80, 3, false);
      maps.push(closeEdges(cv, binaryEdges, 5));
    }

    if (profile === "accurate") {
      const local = new cv.Mat();
      const localEdges = new cv.Mat();
      owned.push(local, localEdges);
      const blockSize = Math.min(51, Math.max(15, Math.round(Math.min(gray.rows, gray.cols) / 32) | 1));
      cv.adaptiveThreshold(blur, local, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 7);
      cv.Canny(local, localEdges, 15, 60, 3, false);
      maps.push(closeEdges(cv, localEdges, 7));
    }

    combined = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC1);
    for (const map of maps) cv.bitwise_or(combined, map, combined);
    return { maps, combined };
  } catch (error) {
    for (const map of maps) map.delete();
    combined?.delete();
    throw error;
  } finally {
    for (const mat of owned) mat.delete();
  }
}

function matPoints(mat: CvMat): [Point, Point, Point, Point] | null {
  if (mat.rows !== 4) return null;
  const values = mat.data32S;
  if (values.length < 8) return null;
  try {
    return cornersToArray(orderCorners([0, 1, 2, 3].map((index) => ({ x: values[index * 2] ?? Number.NaN, y: values[index * 2 + 1] ?? Number.NaN }))));
  } catch {
    return null;
  }
}

function samplePixel(data: Uint8Array, width: number, height: number, x: number, y: number): number | null {
  const column = Math.round(x);
  const row = Math.round(y);
  if (column < 0 || row < 0 || column >= width || row >= height) return null;
  return data[row * width + column] ?? null;
}

function edgeSupport(points: readonly Point[], edges: CvMat): number {
  const radius = Math.max(1, Math.min(3, Math.round(Math.min(edges.cols, edges.rows) / 500)));
  let supported = 0;
  let total = 0;
  for (let side = 0; side < points.length; side += 1) {
    const start = points[side];
    const end = points[(side + 1) % points.length];
    if (start === undefined || end === undefined) continue;
    const samples = Math.max(20, Math.round(distance(start, end) / 3));
    for (let index = 0; index <= samples; index += 1) {
      const t = index / samples;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      let hit = false;
      for (let offsetY = -radius; offsetY <= radius && !hit; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          if ((samplePixel(edges.data, edges.cols, edges.rows, x + offsetX, y + offsetY) ?? 0) > 0) {
            hit = true;
            break;
          }
        }
      }
      supported += hit ? 1 : 0;
      total += 1;
    }
  }
  return total === 0 ? 0 : supported / total;
}

function contrastSupport(points: readonly Point[], gray: CvMat): number {
  const offset = Math.max(4, Math.min(12, Math.round(Math.min(gray.cols, gray.rows) * 0.009)));
  let contrast = 0;
  let samplesUsed = 0;
  for (let side = 0; side < points.length; side += 1) {
    const start = points[side];
    const end = points[(side + 1) % points.length];
    if (start === undefined || end === undefined) continue;
    const length = distance(start, end);
    if (length < 1) continue;
    const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
    for (let index = 1; index <= 9; index += 1) {
      const t = index / 10;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      const inside = samplePixel(gray.data, gray.cols, gray.rows, x + normal.x * offset, y + normal.y * offset);
      const outside = samplePixel(gray.data, gray.cols, gray.rows, x - normal.x * offset, y - normal.y * offset);
      if (inside === null || outside === null) continue;
      contrast += clamp(Math.abs(inside - outside) / 70);
      samplesUsed += 1;
    }
  }
  return samplesUsed === 0 ? 0 : contrast / samplesUsed;
}

function angleScore(points: readonly Point[]): number {
  let score = 0;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (previous === undefined || current === undefined || next === undefined) continue;
    const a = { x: previous.x - current.x, y: previous.y - current.y };
    const b = { x: next.x - current.x, y: next.y - current.y };
    const denominator = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
    const angle = denominator === 0 ? 0 : (Math.acos(clamp((a.x * b.x + a.y * b.y) / denominator, -1, 1)) * 180) / Math.PI;
    score += clamp(1 - Math.abs(angle - 90) / 65);
  }
  return score / 4;
}

function parallelScore(points: readonly Point[]): number {
  const directions = points.map((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const length = distance(point, next) || 1;
    return { x: (next.x - point.x) / length, y: (next.y - point.y) / length };
  });
  const first = Math.abs((directions[0]?.x ?? 0) * (directions[2]?.x ?? 0) + (directions[0]?.y ?? 0) * (directions[2]?.y ?? 0));
  const second = Math.abs((directions[1]?.x ?? 0) * (directions[3]?.x ?? 0) + (directions[1]?.y ?? 0) * (directions[3]?.y ?? 0));
  return (first + second) / 2;
}

function evaluateCandidate(points: [Point, Point, Point, Point], method: Candidate["method"], gray: CvMat, edges: CvMat, minAreaRatio: number): Candidate | null {
  const areaRatio = polygonArea(points) / (gray.cols * gray.rows);
  if (areaRatio < minAreaRatio || areaRatio > 1.08) return null;
  const edgesScore = edgeSupport(points, edges);
  const contrast = contrastSupport(points, gray);
  const angles = angleScore(points);
  const parallel = parallelScore(points);
  const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const centerDistance = Math.hypot(centroid.x - gray.cols / 2, centroid.y - gray.rows / 2) / Math.hypot(gray.cols / 2, gray.rows / 2);
  const center = clamp(1 - centerDistance);
  const widths = [distance(points[0], points[1]), distance(points[2], points[3])];
  const heights = [distance(points[1], points[2]), distance(points[3], points[0])];
  const ratio = Math.max(...widths) / Math.max(1, Math.max(...heights));
  const aspect = ratio >= 0.25 && ratio <= 4 ? 1 : clamp(1 - Math.abs(Math.log(ratio)) / 3);
  const area = clamp((areaRatio - minAreaRatio) / Math.max(0.2, 0.72 - minAreaRatio));
  const score = clamp(area * 0.22 + edgesScore * 0.22 + contrast * 0.22 + angles * 0.14 + parallel * 0.08 + center * 0.07 + aspect * 0.05);
  return { points, method, areaRatio, edgeSupport: edgesScore, score };
}

function candidateDistance(a: Candidate, b: Candidate, diagonal: number): number {
  return a.points.reduce((sum, point, index) => sum + distance(point, b.points[index] ?? point) / diagonal, 0) / 4;
}

function retainCandidate(candidates: Candidate[], candidate: Candidate, maximum: number, diagonal: number): void {
  const duplicate = candidates.findIndex((existing) => candidateDistance(existing, candidate, diagonal) < 0.015);
  if (duplicate >= 0) {
    if ((candidates[duplicate]?.score ?? 0) < candidate.score) candidates[duplicate] = candidate;
  } else {
    candidates.push(candidate);
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > maximum) candidates.length = maximum;
}

function contourCandidates(cv: CvRuntime, maps: readonly CvMat[], gray: CvMat, combined: CvMat, options: ResolvedOptions, guard: WorkGuard): { candidates: Candidate[]; evaluated: number } {
  const candidates: Candidate[] = [];
  const diagonal = Math.hypot(gray.cols, gray.rows);
  const maximum = options.performance === "fast" ? 40 : options.performance === "balanced" ? 120 : 220;
  const epsilonRatios = options.performance === "fast" ? [0.02, 0.04] : options.performance === "balanced" ? [0.012, 0.02, 0.035, 0.055] : [0.008, 0.014, 0.022, 0.035, 0.05, 0.07];
  let evaluated = 0;

  for (const map of maps) {
    guard.check();
    const contours = new cv.MatVector();
    let hierarchy: CvMat | null = null;
    try {
      hierarchy = new cv.Mat();
      cv.findContours(map, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        if (index % 100 === 0) guard.check();
        const contour = contours.get(index);
        try {
          const contourArea = Math.abs(cv.contourArea(contour, false));
          if (contourArea < gray.cols * gray.rows * options.minDocumentAreaRatio * 0.7) continue;
          const perimeter = cv.arcLength(contour, true);
          if (perimeter < Math.min(gray.cols, gray.rows) * 0.8) continue;
          const hull = new cv.Mat();
          try {
            cv.convexHull(contour, hull, false, true);
            const hullPerimeter = cv.arcLength(hull, true);
            for (const epsilonRatio of epsilonRatios) {
              const approximation = new cv.Mat();
              try {
                cv.approxPolyDP(hull, approximation, hullPerimeter * epsilonRatio, true);
                const points = matPoints(approximation);
                if (points === null || !cv.isContourConvex(approximation)) continue;
                evaluated += 1;
                const candidate = evaluateCandidate(points, "contour", gray, combined, options.minDocumentAreaRatio);
                if (candidate !== null) retainCandidate(candidates, candidate, maximum, diagonal);
              } finally {
                approximation.delete();
              }
            }
          } finally {
            hull.delete();
          }
        } finally {
          contour.delete();
        }
      }
    } finally {
      contours.delete();
      hierarchy?.delete();
    }
  }
  return { candidates, evaluated };
}

function intersectSegments(first: LineSegment, second: LineSegment): Point | null {
  const x1 = first.start.x;
  const y1 = first.start.y;
  const x2 = first.end.x;
  const y2 = first.end.y;
  const x3 = second.start.x;
  const y3 = second.start.y;
  const x4 = second.end.x;
  const y4 = second.end.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 1e-6) return null;
  return {
    x: ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator,
    y: ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator,
  };
}

function extremeLines(lines: LineSegment[], low: boolean): LineSegment[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.rho - b.rho);
  const edgeCount = Math.min(sorted.length, 8);
  return (low ? sorted.slice(0, edgeCount) : sorted.slice(-edgeCount)).sort((a, b) => b.length - a.length).slice(0, 3);
}

function lineCandidates(cv: CvRuntime, gray: CvMat, combined: CvMat, options: ResolvedOptions, guard: WorkGuard): { candidates: Candidate[]; evaluated: number } {
  const result: Candidate[] = [];
  const linesMat = new cv.Mat();
  let evaluated = 0;
  try {
    cv.HoughLinesP(combined, linesMat, 1, Math.PI / 360, Math.max(35, Math.round(Math.min(gray.cols, gray.rows) * 0.055)), Math.min(gray.cols, gray.rows) * 0.24, Math.min(gray.cols, gray.rows) * 0.035);
    const horizontal: LineSegment[] = [];
    const vertical: LineSegment[] = [];
    for (let index = 0; index < linesMat.rows; index += 1) {
      const offset = index * 4;
      const start = { x: linesMat.data32S[offset] ?? 0, y: linesMat.data32S[offset + 1] ?? 0 };
      const end = { x: linesMat.data32S[offset + 2] ?? 0, y: linesMat.data32S[offset + 3] ?? 0 };
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length < Math.min(gray.cols, gray.rows) * 0.18) continue;
      if (Math.abs(dx) >= Math.abs(dy)) {
        const normal = dx >= 0 ? { x: -dy / length, y: dx / length } : { x: dy / length, y: -dx / length };
        horizontal.push({ start, end, length, rho: normal.x * (start.x + end.x) * 0.5 + normal.y * (start.y + end.y) * 0.5 });
      } else {
        const normal = dy >= 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
        vertical.push({ start, end, length, rho: normal.x * (start.x + end.x) * 0.5 + normal.y * (start.y + end.y) * 0.5 });
      }
    }

    const topLines = extremeLines(horizontal, true);
    const bottomLines = extremeLines(horizontal, false);
    const leftLines = extremeLines(vertical, true);
    const rightLines = extremeLines(vertical, false);
    const diagonal = Math.hypot(gray.cols, gray.rows);
    for (const top of topLines) {
      for (const bottom of bottomLines) {
        for (const left of leftLines) {
          for (const right of rightLines) {
            guard.check();
            const raw = [intersectSegments(top, left), intersectSegments(top, right), intersectSegments(bottom, right), intersectSegments(bottom, left)];
            if (raw.some((point) => point === null)) continue;
            let points: [Point, Point, Point, Point];
            try {
              points = cornersToArray(orderCorners(raw as Point[]));
            } catch {
              continue;
            }
            if (points.some((point) => point.x < -gray.cols * 0.08 || point.y < -gray.rows * 0.08 || point.x > gray.cols * 1.08 || point.y > gray.rows * 1.08)) continue;
            evaluated += 1;
            const candidate = evaluateCandidate(points, "lines", gray, combined, options.minDocumentAreaRatio);
            if (candidate !== null) retainCandidate(result, candidate, 40, diagonal);
          }
        }
      }
    }
  } finally {
    linesMat.delete();
  }
  return { candidates: result, evaluated };
}

function fitSide(points: readonly Point[], start: Point, end: Point): FittedLine {
  if (points.length < 12) return { point: start, direction: { x: end.x - start.x, y: end.y - start.y } };
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const x = point.x - center.x;
    const y = point.y - center.y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  let direction = { x: Math.cos(angle), y: Math.sin(angle) };
  if (direction.x * (end.x - start.x) + direction.y * (end.y - start.y) < 0) direction = { x: -direction.x, y: -direction.y };
  return { point: center, direction };
}

function fitEdgeSide(edges: CvMat, start: Point, end: Point): FittedLine {
  const length = distance(start, end);
  if (length < 1) return { point: start, direction: { x: end.x - start.x, y: end.y - start.y } };
  const tangent = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const normal = { x: -tangent.y, y: tangent.x };
  const band = Math.max(3, Math.min(10, Math.round(Math.min(edges.cols, edges.rows) * 0.006)));
  const extension = length * 0.025;
  const minimumX = Math.max(0, Math.floor(Math.min(start.x, end.x) - band - Math.abs(tangent.x) * extension));
  const maximumX = Math.min(edges.cols - 1, Math.ceil(Math.max(start.x, end.x) + band + Math.abs(tangent.x) * extension));
  const minimumY = Math.max(0, Math.floor(Math.min(start.y, end.y) - band - Math.abs(tangent.y) * extension));
  const maximumY = Math.min(edges.rows - 1, Math.ceil(Math.max(start.y, end.y) + band + Math.abs(tangent.y) * extension));
  const points: Point[] = [];
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      if ((edges.data[y * edges.cols + x] ?? 0) === 0) continue;
      const relative = { x: x - start.x, y: y - start.y };
      const along = relative.x * tangent.x + relative.y * tangent.y;
      const across = Math.abs(relative.x * normal.x + relative.y * normal.y);
      if (along >= -extension && along <= length + extension && across <= band) points.push({ x, y });
    }
  }
  return fitSide(points, start, end);
}

function intersectLines(first: FittedLine, second: FittedLine): Point | null {
  const determinant = first.direction.x * second.direction.y - first.direction.y * second.direction.x;
  if (Math.abs(determinant) < 1e-6) return null;
  const delta = { x: second.point.x - first.point.x, y: second.point.y - first.point.y };
  const scale = (delta.x * second.direction.y - delta.y * second.direction.x) / determinant;
  return { x: first.point.x + first.direction.x * scale, y: first.point.y + first.direction.y * scale };
}

function refineCandidate(candidate: Candidate, edges: CvMat): Candidate {
  const sides = candidate.points.map((point, index) => fitEdgeSide(edges, point, candidate.points[(index + 1) % 4] ?? point));
  const intersections = [intersectLines(sides[3] ?? sides[0]!, sides[0]!), intersectLines(sides[0]!, sides[1]!), intersectLines(sides[1]!, sides[2]!), intersectLines(sides[2]!, sides[3]!)];
  if (intersections.some((point) => point === null)) return candidate;
  let refined: [Point, Point, Point, Point];
  try {
    refined = cornersToArray(orderCorners(intersections as Point[]));
  } catch {
    return candidate;
  }
  const maximumShift = Math.min(edges.cols, edges.rows) * 0.035;
  if (refined.some((point, index) => distance(point, candidate.points[index] ?? point) > maximumShift) || polygonArea(refined) < polygonArea(candidate.points) * 0.88) return candidate;
  return { ...candidate, points: refined };
}

function frameDetection(gray: CvMat, options: ResolvedOptions): DocumentDetection | null {
  if (!options.allowFrameFallback) return null;
  let bright = 0;
  let dark = 0;
  let sum = 0;
  const gridColumns = 4;
  const gridRows = 6;
  const darkCells = new Uint32Array(gridColumns * gridRows);
  for (let index = 0; index < gray.data.length; index += 1) {
    const value = gray.data[index] ?? 0;
    sum += value;
    if (value >= 165) bright += 1;
    if (value <= 110) {
      dark += 1;
      const x = index % gray.cols;
      const y = Math.floor(index / gray.cols);
      const column = Math.min(gridColumns - 1, Math.floor((x * gridColumns) / gray.cols));
      const row = Math.min(gridRows - 1, Math.floor((y * gridRows) / gray.rows));
      const cellIndex = row * gridColumns + column;
      darkCells[cellIndex] = (darkCells[cellIndex] ?? 0) + 1;
    }
  }
  const pixels = gray.rows * gray.cols;
  const brightRatio = bright / pixels;
  const darkRatio = dark / pixels;
  const mean = sum / pixels;
  const aspect = Math.min(gray.cols, gray.rows) / Math.max(gray.cols, gray.rows);
  const occupiedRows = new Set<number>();
  const occupiedColumns = new Set<number>();
  let occupiedCells = 0;
  const minimumCellDarkPixels = Math.max(2, Math.floor(pixels / (gridColumns * gridRows) / 1000));
  for (let index = 0; index < darkCells.length; index += 1) {
    if ((darkCells[index] ?? 0) < minimumCellDarkPixels) continue;
    occupiedCells += 1;
    occupiedRows.add(Math.floor(index / gridColumns));
    occupiedColumns.add(index % gridColumns);
  }
  if (brightRatio < 0.62 || darkRatio < 0.002 || mean < 160 || aspect < 0.35 || occupiedCells < 6 || occupiedRows.size < 3 || occupiedColumns.size < 2) return null;
  const corners = arrayToCorners([
    { x: 0, y: 0 },
    { x: gray.cols - 1, y: 0 },
    { x: gray.cols - 1, y: gray.rows - 1 },
    { x: 0, y: gray.rows - 1 },
  ]);
  const confidence = clamp(0.47 + brightRatio * 0.12 + Math.min(0.08, darkRatio * 1.6));
  if (confidence < options.minConfidence) return null;
  return { corners, confidence, method: "frame", areaRatio: 1, edgeSupport: 0, touchesFrame: true, candidatesEvaluated: 1 };
}

/**
 * Selects a document quadrilateral through contour, line, and whole-frame
 * analysis governed by the resolved performance profile.
 *
 * @param {DecodedImage} image - The oriented RGBA image raster to analyze.
 * @param {ResolvedOptions} options - The validated detection thresholds and performance profile.
 * @param {WorkGuard} guard - The operation guard used to enforce cancellation and timeout limits.
 * @returns {Promise<DetectionStats>} Resolves with the accepted detection and total number of evaluated candidates.
 * @throws {ScanFailure} If cancellation or the deadline stops the operation.
 * @throws {Error} If OpenCV initialization or processing fails.
 */
export async function detectCorners(image: DecodedImage, options: ResolvedOptions, guard: WorkGuard): Promise<DetectionStats> {
  const cv = await getOpenCv();
  guard.check();
  let source: CvMat | null = null;
  let gray: CvMat | null = null;
  let maps: CvMat[] = [];
  let combined: CvMat | null = null;
  try {
    source = cv.matFromArray(image.height, image.width, cv.CV_8UC4, image.data);
    gray = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    const edgeMaps = buildEdgeMaps(cv, gray, options.performance);
    maps = edgeMaps.maps;
    combined = edgeMaps.combined;
    const contours = contourCandidates(cv, maps, gray, combined, options, guard);
    let candidates = contours.candidates;
    let evaluated = contours.evaluated;
    if (options.performance === "accurate" || (candidates[0]?.score ?? 0) < 0.72) {
      const lines = lineCandidates(cv, gray, combined, options, guard);
      candidates = [...candidates, ...lines.candidates].sort((a, b) => b.score - a.score);
      evaluated += lines.evaluated;
    }

    const best = candidates[0];
    if (best !== undefined && best.score >= options.minConfidence) {
      const refined = options.performance === "fast" ? best : refineCandidate(best, combined);
      const corners = arrayToCorners(refined.points);
      const frame = frameDetection(gray, options);
      if (frame !== null && refined.areaRatio >= 0.65 && touchesImageFrame(corners, image.width, image.height)) {
        return { candidatesEvaluated: evaluated + 1, detection: { ...frame, candidatesEvaluated: evaluated + 1 } };
      }
      return {
        candidatesEvaluated: evaluated,
        detection: {
          corners,
          confidence: best.score,
          method: best.method,
          areaRatio: polygonArea(refined.points) / (image.width * image.height),
          edgeSupport: best.edgeSupport,
          touchesFrame: touchesImageFrame(corners, image.width, image.height),
          candidatesEvaluated: evaluated,
        },
      };
    }

    const frame = frameDetection(gray, options);
    return { candidatesEvaluated: evaluated + (frame === null ? 0 : 1), detection: frame === null ? null : { ...frame, candidatesEvaluated: evaluated + 1 } };
  } finally {
    for (const map of maps) map.delete();
    combined?.delete();
    gray?.delete();
    source?.delete();
  }
}
