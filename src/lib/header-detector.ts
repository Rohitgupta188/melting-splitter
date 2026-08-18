export interface HeaderColumns {
  imageX: number | null;    // X-coord of the "Image" column header (may not exist)
  designNoX: number | null;
  ktX: number | null;
  colorX: number | null;
  grossWtX: number | null;
  netWtX: number | null;
  sWtX: number | null;
  qtyX: number | null;
  remarksX: number | null;
  headerY: number | null;
}

/**
 * Scans text items from a PDF page to locate the X-coordinates of required headers.
 * Throws an error if critical headers are missing.
 */
export function detectHeaders(items: any[]): HeaderColumns {
  const cols: HeaderColumns = {
    imageX: null,
    designNoX: null,
    ktX: null,
    colorX: null,
    grossWtX: null,
    netWtX: null,
    sWtX: null,
    qtyX: null,
    remarksX: null,
    headerY: null,
  };

  for (const item of items) {
    const text = item.str?.trim();
    if (!text) continue;

    const x = item.transform[4];
    const y = Number(item.transform[5].toFixed(1));

    if (/^Image$/i.test(text) || /^Img$/i.test(text)) {
      cols.imageX = x;
      if (cols.headerY === null) cols.headerY = y;
    } else if (/^Design\s*No\.?$/i.test(text) || /^Design$/i.test(text)) {
      cols.designNoX = x;
      if (cols.headerY === null) cols.headerY = y;
    } else if (/^KT$/i.test(text) || /^Karat$/i.test(text)) {
      cols.ktX = x;
    } else if (/^Colou?r$/i.test(text)) {
      cols.colorX = x;
    } else if (/^Gross(\s*Wt\.?)?$/i.test(text)) {
      cols.grossWtX = x;
    } else if (/^Net(\s*Wt\.?|\s*W)?$/i.test(text)) {
      cols.netWtX = x;
    } else if (/^S\s*Wt\.?$/i.test(text) || /^S\s*W$/i.test(text) || /^Stone(\s*Wt\.?|\s*W)?$/i.test(text)) {
      cols.sWtX = x;
    } else if (/^Qt(y)?$/i.test(text) || /^Quantity$/i.test(text)) {
      cols.qtyX = x;
    } else if (/^Remarks?$/i.test(text)) {
      cols.remarksX = x;
    }
  }

  // Validate required headers
  if (cols.designNoX === null || cols.ktX === null || cols.colorX === null || cols.qtyX === null || cols.grossWtX === null || cols.netWtX === null || cols.sWtX === null) {
    const missing = [];
    if (cols.designNoX === null) missing.push("Design No.");
    if (cols.ktX === null) missing.push("KT");
    if (cols.colorX === null) missing.push("Color");
    if (cols.grossWtX === null) missing.push("Gross Wt.");
    if (cols.netWtX === null) missing.push("Net Wt.");
    if (cols.sWtX === null) missing.push("S Wt.");
    if (cols.qtyX === null) missing.push("Qty");
    throw new Error(`Unsupported quotation format. Missing columns: ${missing.join(", ")}`);
  }

  return cols;
}
