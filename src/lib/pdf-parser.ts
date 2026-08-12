import { detectHeaders, HeaderColumns } from "./header-detector";
import { normalizeDesignNumber } from "./design-number";
import { ParsedRow, QuotationHeader } from "./types";

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
    const after = fullText.slice(idx).replace(/^Remarks\s*[:\-]\s*/i, "").trim();
    return after || undefined;
  }

  return {
    customerName:    extract(/Customer\s+Name\s*[:\-]\s*(.+)/i),
    contactName:     extract(/Contact\s+Name\s*[:\-]\s*(.+)/i),
    customerAddress: extract(/Customer\s+Address\s*[:\-]\s*(.+)/i),
    quotationNo:     extract(/Quotation(?:\s*No\.?)?\s*[:\-]\s*(.+)/i),
    date:            extract(/\bDate\s*[:\-]\s*(.+)/i),
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

  let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
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

      if (designNoX !== null && Math.abs(x - designNoX) <= DESIGN_TOLERANCE) row.designNo = text;
      if (ktX       !== null && Math.abs(x - ktX)       <= NORMAL_TOLERANCE) row.kt       = text;
      if (colorX    !== null && Math.abs(x - colorX)    <= NORMAL_TOLERANCE) row.color    = text;
      if (grossWtX  !== null && Math.abs(x - grossWtX)  <= NORMAL_TOLERANCE) row.grossWt  = text;
      if (netWtX    !== null && Math.abs(x - netWtX)    <= NORMAL_TOLERANCE) row.netWt    = text;
      if (sWtX      !== null && Math.abs(x - sWtX)      <= NORMAL_TOLERANCE) row.sWt      = text;
      if (qtyX      !== null && Math.abs(x - qtyX)      <= NORMAL_TOLERANCE) row.qty      = text;
    }

    // Sort rows top-to-bottom (higher Y = higher on page in PDF coords)
    const sortedRows = [...rowMap.entries()].sort((a, b) => b[0] - a[0]);

    for (const [, row] of sortedRows) {
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
      });
    }
  }

  return { header, rows };
}

