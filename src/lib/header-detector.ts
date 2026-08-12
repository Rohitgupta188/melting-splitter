export interface HeaderColumns {
  designNoX: number | null;
  ktX: number | null;
  colorX: number | null;
  grossWtX: number | null;
  netWtX: number | null;
  sWtX: number | null;
  qtyX: number | null;
  headerY: number | null;
}

/**
 * Scans text items from a PDF page to locate the X-coordinates of required headers.
 * Throws an error if critical headers are missing.
 */
export function detectHeaders(items: any[]): HeaderColumns {
  const cols: HeaderColumns = {
    designNoX: null,
    ktX: null,
    colorX: null,
    grossWtX: null,
    netWtX: null,
    sWtX: null,
    qtyX: null,
    headerY: null,
  };

  for (const item of items) {
    const text = item.str?.trim();
    if (!text) continue;

    const x = item.transform[4];
    const y = Number(item.transform[5].toFixed(1));

    if (text === "Design No.") {
      cols.designNoX = x;
      if (cols.headerY === null) cols.headerY = y;
    } else if (text === "KT") {
      cols.ktX = x;
    } else if (text === "Color") {
      cols.colorX = x;
    } else if (text === "Gross Wt.") {
      cols.grossWtX = x;
    } else if (text === "Net Wt.") {
      cols.netWtX = x;
    } else if (text === "S Wt.") {
      cols.sWtX = x;
    } else if (text === "Qty") {
      cols.qtyX = x;
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
