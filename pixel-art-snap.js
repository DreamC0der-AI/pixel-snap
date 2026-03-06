const sharp = require("sharp");
const path = require("path");

// --- CLI ---
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    flags[k] = v ?? "true";
  } else {
    positional.push(a);
  }
}

const INPUT = positional[0]
  ? path.resolve(positional[0])
  : path.resolve(__dirname, "../images/brain-run.png");
const OUTPUT = positional[1]
  ? path.resolve(positional[1])
  : INPUT.replace(/(\.\w+)$/, "-snapped$1");
const TARGET_SIZE = parseInt(flags.size || "1024", 10);
const WHITE_THRESHOLD = parseInt(flags.threshold || "240", 10);
const MODE = flags.mode || "auto"; // "icon" | "scene" | "auto"
const FORCE_GRID = flags.grid ? parseInt(flags.grid, 10) : null;

function usage() {
  console.log(`Usage: node pixel-art-snap.js [input] [output] [options]

Options:
  --mode=auto|icon|scene   Post-processing mode (default: auto-detect)
    icon:  remove white bg, crop, center on square, scale to --size
    scene: keep full image, scale with nearest-neighbor
  --size=1024              Target output size (default: 1024)
  --grid=N                 Force grid size (skip auto-detection)
  --threshold=240          White background threshold (default: 240)
`);
}

if (flags.help) { usage(); process.exit(0); }

async function loadPixels(filePath) {
  const img = sharp(filePath).removeAlpha().ensureAlpha();
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();
  return { raw, width, height };
}

// Step 1: Detect grid size via autocorrelation of edge signal
function detectGridSize(raw, width, height) {
  const gray = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      gray[y * width + x] = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2];
    }
  }

  const hEdge = new Float64Array(width);
  for (let x = 1; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      sum += Math.abs(gray[y * width + x] - gray[y * width + x - 1]);
    }
    hEdge[x] = sum;
  }

  const vEdge = new Float64Array(height);
  for (let y = 1; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += Math.abs(gray[y * width + x] - gray[(y - 1) * width + x]);
    }
    vEdge[y] = sum;
  }

  function findPeriod(signal, maxLag) {
    const n = signal.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;

    const acorr = new Float64Array(maxLag + 1);
    let norm = 0;
    for (let i = 0; i < n; i++) norm += (signal[i] - mean) ** 2;

    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += (signal[i] - mean) * (signal[i + lag] - mean);
      }
      acorr[lag] = sum / norm;
    }

    let pastFirstDip = false;
    let bestLag = 16;
    let bestVal = -Infinity;

    for (let lag = 4; lag <= maxLag; lag++) {
      if (!pastFirstDip && acorr[lag] < acorr[lag - 1]) continue;
      pastFirstDip = true;
      if (acorr[lag] > bestVal) {
        bestVal = acorr[lag];
        bestLag = lag;
      }
      if (acorr[lag] < bestVal - 0.01) break;
    }
    return { period: bestLag, acorr };
  }

  const hResult = findPeriod(hEdge, 40);
  const vResult = findPeriod(vEdge, 40);

  console.log(`  Horizontal period: ${hResult.period}`);
  console.log(`  Vertical period: ${vResult.period}`);

  const avgPeriod = (hResult.period + vResult.period) / 2;
  const candidates = [4, 8, 16, 20, 32];
  let gridSize = candidates.reduce((best, c) =>
    Math.abs(c - avgPeriod) < Math.abs(best - avgPeriod) ? c : best
  );

  for (const c of candidates) {
    if (Math.abs(c - avgPeriod) < 3 && width % c === 0 && height % c === 0) {
      gridSize = c;
      break;
    }
  }

  return gridSize;
}

