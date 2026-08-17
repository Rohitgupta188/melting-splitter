import { ParsedRow } from "./types";
import type { PDFDocumentProxy } from "pdfjs-dist";

// Helper to multiply two affine transforms [a, b, c, d, e, f] (column-major)
function multiplyMatrix(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

// Apply an affine matrix to a point
function transformPoint(m: number[], x: number, y: number): [number, number] {
  return [
    x * m[0] + y * m[2] + m[4],
    x * m[1] + y * m[3] + m[5],
  ];
}

interface LocatedImage {
  id: string;          // XObject resource name e.g. "Im0"
  left: number;        // PDF coordinates
  right: number;
  top: number;
  bottom: number;
}

// -------------------------------------------------------------------------
// Score how well a located image's bounding box matches a parsed row's cell.
// Returns 0..1, higher is better.
// -------------------------------------------------------------------------
function scoreMatch(img: LocatedImage, row: ParsedRow): number {
  // Normalise row coords (PDF Y is bottom-up, so top > bottom)
  const rowL  = row.imageCellX;
  const rowR  = row.imageCellX + row.imageCellWidth;
  const rowB  = Math.min(row.imageCellTop, row.imageCellBottom);
  const rowT  = Math.max(row.imageCellTop, row.imageCellBottom);

  const imgB  = Math.min(img.top, img.bottom);
  const imgT  = Math.max(img.top, img.bottom);

  const imgW  = img.right - img.left;
  const imgH  = imgT - imgB;

  if (imgW <= 0 || imgH <= 0) return 0;

  // X-axis overlap
  const xOverlap = Math.max(0, Math.min(img.right, rowR) - Math.max(img.left, rowL));
  // Y-axis overlap
  const yOverlap = Math.max(0, Math.min(imgT, rowT) - Math.max(imgB, rowB));

  const xScore = xOverlap / imgW;
  const yScore = yOverlap / imgH;

  // Centre-distance penalty
  const imgCX = (img.left + img.right) / 2;
  const imgCY = (imgT + imgB) / 2;
  const rowCX = (rowL + rowR) / 2;
  const rowCY = (rowT + rowB) / 2;
  const maxDist = Math.max(rowR - rowL, rowT - rowB, 1);
  const dist = Math.sqrt(Math.pow(imgCX - rowCX, 2) + Math.pow(imgCY - rowCY, 2));
  const centreScore = Math.max(0, 1 - dist / maxDist);

  return xScore * 0.4 + yScore * 0.4 + centreScore * 0.2;
}

// -------------------------------------------------------------------------
// Render a single image XObject to a base64 JPEG string.
// Uses getPage().objs which holds per-page image resources.
// -------------------------------------------------------------------------
async function renderImageObjToDataUrl(page: any, imgId: string): Promise<string | null> {
  return new Promise((resolve) => {
    // pdfjs-dist v4: objs.get() is a synchronous getter that returns the data
    // if it's already resolved, or calls the callback when it becomes available.
    // The API is: page.objs.get(id, callback)
    // page.commonObjs is for shared resources (fonts, etc.).
    // Images are in page.objs.
    try {
      page.objs.get(imgId, (imgData: any) => {
        if (!imgData) {
          resolve(null);
          return;
        }

        try {
          const canvas = document.createElement("canvas");
          canvas.width  = imgData.width;
          canvas.height = imgData.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(null); return; }

          if (imgData.bitmap) {
            // ImageBitmap — fastest path
            ctx.drawImage(imgData.bitmap, 0, 0);
          } else if (imgData.data) {
            // Raw pixel data (RGBA Uint8ClampedArray or similar)
            const clamped = imgData.data instanceof Uint8ClampedArray
              ? imgData.data
              : new Uint8ClampedArray(imgData.data.buffer ?? imgData.data);

            // PDF image kind: 1 = GRAYSCALE_1BPP, 2 = RGB, 3 = RGBA
            // If width * 4 matches data length, it's RGBA; else decode as RGB
            let imageData: ImageData;
            if (clamped.length === imgData.width * imgData.height * 4) {
              imageData = new ImageData(clamped, imgData.width, imgData.height);
            } else if (clamped.length === imgData.width * imgData.height * 3) {
              // Convert RGB to RGBA
              const rgba = new Uint8ClampedArray(imgData.width * imgData.height * 4);
              for (let i = 0, j = 0; i < clamped.length; i += 3, j += 4) {
                rgba[j]     = clamped[i];
                rgba[j + 1] = clamped[i + 1];
                rgba[j + 2] = clamped[i + 2];
                rgba[j + 3] = 255;
              }
              imageData = new ImageData(rgba, imgData.width, imgData.height);
            } else {
              // Unknown format — can't decode
              resolve(null);
              return;
            }
            ctx.putImageData(imageData, 0, 0);
          } else {
            resolve(null);
            return;
          }

          resolve(canvas.toDataURL("image/jpeg", 0.88));
        } catch (e) {
          console.warn("[pdf-native] canvas render error:", e);
          resolve(null);
        }
      });
    } catch (e) {
      console.warn("[pdf-native] objs.get error for", imgId, e);
      resolve(null);
    }
  });
}

