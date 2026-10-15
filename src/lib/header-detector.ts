export interface HeaderColumns {
  srX: number | null;
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

// ---------------------------------------------------------------------------
// Header matchers supporting various industry terms & abbreviations
// ---------------------------------------------------------------------------
const isSr = (t: string) =>
  /^(?:Sr\.?(?:\s*(?:No\.?|#))?|S\.?\s*(?:No\.?|#)|Sl\.?\s*(?:No\.?|#)|Seq(?:\.?\s*No\.?)?|#|No\.?)$/i.test(t);

const isImage = (t: string) =>
  /^(?:Images?|Img\.?|Photos?|Pic(?:ture)?s?|(?:Item|Design)\s*Image)$/i.test(t);

const isDesignNo = (t: string) =>
  /^(?:Design(?:\s*(?:No\.?|#|Code))?|Designs|D\.?\s*No\.?|Item\s*(?:No\.?|#|Code)|Style\s*(?:No\.?|#)|Model\s*(?:No\.?|#)|Design\s*Code)$/i.test(t);

const isKt = (t: string) =>
  /^(?:KT\.?|Karats?|Carats?|Purity|(?:Gold|Metal)\s*(?:KT\.?|Purity))$/i.test(t);

const isColor = (t: string) =>
  /^(?:Colou?r|Col\.?|Clr\.?|(?:Metal|Gold)\s*Colou?r|Shade)$/i.test(t);

const isGrossWt = (t: string) =>
  /^(?:Gross(?:\s*Wt\.?|\s*W\.?|\s*Weight)?|Gr?\.?\s*Wt\.?|G\.?\s*W\.?|G\.?\s*Weight)(?:\s*\([a-z]+\))?$/i.test(t);

const isNetWt = (t: string) =>
  /^(?:Net(?:\s*Wt\.?|\s*W\.?|\s*Weight)?|Nt?\.?\s*Wt\.?|N\.?\s*W\.?|N\.?\s*Weight)(?:\s*\([a-z]+\))?$/i.test(t);

const isSWt = (t: string) =>
  /^(?:S(?:tone)?s?\.?\s*(?:Wt\.?|W\.?|Weight)?|Stn?\.?\s*Wt\.?|Dia(?:mond)?\.?\s*Wt\.?|D\.?\s*Wt\.?|(?:Other|Less|Diff)\s*Wt\.?)(?:\s*\([a-z]+\))?$/i.test(t);

const isQty = (t: string) =>
  /^(?:Qt(?:y|nt?y|\.)?|Quantity|Pcs\.?|Pieces?|Count|(?:Total|Item)\s*Qty|(?:Total\s*)?Pcs\.?)$/i.test(t);

const isRemarks = (t: string) =>
  /^(?:Remarks?|Notes?|Comments?|Desc(?:ription|\.)?)$/i.test(t);

/**
 * Scans text items from a PDF page to locate the X-coordinates of required headers.
 * Supports multiple naming conventions (e.g. Design vs Design No, Gross Wt vs G. WT).
 * Throws an error if critical headers are missing.
 */
export function detectHeaders(items: any[]): HeaderColumns {
  const validItems: { text: string; x: number; y: number }[] = [];

  for (const item of items) {
    const text = item.str?.trim();
    if (!text) continue;
    validItems.push({
      text,
      x: item.transform[4],
      y: Number(item.transform[5].toFixed(1)),
    });
  }

  // Group candidate items into horizontal line clusters by Y coordinate
  const Y_TOLERANCE = 5;
  const clusters: { y: number; items: typeof validItems }[] = [];

  for (const item of validItems) {
    let cluster = clusters.find(c => Math.abs(c.y - item.y) <= Y_TOLERANCE);
    if (!cluster) {
      cluster = { y: item.y, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  }

  // Find the cluster that represents the table header row
  let bestCluster: typeof clusters[0] | null = null;
  let maxScore = 0;

  for (const cluster of clusters) {
    const sorted = [...cluster.items].sort((a, b) => a.x - b.x);
    // Include individual items and horizontally adjacent two-token combinations (e.g., "G." + "WT", "Gross" + "Wt")
    const tokens: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      tokens.push(sorted[i].text);
      if (i + 1 < sorted.length && sorted[i + 1].x - sorted[i].x <= 45) {
        tokens.push(`${sorted[i].text} ${sorted[i + 1].text}`);
      }
    }

    let score = 0;
    if (tokens.some(t => isDesignNo(t))) score += 3;
    if (tokens.some(t => isKt(t))) score += 1;
    if (tokens.some(t => isColor(t))) score += 1;
    if (tokens.some(t => isGrossWt(t))) score += 1;
    if (tokens.some(t => isNetWt(t))) score += 1;
    if (tokens.some(t => isSWt(t))) score += 1;
    if (tokens.some(t => isQty(t))) score += 1;
    if (tokens.some(t => isSr(t))) score += 1;
    if (tokens.some(t => isImage(t))) score += 1;
    if (tokens.some(t => isRemarks(t))) score += 1;

    if (score > maxScore) {
      maxScore = score;
      bestCluster = cluster;
    }
  }

  const cols: HeaderColumns = {
    srX: null,
    imageX: null,
    designNoX: null,
    ktX: null,
    colorX: null,
    grossWtX: null,
    netWtX: null,
    sWtX: null,
    qtyX: null,
    remarksX: null,
    headerY: bestCluster ? bestCluster.y : null,
  };

  if (!bestCluster || maxScore < 4) {
    throw new Error("Unsupported quotation format. Required table header row not found.");
  }

  // Collect all items within the header line band (tolerance 6 units to accommodate multi-line or slightly offset header cells)
  const headerItems = validItems
    .filter(it => Math.abs(it.y - bestCluster.y) <= 6)
    .sort((a, b) => a.x - b.x);

  // Form candidate tokens: single tokens and adjacent pairs
  const candidates: { text: string; x: number }[] = [];
  for (let i = 0; i < headerItems.length; i++) {
    candidates.push({ text: headerItems[i].text, x: headerItems[i].x });
    if (i + 1 < headerItems.length && headerItems[i + 1].x - headerItems[i].x <= 45) {
      candidates.push({
        text: `${headerItems[i].text} ${headerItems[i + 1].text}`,
        x: headerItems[i].x,
      });
    }
  }

  for (const item of candidates) {
    const text = item.text;
    const x = item.x;

    if (isSr(text) && cols.srX === null) {
      cols.srX = x;
    } else if (isImage(text) && cols.imageX === null) {
      cols.imageX = x;
    } else if (isDesignNo(text) && cols.designNoX === null) {
      cols.designNoX = x;
    } else if (isKt(text) && cols.ktX === null) {
      cols.ktX = x;
    } else if (isColor(text) && cols.colorX === null) {
      cols.colorX = x;
    } else if (isGrossWt(text) && cols.grossWtX === null) {
      cols.grossWtX = x;
    } else if (isNetWt(text) && cols.netWtX === null) {
      cols.netWtX = x;
    } else if (isSWt(text) && cols.sWtX === null) {
      cols.sWtX = x;
    } else if (isQty(text) && cols.qtyX === null) {
      cols.qtyX = x;
    } else if (isRemarks(text) && cols.remarksX === null) {
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