// Step 2: Find grid offset (phase) that minimizes intra-cell variance
function detectGridOffset(raw, width, height, gridSize) {
  const cellsW = Math.floor(width / gridSize);
  const cellsH = Math.floor(height / gridSize);

  let bestOx = 0, bestOy = 0, bestVariance = Infinity;

  for (let oy = 0; oy < gridSize; oy++) {
    for (let ox = 0; ox < gridSize; ox++) {
      let totalVariance = 0;
      let cellCount = 0;

      for (let cy = 0; cy < cellsH; cy += 2) {
        for (let cx = 0; cx < cellsW; cx += 2) {
          const startX = ox + cx * gridSize;
          const startY = oy + cy * gridSize;
          if (startX + gridSize > width || startY + gridSize > height) continue;

          let sum = 0, sumSq = 0;
          const n = gridSize * gridSize;
          for (let dy = 0; dy < gridSize; dy++) {
            for (let dx = 0; dx < gridSize; dx++) {
              const px = startX + dx;
              const py = startY + dy;
              const i = (py * width + px) * 4;
              const g = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2];
              sum += g;
              sumSq += g * g;
            }
          }
          totalVariance += (sumSq / n) - (sum / n) ** 2;
          cellCount++;
        }
      }

      const avgVar = cellCount > 0 ? totalVariance / cellCount : Infinity;
      if (avgVar < bestVariance) {
        bestVariance = avgVar;
        bestOx = ox;
        bestOy = oy;
      }
    }
  }

  return { ox: bestOx, oy: bestOy, variance: bestVariance };
}

// Step 3: Extract one color per cell using mode-based selection
function extractCellColors(raw, width, height, gridSize, ox, oy) {
  const cellsW = Math.floor((width - ox) / gridSize);
  const cellsH = Math.floor((height - oy) / gridSize);
  const out = Buffer.alloc(cellsW * cellsH * 4);

  for (let cy = 0; cy < cellsH; cy++) {
    for (let cx = 0; cx < cellsW; cx++) {
      const startX = ox + cx * gridSize;
      const startY = oy + cy * gridSize;

      const colorCounts = new Map();
      for (let dy = 0; dy < gridSize; dy++) {
        for (let dx = 0; dx < gridSize; dx++) {
          const px = startX + dx;
          const py = startY + dy;
          if (px >= width || py >= height) continue;
          const i = (py * width + px) * 4;
          const r = Math.min(255, Math.round(raw[i] / 8) * 8);
          const g = Math.min(255, Math.round(raw[i + 1] / 8) * 8);
          const b = Math.min(255, Math.round(raw[i + 2] / 8) * 8);
          const key = (r << 16) | (g << 8) | b;
          colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
        }
      }

      let bestKey = 0, bestCount = 0;
      for (const [key, count] of colorCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
        }
      }

      const outI = (cy * cellsW + cx) * 4;
      out[outI] = (bestKey >> 16) & 0xff;
      out[outI + 1] = (bestKey >> 8) & 0xff;
      out[outI + 2] = bestKey & 0xff;
      out[outI + 3] = 255;
    }
  }

  return { buffer: out, width: cellsW, height: cellsH };
}

// Detect if image has a dominant white/light background
function detectBackground(buf, width, height, threshold) {
  let whiteCount = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
    if (r >= threshold && g >= threshold && b >= threshold) whiteCount++;
  }
  const ratio = whiteCount / total;
  console.log(`  White pixel ratio: ${(ratio * 100).toFixed(1)}%`);
  return ratio > 0.3; // >30% white = likely icon on white bg
}

function makeBackgroundTransparent(buf, width, height, threshold) {
  for (let i = 0; i < width * height; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
    if (r >= threshold && g >= threshold && b >= threshold) {
      buf[i * 4 + 3] = 0;
    }
  }
}

