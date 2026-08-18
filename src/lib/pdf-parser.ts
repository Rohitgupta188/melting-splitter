import { detectHeaders, HeaderColumns } from "./header-detector";
import { normalizeDesignNumber } from "./design-number";
import { ParsedRow, QuotationHeader } from "./types";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";

// ---------------------------------------------------------------------------
// Extract quotation metadata (Customer Name, Date, etc.) from the text that
// appears ABOVE the product table on the first page of the PDF.
// ---------------------------------------------------------------------------
const ROW_MERGE_TOL = 5; // Y-units — items within this distance are same line

async function extractQuotationHeader(
  pdf: any,
  headerPageNo: number,
  headerY: number | null
): Promise<QuotationHeader> {
  // Collect text items that are above the product-table header row
  const items: { x: number; y: number; text: string }[] = [];

  for (let p = 1; p <= headerPageNo; p++) {
    const page = await pdf.getPage(p);
    const { items: raw } = await page.getTextContent();
    for (const it of raw as any[]) {
      const text = (it.str ?? "").trim();
      if (!text) continue;
      const x: number = it.transform[4];
      const y: number = it.transform[5];
      // Include items that are strictly above the table header
      if (p < headerPageNo || (headerY !== null && y > headerY + ROW_MERGE_TOL)) {
        items.push({ x, y, text });
      }
    }
  }

  // Sort top-to-bottom then left-to-right (PDF Y increases upward)
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  // Group items with similar Y values into text lines
  const lines: string[] = [];
  let curY = -Infinity;
  let curLine: string[] = [];

  for (const it of items) {
    if (Math.abs(it.y - curY) > ROW_MERGE_TOL) {
      if (curLine.length) lines.push(curLine.join(" "));
      curLine = [it.text];
      curY = it.y;
    } else {
      curLine.push(it.text);
    }
  }
  if (curLine.length) lines.push(curLine.join(" "));

  const fullText = lines.join("\n");

  // Helper: extract the value after a label anywhere in the text
  function extract(pattern: RegExp): string | undefined {
    const m = fullText.match(pattern);
    return m?.[1]?.trim() || undefined;
  }

  // Remarks can be multi-line: grab everything after "Remarks:" label
  function extractRemarks(): string | undefined {
    const idx = fullText.search(/Remarks\s*[:\-]/i);
    if (idx === -1) return undefined;
    let after = fullText.slice(idx).replace(/^Remarks\s*[:\-]\s*/i, "").trim();
    
    // The PDF sometimes contains a summary table between the header and the main product table.
    // This table's header usually starts with "Sr. Item Type". We cut off the remarks there.
    const cutoffMatch = after.search(/\bSr\.\s*Item\s*Type\b/i);
    if (cutoffMatch !== -1) {
      after = after.substring(0, cutoffMatch).trim();
    }

    return after || undefined;
  }

  const stop = "(?=\\s*(?:Customer\\s+Name|Contact\\s+Name|Customer\\s+Address|Quotation(?:\\s*No\\.?)?|Date|Remarks)\\s*[:\\-]|$)";

  return {
    customerName:    extract(new RegExp(`Customer\\s+Name\\s*[:\\-]\\s*(.*?)${stop}`, "i")),
    contactName:     extract(new RegExp(`Contact\\s+Name\\s*[:\\-]\\s*(.*?)${stop}`, "i")),
    customerAddress: extract(new RegExp(`Customer\\s+Address\\s*[:\\-]\\s*(.*?)${stop}`, "i")),
    quotationNo:     extract(new RegExp(`Quotation(?:\\s*No\\.?)?\\s*[:\\-]\\s*(.*?)${stop}`, "i"))?.replace(/quotation/i, "").trim(),
    date:            extract(new RegExp(`\\bDate\\s*[:\\-]\\s*(.*?)${stop}`, "i")),
    remarks:         extractRemarks(),
  };
}

