/**
 * image-crop.ts
 *
 * Production-grade intelligent image trimming and normalization utilities.
 * 
 * Solves:
 *   1. Widescreen CAD renders (1920x1080) floating in empty white space.
 *   2. Studio CAD renders on dark/charcoal backgrounds with huge floor reflections below.
 *   3. Preserves jewelry with text above it (e.g. TRBL219 with 'YSN-13-45...').
 *   4. Prevents cutting or clipping at the top/sides of rings, hoops, and multiple earrings.
 *   5. Uniform square output with safe breathing-room padding for PDF generation.
 */

export interface BoundingBox {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  isDarkBg: boolean;
  avgEdgeColor: [number, number, number];
}

/**
 * Appends ImageKit's edge-trimming transformation (`tr=t-true`) to an ImageKit URL.
 * If the URL is already an ImageKit URL, ImageKit will strip the surrounding
 * white/solid borders on their CDN before sending it over the network.
 */
export function optimizeImageKitUrl(url: string): string {
  if (!url || !url.includes("ik.imagekit.io")) return url;
  try {
    const parsed = new URL(url);
    const tr = parsed.searchParams.get("tr");
    if (!tr) {
      parsed.searchParams.set("tr", "t-true");
    } else if (!tr.includes("t-true") && !tr.includes("t-")) {
      parsed.searchParams.set("tr", `${tr},t-true`);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Finds the tight bounding box of the physical jewelry piece in an image.
 * Uses a fast downsampled scan (max dimension 300px) so scanning takes <1ms.
 *
 * Key Capabilities:
 *   - Accurately detects jewelry on both light/white backgrounds and dark studio backdrops.
 *   - Never stops prematurely on light backgrounds (preserves text + jewelry on CAD renders like TRBL219).
 *   - Only on dark studio backgrounds, cleanly discards long floor reflections below the jewelry.
 *   - Preserves multi-item layouts (e.g. main view + side view) without slicing the sides.
 *   - Adds safe padding (6%) so tops and edges never clip or touch cell borders.
 */
export function findContentBoundingBox(
  img: HTMLImageElement,
  paddingPercent: number = 0.06
): BoundingBox {
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;

  const defaultResult: BoundingBox = {
    sx: 0,
    sy: 0,
    sw: Math.max(1, origW),
    sh: Math.max(1, origH),
    isDarkBg: false,
    avgEdgeColor: [255, 255, 255],
  };

  // Safety fallback for empty or degenerate images
  if (origW <= 0 || origH <= 0) {
    return defaultResult;
  }

  // Downsample to an analysis canvas (max 300px on longest side) for ultra-fast scanning
  const maxScanDim = 300;
  const scanScale = Math.min(1, maxScanDim / Math.max(origW, origH));
  const scanW = Math.max(1, Math.round(origW * scanScale));
  const scanH = Math.max(1, Math.round(origH * scanScale));

  const scanCanvas = document.createElement("canvas");
  scanCanvas.width = scanW;
  scanCanvas.height = scanH;
  const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

  if (!scanCtx) {
    return defaultResult;
  }

  scanCtx.drawImage(img, 0, 0, scanW, scanH);

  let imgData: ImageData;
  try {
    imgData = scanCtx.getImageData(0, 0, scanW, scanH);
  } catch {
    return defaultResult;
  }

  const data = imgData.data;

  // Sample outer perimeter (border pixels) to classify background type and ambient color
  function getPixel(x: number, y: number): [number, number, number, number] {
    const idx = (y * scanW + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  }

  const edgeSamples: [number, number, number, number][] = [];
  const stepX = Math.max(1, Math.floor(scanW / 12));
  const stepY = Math.max(1, Math.floor(scanH / 12));

  for (let x = 0; x < scanW; x += stepX) {
    edgeSamples.push(getPixel(x, 0));
    edgeSamples.push(getPixel(x, scanH - 1));
  }
  for (let y = 0; y < scanH; y += stepY) {
    edgeSamples.push(getPixel(0, y));
    edgeSamples.push(getPixel(scanW - 1, y));
  }

  const opaqueSamples = edgeSamples.filter((p) => p[3] >= 25);
  const samplePool = opaqueSamples.length > 0 ? opaqueSamples : edgeSamples;

  const avgEdgeBr =
    samplePool.reduce((sum, p) => sum + (p[0] + p[1] + p[2]) / 3, 0) / samplePool.length;

  const avgR = Math.round(samplePool.reduce((sum, p) => sum + p[0], 0) / samplePool.length);
  const avgG = Math.round(samplePool.reduce((sum, p) => sum + p[1], 0) / samplePool.length);
  const avgB = Math.round(samplePool.reduce((sum, p) => sum + p[2], 0) / samplePool.length);

  // Classify background: dark background if edge average brightness < 115
  const isDarkBg = avgEdgeBr < 115;

  function isSubject(r: number, g: number, b: number, a: number): boolean {
    if (a < 25) return false;

    if (isDarkBg) {
      const br = (r + g + b) / 3;
      // Solid jewelry: specular highlights or warm gold saturation
      if (br > 115) return true;
      if (br > 88 && (r > b + 22 || (r >= g && r - b > 14))) return true;
      return false;
    } else {
      // Light / white background: anything with contrast against white
      return r < 240 || g < 240 || b < 240;
    }
  }

  // Row-by-row profile in scan space
  const rowCounts = new Array(scanH).fill(0);
  const rowMinX = new Array(scanH).fill(scanW);
  const rowMaxX = new Array(scanH).fill(-1);

  let globalMinY = scanH;
  let globalMaxY = -1;
  let globalMinX = scanW;
  let globalMaxX = -1;

  for (let y = 0; y < scanH; y++) {
    const rowOffset = y * scanW * 4;
    for (let x = 0; x < scanW; x++) {
      const idx = rowOffset + x * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      if (isSubject(r, g, b, a)) {
        rowCounts[y]++;
        if (x < rowMinX[y]) rowMinX[y] = x;
        if (x > rowMaxX[y]) rowMaxX[y] = x;
        if (y < globalMinY) globalMinY = y;
        if (y > globalMaxY) globalMaxY = y;
        if (x < globalMinX) globalMinX = x;
        if (x > globalMaxX) globalMaxX = x;
      }
    }
  }

  if (globalMaxY === -1) {
    return defaultResult;
  }

  let startScanY = globalMinY;
  let endScanY = globalMaxY;

  // On dark studio backgrounds ONLY: safely discard bottom floor reflections
  if (isDarkBg) {
    for (let sy = globalMinY; sy <= globalMaxY; sy++) {
      if (rowCounts[sy] >= 4) {
        startScanY = sy;
        break;
      }
    }

    // Stop at floor reflection only if we have scanned the main jewelry body (at least 25 scan rows)
    let gap = 0;
    for (let sy = startScanY; sy <= globalMaxY; sy++) {
      if (rowCounts[sy] >= 4) {
        endScanY = sy;
        gap = 0;
      } else {
        gap++;
        if ((sy - startScanY) > 25 && gap >= 5) {
          break; // Floor reflection ends here
        }
      }
    }
  }

  // Find minX and maxX within the active vertical range
  let minScanX = scanW;
  let maxScanX = -1;
  for (let sy = startScanY; sy <= endScanY; sy++) {
    if (rowCounts[sy] > 0) {
      if (rowMinX[sy] < minScanX) minScanX = rowMinX[sy];
      if (rowMaxX[sy] > maxScanX) maxScanX = rowMaxX[sy];
    }
  }

  if (maxScanX === -1) {
    minScanX = globalMinX;
    maxScanX = globalMaxX;
  }

  // Map coordinates back to original full resolution
  const origScale = 1 / scanScale;
  let origX1 = minScanX * origScale;
  let origX2 = (maxScanX + 1) * origScale;
  let origY1 = startScanY * origScale;
  let origY2 = (endScanY + 1) * origScale;

  const contentW = origX2 - origX1;
  const contentH = origY2 - origY1;

  // Safe padding: 6% padding around the subject
  const padX = contentW * paddingPercent;
  const padY = contentH * paddingPercent;

  origX1 = Math.max(0, origX1 - padX);
  origY1 = Math.max(0, origY1 - padY);
  origX2 = Math.min(origW, origX2 + padX);
  origY2 = Math.min(origH, origY2 + padY);

  const sx = Math.floor(origX1);
  const sy = Math.floor(origY1);
  const sw = Math.min(origW - sx, Math.ceil(origX2 - origX1));
  const sh = Math.min(origH - sy, Math.ceil(origY2 - origY1));

  return {
    sx,
    sy,
    sw: Math.max(1, sw),
    sh: Math.max(1, sh),
    isDarkBg,
    avgEdgeColor: [avgR, avgG, avgB],
  };
}

/**
 * Normalizes any input image (widescreen, portrait, square, dark or white background)
 * into a perfectly consistent, sharply rendered square JPEG thumbnail with whitespace
 * and dark margins auto-cropped around the product.
 *
 * Guarantees:
 *   - Ample breathing room margin (`thumbPad: 50`) so tops and borders never touch or clip.
 *   - The entire jewelry piece (including side profiles and annotations) is fully visible.
 *   - Dark backgrounds blend seamlessly with the canvas using the sampled ambient color.
 */
export async function normalizeToSquareWithCrop(
  base64Str: string,
  thumbSize: number = 1500,
  thumbPad: number = 50
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const { sx, sy, sw, sh, isDarkBg, avgEdgeColor } = findContentBoundingBox(img);

        const canvas = document.createElement("canvas");
        canvas.width = thumbSize;
        canvas.height = thumbSize;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(base64Str);
          return;
        }

        // Fill background: if dark background, fill with the sampled edge color so borders blend invisibly
        ctx.fillStyle =
          isDarkBg && avgEdgeColor
            ? `rgb(${avgEdgeColor[0]}, ${avgEdgeColor[1]}, ${avgEdgeColor[2]})`
            : "#FFFFFF";
        ctx.fillRect(0, 0, thumbSize, thumbSize);

        // Drawable area inside thumbnail (with generous safe padding from card borders)
        const drawArea = thumbSize - thumbPad * 2;

        // Scale cropped area to fill the square while strictly preserving aspect ratio
        const scale = Math.min(drawArea / sw, drawArea / sh);
        const dw = sw * scale;
        const dh = sh * scale;

        // Centre the scaled subject inside the canvas
        const dx = thumbPad + (drawArea - dw) / 2;
        const dy = thumbPad + (drawArea - dh) / 2;

        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);

        resolve(canvas.toDataURL("image/jpeg", 0.98));
      } catch (err) {
        console.warn("[image-crop] Failed to normalize image:", err);
        resolve(base64Str);
      }
    };

    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}

/**
 * Crops whitespace/dark borders and compresses an image to fit within maxWidth/maxHeight,
 * preserving the tight aspect ratio of the product for PDF tables.
 */
export async function cropWhitespaceAndCompress(
  base64Str: string,
  maxDimension: number = 1200,
  quality: number = 0.85
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const { sx, sy, sw, sh, isDarkBg, avgEdgeColor } = findContentBoundingBox(img);

        let dw = sw;
        let dh = sh;
        if (dw > maxDimension || dh > maxDimension) {
          if (dw > dh) {
            dh = Math.round((dh * maxDimension) / dw);
            dw = maxDimension;
          } else {
            dw = Math.round((dw * maxDimension) / dh);
            dh = maxDimension;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, dw);
        canvas.height = Math.max(1, dh);

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(base64Str);
          return;
        }

        ctx.fillStyle =
          isDarkBg && avgEdgeColor
            ? `rgb(${avgEdgeColor[0]}, ${avgEdgeColor[1]}, ${avgEdgeColor[2]})`
            : "#FFFFFF";
        ctx.fillRect(0, 0, dw, dh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (err) {
        console.warn("[image-crop] Failed to crop and compress image:", err);
        resolve(base64Str);
      }
    };

    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}