// -------------------------------------------------------------------------
// Public: walk every page once, extract all embedded images, match to rows.
// Only rows with no imageUrl yet are passed in (already filtered by image-service).
// -------------------------------------------------------------------------
export async function extractNativeImages(pdfDoc: PDFDocumentProxy, rows: ParsedRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Load pdfjs-dist OPS enum (dynamic import avoids SSR issues)
  const pdfjsLib = await import("pdfjs-dist");
  const OPS = pdfjsLib.OPS;

  // Group unresolved rows by page number
  const rowsByPage = new Map<number, ParsedRow[]>();
  for (const row of rows) {
    if (!rowsByPage.has(row.pageNo)) rowsByPage.set(row.pageNo, []);
    rowsByPage.get(row.pageNo)!.push(row);
  }

  for (const [pageNo, pageRows] of rowsByPage.entries()) {
    try {
      const page = await pdfDoc.getPage(pageNo);

      // getOperatorList() triggers image decoding asynchronously
      const ops = await page.getOperatorList();

      // Walk the operator stream and record the screen-space bounding box of
      // every image draw call by replaying the CTM transform stack.
      const ctmStack: number[][] = [[1, 0, 0, 1, 0, 0]];
      const locatedImages: LocatedImage[] = [];

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn   = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (fn === OPS.save) {
          ctmStack.push([...ctmStack[ctmStack.length - 1]]);
        } else if (fn === OPS.restore) {
          if (ctmStack.length > 1) ctmStack.pop();
        } else if (fn === OPS.transform) {
          const cur = ctmStack[ctmStack.length - 1];
          ctmStack[ctmStack.length - 1] = multiplyMatrix(cur, args);
        } else if (
          fn === OPS.paintImageXObject ||
          fn === OPS.paintXObject      ||      // covers general XObjects
          fn === (OPS as any).paintJpegXObject  // some pdfjs builds expose this
        ) {
          const imgId = typeof args[0] === "string" ? args[0] : null;
          if (!imgId) continue;

          const m = ctmStack[ctmStack.length - 1];
          // Image is drawn into the unit square [0,1]×[0,1] in user space
          const p1 = transformPoint(m, 0, 0);
          const p2 = transformPoint(m, 1, 0);
          const p3 = transformPoint(m, 0, 1);
          const p4 = transformPoint(m, 1, 1);

          locatedImages.push({
            id:     imgId,
            left:   Math.min(p1[0], p2[0], p3[0], p4[0]),
            right:  Math.max(p1[0], p2[0], p3[0], p4[0]),
            bottom: Math.min(p1[1], p2[1], p3[1], p4[1]),
            top:    Math.max(p1[1], p2[1], p3[1], p4[1]),
          });
        }
      }

      // Log so we can see what was found during development
      console.log(`[pdf-native] page ${pageNo}: found ${locatedImages.length} image(s), matching ${pageRows.length} row(s)`);
      if (locatedImages.length > 0) {
        console.log("[pdf-native] image bounds:", locatedImages.map(i => `${i.id} [${i.left.toFixed(0)},${i.bottom.toFixed(0)}-${i.right.toFixed(0)},${i.top.toFixed(0)}]`));
        console.log("[pdf-native] row bounds:", pageRows.map(r => `${r.designNumber} [${r.imageCellX.toFixed(0)},${r.imageCellBottom.toFixed(0)}-${(r.imageCellX+r.imageCellWidth).toFixed(0)},${r.imageCellTop.toFixed(0)}]`));
      }

      // Match each row to the best-scoring image
      for (const row of pageRows) {
        let bestImg: LocatedImage | null = null;
        let bestScore = 0.15; // minimum quality threshold

        for (const img of locatedImages) {
          const s = scoreMatch(img, row);
          if (s > bestScore) {
            bestScore = s;
            bestImg   = img;
          }
        }

        if (!bestImg) {
          console.log(`[pdf-native] no match for ${row.designNumber} (best score below threshold)`);
          continue;
        }

        console.log(`[pdf-native] matched ${row.designNumber} → ${bestImg.id} (score ${bestScore.toFixed(2)})`);

        const dataUrl = await renderImageObjToDataUrl(page, bestImg.id);
        if (dataUrl) {
          row.imageUrl    = dataUrl;
          row.imageSource = "pdf-native";
        } else {
          console.warn(`[pdf-native] renderImageObjToDataUrl returned null for ${bestImg.id}`);
        }
      }

      page.cleanup();
    } catch (err) {
      console.error(`[pdf-native] failed on page ${pageNo}:`, err);
    }
  }
}