function findBoundingBox(buf, width, height) {
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (buf[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

async function run() {
  console.log(`Input:  ${INPUT}`);
  console.log(`Output: ${OUTPUT}\n`);

  console.log("Loading image...");
  const { raw, width, height } = await loadPixels(INPUT);
  console.log(`  Image: ${width}x${height}`);

  // Step 1: Detect grid size
  console.log("\nStep 1: Detecting grid size...");
  const gridSize = FORCE_GRID || detectGridSize(raw, width, height);
  if (FORCE_GRID) console.log(`  Forced grid size: ${gridSize}px`);
  console.log(`  => Grid size: ${gridSize}px`);
  console.log(`  => Cell dimensions: ${Math.floor(width / gridSize)}x${Math.floor(height / gridSize)}`);

  // Step 2: Detect grid offset
  console.log("\nStep 2: Detecting grid offset...");
  const { ox, oy, variance } = detectGridOffset(raw, width, height, gridSize);
  console.log(`  => Offset: (${ox}, ${oy}), variance: ${variance.toFixed(2)}`);

  // Step 3: Extract cell colors (mode-based)
  console.log("\nStep 3: Extracting cell colors (mode-based)...");
  const cells = extractCellColors(raw, width, height, gridSize, ox, oy);
  console.log(`  => Pixel art: ${cells.width}x${cells.height}`);

  // Determine mode
  let effectiveMode = MODE;
  if (effectiveMode === "auto") {
    console.log("\nAuto-detecting mode...");
    const isIcon = detectBackground(cells.buffer, cells.width, cells.height, WHITE_THRESHOLD);
    effectiveMode = isIcon ? "icon" : "scene";
    console.log(`  => Mode: ${effectiveMode}`);
  }

  if (effectiveMode === "icon") {
    // Icon mode: remove bg, crop, center on square, scale
    console.log("\nStep 4: Making background transparent...");
    makeBackgroundTransparent(cells.buffer, cells.width, cells.height, WHITE_THRESHOLD);

    console.log("\nStep 5: Cropping to content...");
    const bbox = findBoundingBox(cells.buffer, cells.width, cells.height);
    const cropW = bbox.maxX - bbox.minX + 1;
    const cropH = bbox.maxY - bbox.minY + 1;
    console.log(`  => Bounding box: (${bbox.minX},${bbox.minY}) to (${bbox.maxX},${bbox.maxY}) = ${cropW}x${cropH}`);

    const cropped = await sharp(cells.buffer, {
      raw: { width: cells.width, height: cells.height, channels: 4 },
    })
      .extract({ left: bbox.minX, top: bbox.minY, width: cropW, height: cropH })
      .raw()
      .toBuffer();

    console.log("\nStep 6: Centering and scaling...");
    const squareSide = Math.max(cropW, cropH);
    const scale = Math.floor(TARGET_SIZE / squareSide);
    const scaledSize = squareSide * scale;
    console.log(`  => Content: ${cropW}x${cropH}, square: ${squareSide}px, scale: ${scale}x, scaled: ${scaledSize}px`);

    const squareBuf = Buffer.alloc(squareSide * squareSide * 4, 0);
    const padX = Math.floor((squareSide - cropW) / 2);
    const padY = Math.floor((squareSide - cropH) / 2);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcI = (y * cropW + x) * 4;
        const dstI = ((padY + y) * squareSide + (padX + x)) * 4;
        squareBuf[dstI] = cropped[srcI];
        squareBuf[dstI + 1] = cropped[srcI + 1];
        squareBuf[dstI + 2] = cropped[srcI + 2];
        squareBuf[dstI + 3] = cropped[srcI + 3];
      }
    }

    let result = sharp(squareBuf, {
      raw: { width: squareSide, height: squareSide, channels: 4 },
    }).resize(scaledSize, scaledSize, { kernel: sharp.kernel.nearest });

    if (scaledSize < TARGET_SIZE) {
      const pad = TARGET_SIZE - scaledSize;
      const padTop = Math.floor(pad / 2);
      const padLeft = Math.floor(pad / 2);
      result = result.extend({
        top: padTop,
        bottom: pad - padTop,
        left: padLeft,
        right: pad - padLeft,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      console.log(`  => Padded ${scaledSize} -> ${TARGET_SIZE}x${TARGET_SIZE}`);
    }

    await result.png().toFile(OUTPUT);

  } else {
    // Scene mode: scale with nearest-neighbor, preserve aspect ratio
    console.log("\nStep 4: Scaling scene with nearest-neighbor...");
    const scaleW = Math.floor(TARGET_SIZE / cells.width) || 1;
    const scaleH = Math.floor(TARGET_SIZE / cells.height) || 1;
    const scale = Math.min(scaleW, scaleH);
    const outW = cells.width * scale;
    const outH = cells.height * scale;
    console.log(`  => Scale: ${scale}x, output: ${outW}x${outH}`);

    await sharp(cells.buffer, {
      raw: { width: cells.width, height: cells.height, channels: 4 },
    })
      .resize(outW, outH, { kernel: sharp.kernel.nearest })
      .png()
      .toFile(OUTPUT);
  }

  console.log(`\nDone! Output: ${OUTPUT}`);
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