// Tolerance (in PDF units) for matching text items to column X-coordinates.
const DESIGN_TOLERANCE = 35;  // wider because design numbers can be long
const NORMAL_TOLERANCE = 15;
// Tolerance (in PDF units) for grouping text items into the same row by Y-coordinate.
const ROW_TOLERANCE = 4;

export interface ParseResult {
  header: QuotationHeader;
  rows: ParsedRow[];
  /** The live PDF document — used by extractNativeImages/extractFallbackImages to call getPage(). */
  pdfDoc: PDFDocumentProxy;
  /** The loading task — the ONLY object that has destroy(). Call this in a finally block. */
  loadingTask: PDFDocumentLoadingTask;
}

export async function parsePDF(file: File): Promise<ParseResult> {
  // Dynamic import keeps pdfjs-dist out of the server bundle.
  const pdfjsLib = await import("pdfjs-dist");

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new Error("Invalid or corrupted PDF.");
  }

  // getDocument() returns a PDFDocumentLoadingTask. We keep a reference to it
  // so the caller can call loadingTask.destroy() to release the worker + memory.
  let loadingTask: PDFDocumentLoadingTask;
  let pdf: PDFDocumentProxy;
  try {
    loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdf = await loadingTask.promise;
  } catch {
    throw new Error("Invalid or corrupted PDF.");
  }

  // ------------------------------------------------------------------
  // Phase 1: locate headers. We scan every page until we find them.
  // If not found by the end we throw "Unsupported quotation format."
  // ------------------------------------------------------------------
  let cols: HeaderColumns | null = null;
  let headerPageNo = 1;

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const textContent = await page.getTextContent();
    const items = textContent.items as any[];

    try {
      cols = detectHeaders(items);
      headerPageNo = pageNo;
      break; // Found — stop scanning
    } catch {
      // This page doesn't have the required headers — try the next one
      continue;
    }
  }

  if (!cols) {
    throw new Error("Unsupported quotation format. Required columns not found.");
  }

  // Extract quotation metadata from the top of the PDF
  const header = await extractQuotationHeader(pdf, headerPageNo, cols.headerY);

  // ------------------------------------------------------------------
  // Phase 2: extract data rows from all pages (starting from header page)
  // ------------------------------------------------------------------
  const rows: ParsedRow[] = [];
  let globalSr = 1;

  for (let pageNo = headerPageNo; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const textContent = await page.getTextContent();
    const items = textContent.items as any[];

    // On subsequent pages, re-detect headers in case they repeat (multi-page tables).
    // If this page has a new header row we update cols.
    if (pageNo > headerPageNo) {
      try {
        const pageCols = detectHeaders(items);
        cols = pageCols; // update to this page's header positions
      } catch {
        // No header row on this page — reuse the previous page's cols
      }
    }

    const { designNoX, ktX, colorX, grossWtX, netWtX, sWtX, qtyX, headerY } = cols;

    // Build a Y → row-data map, grouping items within ROW_TOLERANCE
    const rowMap = new Map<
      number,
      {
        designNo?: string;
        kt?: string;
        color?: string;
        grossWt?: string;
        netWt?: string;
        sWt?: string;
        qty?: string;
      }
    >();

    for (const item of items) {
      const text = item.str?.trim();
      if (!text) continue;

      const x: number = item.transform[4];
      const y: number = Number(item.transform[5].toFixed(1));

      // Skip items on or above the header row (header text itself + anything above)
      if (headerY !== null && y >= headerY - ROW_TOLERANCE) continue;

      // Find an existing row bucket within tolerance, or create one
      let rowKey = [...rowMap.keys()].find(k => Math.abs(k - y) <= ROW_TOLERANCE);
      if (rowKey === undefined) {
        rowKey = y;
        rowMap.set(rowKey, {});
      }

      const row = rowMap.get(rowKey)!;

      if (designNoX !== null && Math.abs(x - designNoX) <= DESIGN_TOLERANCE) row.designNo = row.designNo ? row.designNo + text : text;
      if (ktX       !== null && Math.abs(x - ktX)       <= NORMAL_TOLERANCE) row.kt       = row.kt ? row.kt + text : text;
      if (colorX    !== null && Math.abs(x - colorX)    <= NORMAL_TOLERANCE) row.color    = row.color ? row.color + text : text;
      if (grossWtX  !== null && Math.abs(x - grossWtX)  <= NORMAL_TOLERANCE) row.grossWt  = row.grossWt ? row.grossWt + text : text;
      if (netWtX    !== null && Math.abs(x - netWtX)    <= NORMAL_TOLERANCE) row.netWt    = row.netWt ? row.netWt + text : text;
      if (sWtX      !== null && Math.abs(x - sWtX)      <= NORMAL_TOLERANCE) row.sWt      = row.sWt ? row.sWt + text : text;
      if (qtyX      !== null && Math.abs(x - qtyX)      <= NORMAL_TOLERANCE) row.qty      = row.qty ? row.qty + text : text;
    }

    // Sort rows top-to-bottom (higher Y = higher on page in PDF coords)
    const sortedRows = [...rowMap.entries()].sort((a, b) => b[0] - a[0]);

    for (const [rowKey, row] of sortedRows) {
      if (!row.designNo) continue;

      // rawDesignNumber = exact string from the PDF (e.g. "TRPD073-c")
      // designNumber    = cleaned for display (e.g. "TRPD073")
      // We keep both because the MongoDB record stores the raw form
      // (designNumber: "TRPD073-c") but we display the clean form.
      const rawDesignNumber = row.designNo.trim();
      const designNo = normalizeDesignNumber(rawDesignNumber);
      if (!designNo) continue; // skip header re-prints, totals rows, etc.

      const qty      = parseInt(row.qty  || "1", 10);
      const grossWt  = parseFloat(row.grossWt || "0");
      const netWt    = parseFloat(row.netWt   || "0");
      const sWt      = parseFloat(row.sWt     || "0");

      // Row bounding box
      // We use the text Y as the center of the row and estimate row height from
      // the gap between adjacent rows, using the full inter-row gap (not midpoints).
      // In PDF coordinate space Y increases upward, so higher Y means closer to top.
      const rowIdx = sortedRows.findIndex(r => r[0] === rowKey);
      const prevY = rowIdx > 0 ? sortedRows[rowIdx - 1][0] : rowKey;
      const nextY = rowIdx < sortedRows.length - 1 ? sortedRows[rowIdx + 1][0] : rowKey;
      const rowHeight = rowIdx > 0
        ? (prevY - rowKey) / 2           // half the gap to the row above
        : (rowKey - nextY) / 2;           // fall back to half the gap below
      const halfH = Math.max(rowHeight, 14); // at least 14 pdf units

      // imageCellX and imageCellWidth - the image cell is left of the Design No column.
      // If the PDF has an explicit "Image" column, imageX will be set there.
      // Otherwise we use x=0 up to the design number column.
      const imgX = cols.imageX ?? 0;
      const imgW = (cols.designNoX ?? 100) - imgX;

      const imageCellX     = imgX;
      const imageCellWidth = Math.max(imgW, 50);
      const imageCellTop    = rowKey + halfH;    // PDF Y is up — this is the TOP (higher value)
      const imageCellBottom = rowKey - halfH;    // this is the BOTTOM (lower value)

      rows.push({
        sr:             globalSr++,
        designNumber:    designNo,
        rawDesignNumber: rawDesignNumber,
        kt:             row.kt    || "Unknown",
        color:          row.color || "Unknown",
        grossWeight:    Number.isNaN(grossWt) ? 0 : grossWt,
        netWeight:      Number.isNaN(netWt)   ? 0 : netWt,
        stoneWeight:    Number.isNaN(sWt)     ? 0 : sWt,
        qty:            Number.isNaN(qty)      ? 1 : qty,
        pageNo:         pageNo,
        imageCellX,
        imageCellWidth,
        imageCellTop,
        imageCellBottom,
      });
    }
  }

  return { header, rows, pdfDoc: pdf, loadingTask };
}

