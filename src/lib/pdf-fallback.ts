import { ParsedRow } from "./types";
import type { PDFDocumentProxy } from "pdfjs-dist";

export async function extractFallbackImages(pdfDoc: PDFDocumentProxy, rows: ParsedRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Group rows by page
  const rowsByPage = new Map<number, ParsedRow[]>();
  for (const row of rows) {
    if (!rowsByPage.has(row.pageNo)) rowsByPage.set(row.pageNo, []);
    rowsByPage.get(row.pageNo)!.push(row);
  }

  const SCALE = 2.0; // Render at 2x for crisp crops

  for (const [pageNo, pageRows] of rowsByPage.entries()) {
    console.log(`[pdf-crop] rendering page ${pageNo} for ${pageRows.length} missing row(s)`);
    try {
      const page = await pdfDoc.getPage(pageNo);
      const viewport = page.getViewport({ scale: SCALE });

      // Render the whole page once to a canvas.
      // pdfjs-dist v6 render() takes canvas directly; willReadFrequently is set
      // so subsequent cropCtx.drawImage() calls are not penalised.
      const canvas = document.createElement("canvas");
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      // Set willReadFrequently on the canvas context before pdfjs renders into it.
      // This is a browser hint that improves performance of our subsequent getImageData/drawImage reads.
      // We obtain the context purely to set the attribute; pdfjs-dist v6 manages its own rendering context.
      const _ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!_ctx) {
        console.error(`[pdf-crop] failed to get 2d context for page ${pageNo}`);
        continue;
      }

      await page.render({ canvas, viewport }).promise;

      // Crop each row from the rendered canvas
      for (const row of pageRows) {
        try {
          // imageCellTop is the higher Y value in PDF coords (near the top of the row)
          // imageCellBottom is the lower Y value (near the bottom of the row)
          // viewport.convertToViewportPoint handles the PDF→canvas coordinate flip.
          const [x1, y1] = viewport.convertToViewportPoint(row.imageCellX, row.imageCellTop);
          const [x2, y2] = viewport.convertToViewportPoint(
            row.imageCellX + row.imageCellWidth,
            row.imageCellBottom
          );

          const left   = Math.floor(Math.min(x1, x2));
          const top    = Math.floor(Math.min(y1, y2));
          const right  = Math.ceil(Math.max(x1, x2));
          const bottom = Math.ceil(Math.max(y1, y2));
          const width  = right - left;
          const height = bottom - top;

          console.log(`[pdf-crop] ${row.designNumber}: cell [${left},${top} ${width}×${height}] on ${canvas.width}×${canvas.height} canvas`);

          if (width <= 2 || height <= 2) {
            console.warn(`[pdf-crop] ${row.designNumber}: crop region too small (${width}×${height}), skipping`);
            continue;
          }

          const cropCanvas = document.createElement("canvas");
          cropCanvas.width  = width;
          cropCanvas.height = height;
          const cropCtx = cropCanvas.getContext("2d");
          if (!cropCtx) continue;

          cropCtx.drawImage(canvas, left, top, width, height, 0, 0, width, height);

          row.imageUrl    = cropCanvas.toDataURL("image/jpeg", 0.88);
          row.imageSource = "pdf-crop";
          console.log(`[pdf-crop] ${row.designNumber}: cropped OK`);
        } catch (err) {
          console.warn(`[pdf-crop] failed to crop ${row.designNumber}:`, err);
        }
      }

      page.cleanup();
    } catch (err) {
      console.error(`[pdf-crop] failed on page ${pageNo}:`, err);
    }
  }
}
