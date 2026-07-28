import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const OUTPUT_DIRECTORY = fileURLToPath(new URL("./fixtures/", import.meta.url));

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createRaster(width, height, color) {
  const data = new Uint8Array(width * height * 3);
  for (let offset = 0; offset < data.length; offset += 3) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
  }
  return { width, height, data };
}

function fillRect(raster, x, y, width, height, color) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(raster.width, Math.round(x + width));
  const bottom = Math.min(raster.height, Math.round(y + height));
  for (let row = top; row < bottom; row += 1) {
    let offset = (row * raster.width + left) * 3;
    for (let column = left; column < right; column += 1) {
      raster.data[offset] = color[0];
      raster.data[offset + 1] = color[1];
      raster.data[offset + 2] = color[2];
      offset += 3;
    }
  }
}

function pageRaster() {
  const page = createRaster(PAGE_WIDTH, PAGE_HEIGHT, [251, 250, 246]);
  const random = randomGenerator(20260726);
  const margin = 96;
  const columnWidth = PAGE_WIDTH - margin * 2;

  fillRect(page, margin, 118, Math.round(columnWidth * 0.62), 44, [24, 24, 28]);
  fillRect(page, margin, 188, Math.round(columnWidth * 0.36), 18, [96, 98, 102]);
  fillRect(page, PAGE_WIDTH - margin - 180, 118, 180, 96, [214, 214, 210]);

  let y = 268;
  for (let line = 0; line < 24; line += 1) {
    fillRect(page, margin, y, Math.round(columnWidth * (0.52 + random() * 0.48)), 14, [36, 36, 40]);
    y += 34;
  }

  fillRect(page, margin, y + 22, columnWidth, 3, [118, 118, 122]);

  const tableTop = y + 62;
  const rowHeight = 52;
  const cellWidth = columnWidth / 4;
  for (let row = 0; row <= 6; row += 1) fillRect(page, margin, tableTop + row * rowHeight, columnWidth, 2, [108, 108, 112]);
  for (let column = 0; column <= 4; column += 1) fillRect(page, margin + column * cellWidth, tableTop, 2, rowHeight * 6, [108, 108, 112]);
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      fillRect(page, margin + column * cellWidth + 18, tableTop + row * rowHeight + 19, Math.round(cellWidth * (0.28 + random() * 0.42)), 13, [46, 46, 50]);
    }
  }

  const blockTop = tableTop + rowHeight * 6 + 64;
  for (let row = 0; row < 150; row += 1) {
    for (let column = 0; column < 420; column += 1) {
      const tone = 108 + Math.round(Math.sin(column * 0.05 + row * 0.03) * 26 + random() * 24);
      fillRect(page, margin + column, blockTop + row, 1, 1, [tone, tone - 4, tone - 10]);
    }
  }
  for (let line = 0; line < 4; line += 1) {
    fillRect(page, margin + 460, blockTop + 12 + line * 34, Math.round(columnWidth * (0.24 + random() * 0.26)), 13, [44, 44, 48]);
  }

  fillRect(page, margin, PAGE_HEIGHT - 118, Math.round(columnWidth * 0.44), 12, [82, 84, 88]);
  return page;
}

function deskRaster(width, height, style) {
  const random = randomGenerator(style.seed);
  const raster = createRaster(width, height, style.base);
  for (let row = 0; row < height; row += 1) {
    let offset = row * width * 3;
    for (let column = 0; column < width; column += 1) {
      const grain = Math.sin(column * 0.017 + Math.sin(row * 0.011) * 5.5) * style.grain + (random() - 0.5) * style.noise;
      for (let channel = 0; channel < 3; channel += 1) {
        raster.data[offset + channel] = Math.min(255, Math.max(0, style.base[channel] + grain));
      }
      offset += 3;
    }
  }
  return raster;
}

function clutterRaster(width, height) {
  const random = randomGenerator(19870301);
  const raster = deskRaster(width, height, { seed: 5150, base: [104, 100, 96], grain: 9, noise: 14 });
  for (let index = 0; index < 12; index += 1) {
    const thickness = 6 + Math.round(random() * 14);
    const length = Math.round(height * (0.35 + random() * 0.55));
    const tone = 52 + Math.round(random() * 70);
    if (random() < 0.5) fillRect(raster, random() * width, random() * height - length * 0.3, thickness, length, [tone, tone - 4, tone - 8]);
    else fillRect(raster, random() * width - length * 0.3, random() * height, length, thickness, [tone, tone - 4, tone - 8]);
  }
  for (let index = 0; index < 170; index += 1) {
    const boxWidth = Math.round(width * (0.02 + random() * 0.09));
    const boxHeight = Math.round(height * (0.015 + random() * 0.07));
    const tone = 44 + Math.round(random() * 118);
    fillRect(raster, random() * width - boxWidth * 0.5, random() * height - boxHeight * 0.5, boxWidth, boxHeight, [tone, tone - 6, tone - 12]);
  }
  return raster;
}

function gaussianSolve(matrix, vector) {
  const size = vector.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [vector[column], vector[pivot]] = [vector[pivot], vector[column]];
    const divisor = matrix[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error("Homografia degenerada: verifique os quatro cantos da fixture.");
    for (let row = column + 1; row < size; row += 1) {
      const factor = matrix[row][column] / divisor;
      if (factor === 0) continue;
      for (let index = column; index < size; index += 1) matrix[row][index] -= factor * matrix[column][index];
      vector[row] -= factor * vector[column];
    }
  }
  const solution = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let accumulated = vector[row];
    for (let column = row + 1; column < size; column += 1) accumulated -= matrix[row][column] * solution[column];
    solution[row] = accumulated / matrix[row][row];
  }
  return solution;
}

function homography(source, target) {
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = target[index];
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u], [0, 0, 0, x, y, 1, -x * v, -y * v]);
    vector.push(u, v);
  }
  return gaussianSolve(matrix, vector);
}

function project(transform, x, y) {
  const denominator = transform[6] * x + transform[7] * y + 1;
  return { x: (transform[0] * x + transform[1] * y + transform[2]) / denominator, y: (transform[3] * x + transform[4] * y + transform[5]) / denominator };
}

function sampleBilinear(raster, x, y, channel) {
  const clampedX = Math.min(raster.width - 1, Math.max(0, x));
  const clampedY = Math.min(raster.height - 1, Math.max(0, y));
  const left = Math.floor(clampedX);
  const top = Math.floor(clampedY);
  const right = Math.min(raster.width - 1, left + 1);
  const bottom = Math.min(raster.height - 1, top + 1);
  const weightX = clampedX - left;
  const weightY = clampedY - top;
  const topLeft = raster.data[(top * raster.width + left) * 3 + channel];
  const topRight = raster.data[(top * raster.width + right) * 3 + channel];
  const bottomLeft = raster.data[(bottom * raster.width + left) * 3 + channel];
  const bottomRight = raster.data[(bottom * raster.width + right) * 3 + channel];
  return topLeft + (topRight - topLeft) * weightX + (bottomLeft - topLeft + (bottomRight - bottomLeft - topRight + topLeft) * weightX) * weightY;
}

function compositeQuad(target, source, quad) {
  const corners = [
    { x: 0, y: 0 },
    { x: source.width - 1, y: 0 },
    { x: source.width - 1, y: source.height - 1 },
    { x: 0, y: source.height - 1 },
  ];
  const transform = homography(quad, corners);
  const edges = quad.map((point, index) => {
    const next = quad[(index + 1) % 4];
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    return { x: point.x, y: point.y, nx: -(next.y - point.y) / length, ny: (next.x - point.x) / length };
  });
  const left = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x)) - 2));
  const top = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y)) - 2));
  const right = Math.min(target.width - 1, Math.ceil(Math.max(...quad.map((point) => point.x)) + 2));
  const bottom = Math.min(target.height - 1, Math.ceil(Math.max(...quad.map((point) => point.y)) + 2));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      let inside = Infinity;
      for (const edge of edges) {
        const distance = edge.nx * (x - edge.x) + edge.ny * (y - edge.y);
        if (distance < inside) inside = distance;
      }
      if (inside < -0.5) continue;
      const alpha = Math.min(1, inside + 0.5);
      const point = project(transform, x, y);
      const offset = (y * target.width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const sampled = sampleBilinear(source, point.x, point.y, channel);
        target.data[offset + channel] = Math.round(target.data[offset + channel] * (1 - alpha) + sampled * alpha);
      }
    }
  }
  return target;
}

function shade(raster, { seed, noise, falloff, tilt }) {
  const random = randomGenerator(seed);
  for (let row = 0; row < raster.height; row += 1) {
    const normalizedY = row / raster.height;
    let offset = row * raster.width * 3;
    for (let column = 0; column < raster.width; column += 1) {
      const normalizedX = column / raster.width;
      const radial = (normalizedX - 0.5) ** 2 + (normalizedY - 0.52) ** 2;
      const factor = 1 - falloff * radial + tilt * (0.5 - normalizedX);
      for (let channel = 0; channel < 3; channel += 1) {
        raster.data[offset + channel] = Math.min(255, Math.max(0, Math.round(raster.data[offset + channel] * factor + (random() - 0.5) * noise)));
      }
      offset += 3;
    }
  }
  return raster;
}

function toSharp(raster) {
  return sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength), { raw: { width: raster.width, height: raster.height, channels: 3 } });
}

function quadCorners(quad) {
  return { topLeft: quad[0], topRight: quad[1], bottomRight: quad[2], bottomLeft: quad[3] };
}

function projectPage({ height, centerX, centerY, rotation = 0, tiltX = 0, tiltY = 0, distance = 4 }) {
  const aspect = PAGE_WIDTH / PAGE_HEIGHT;
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const cosTiltX = Math.cos(tiltX);
  const sinTiltX = Math.sin(tiltX);
  const cosTiltY = Math.cos(tiltY);
  const sinTiltY = Math.sin(tiltY);
  return [
    [-aspect / 2, -0.5],
    [aspect / 2, -0.5],
    [aspect / 2, 0.5],
    [-aspect / 2, 0.5],
  ].map(([planeX, planeY]) => {
    const rotatedX = planeX * cosRotation - planeY * sinRotation;
    const rotatedY = planeX * sinRotation + planeY * cosRotation;
    const tiltedY = rotatedY * cosTiltX;
    const depthFromX = rotatedY * sinTiltX;
    const tiltedX = rotatedX * cosTiltY + depthFromX * sinTiltY;
    const depth = depthFromX * cosTiltY - rotatedX * sinTiltY;
    const perspective = distance / (distance + depth);
    return { x: centerX + tiltedX * height * perspective, y: centerY + tiltedY * height * perspective };
  });
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

const page = pageRaster();
const groundTruth = {};

async function write(name, buffer) {
  writeFileSync(join(OUTPUT_DIRECTORY, name), buffer);
  const { width, height } = await sharp(buffer).metadata();
  console.log(`  ${name.padEnd(26)} ${String(width).padStart(5)}x${String(height).padEnd(5)} ${(buffer.byteLength / 1024).toFixed(0).padStart(6)} KiB`);
}

function photo(width, height, style, quad, shading) {
  const scene = compositeQuad(deskRaster(width, height, style), page, quad);
  return shade(scene, shading);
}

const perspectiveQuad = projectPage({ height: 1420, centerX: 1210, centerY: 900, rotation: 0.05, tiltX: 0.4, tiltY: -0.24, distance: 3.2 });
const perspective = photo(2400, 1800, { seed: 7311, base: [62, 55, 48], grain: 11, noise: 10 }, perspectiveQuad, { seed: 4409, noise: 7, falloff: 0.34, tilt: 0.09 });
groundTruth["photo-perspective.jpg"] = quadCorners(perspectiveQuad);
await write("photo-perspective.jpg", await toSharp(perspective).jpeg({ quality: 84, chromaSubsampling: "4:2:0" }).toBuffer());

const flatQuad = projectPage({ height: 1760, centerX: 748, centerY: 1004, rotation: 0.026, tiltX: 0.09, tiltY: 0.06, distance: 7 });
const flat = photo(1500, 2000, { seed: 2201, base: [46, 48, 54], grain: 7, noise: 8 }, flatQuad, { seed: 8123, noise: 5, falloff: 0.22, tilt: 0.05 });
groundTruth["photo-flat.png"] = quadCorners(flatQuad);
await write("photo-flat.png", await toSharp(flat).png({ compressionLevel: 6 }).toBuffer());

const lowContrastQuad = projectPage({ height: 1480, centerX: 1200, centerY: 890, rotation: -0.04, tiltX: -0.3, tiltY: 0.26, distance: 3.6 });
const lowContrast = photo(2400, 1800, { seed: 6620, base: [206, 203, 196], grain: 6, noise: 9 }, lowContrastQuad, { seed: 3390, noise: 6, falloff: 0.3, tilt: 0.12 });
groundTruth["photo-lowcontrast.jpg"] = quadCorners(lowContrastQuad);
await write("photo-lowcontrast.jpg", await toSharp(lowContrast).jpeg({ quality: 80, chromaSubsampling: "4:2:0" }).toBuffer());

const blurQuad = projectPage({ height: 1230, centerX: 985, centerY: 752, rotation: 0.08, tiltX: 0.34, tiltY: -0.3, distance: 3 });
const blurred = photo(2000, 1500, { seed: 9004, base: [78, 72, 64], grain: 12, noise: 22 }, blurQuad, { seed: 1177, noise: 20, falloff: 0.42, tilt: 0.16 });
groundTruth["photo-blur.jpg"] = quadCorners(blurQuad);
await write("photo-blur.jpg", await toSharp(blurred).blur(2.1).jpeg({ quality: 44, chromaSubsampling: "4:2:0" }).toBuffer());

const largeQuad = projectPage({ height: 1690, centerX: 1350, centerY: 1010, rotation: -0.03, tiltX: 0.26, tiltY: 0.2, distance: 3.8 });
const large = photo(2688, 2016, { seed: 5540, base: [58, 60, 66], grain: 10, noise: 11 }, largeQuad, { seed: 6688, noise: 8, falloff: 0.31, tilt: 0.1 });
const largeScale = 1.5;
groundTruth["photo-large.jpg"] = quadCorners(largeQuad.map((point) => ({ x: point.x * largeScale, y: point.y * largeScale })));
await write("photo-large.jpg", await toSharp(large).resize(4032, 3024, { kernel: "lanczos3" }).jpeg({ quality: 86, chromaSubsampling: "4:2:0" }).toBuffer());

const rotatedQuad = projectPage({ height: 1210, centerX: 1005, centerY: 745, rotation: 0.24, tiltX: 0.16, tiltY: -0.14, distance: 4.5 });
const rotated = photo(2000, 1500, { seed: 3105, base: [70, 64, 58], grain: 9, noise: 10 }, rotatedQuad, { seed: 7742, noise: 7, falloff: 0.28, tilt: 0.08 });
groundTruth["photo-rotated.webp"] = quadCorners(rotatedQuad);
await write("photo-rotated.webp", await toSharp(rotated).webp({ quality: 82 }).toBuffer());

const scanQuad = [
  { x: 0, y: 0 },
  { x: PAGE_WIDTH - 1, y: 0 },
  { x: PAGE_WIDTH - 1, y: PAGE_HEIGHT - 1 },
  { x: 0, y: PAGE_HEIGHT - 1 },
];
groundTruth["page-scan.jpg"] = quadCorners(scanQuad);
await write("page-scan.jpg", await toSharp(shade(compositeQuad(createRaster(PAGE_WIDTH, PAGE_HEIGHT, [250, 249, 245]), page, scanQuad), { seed: 2468, noise: 4, falloff: 0.06, tilt: 0.02 })).jpeg({ quality: 88, chromaSubsampling: "4:4:4" }).toBuffer());

await write("nodocument.jpg", await toSharp(shade(clutterRaster(2400, 1800), { seed: 8899, noise: 9, falloff: 0.36, tilt: 0.11 })).jpeg({ quality: 82, chromaSubsampling: "4:2:0" }).toBuffer());

writeFileSync(join(OUTPUT_DIRECTORY, "corners.json"), `${JSON.stringify(groundTruth, null, 2)}\n`);
console.log(`\nFixtures geradas em ${OUTPUT_DIRECTORY}`);
