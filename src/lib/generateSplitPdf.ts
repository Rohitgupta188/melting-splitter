import { GroupedData } from "./grouping";
import { getCachedImage } from "./image-service";
import { QuotationHeader } from "./types";

/** Detect image format from a base64 data-URL prefix. */
function detectImageFormat(b64: string): "JPEG" | "PNG" | "WEBP" {
  if (b64.startsWith("data:image/png"))  return "PNG";
  if (b64.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
}

async function compressImage(base64Str: string, maxWidth: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      
      if (w > maxWidth || h > maxWidth) {
        if (w > h) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        } else {
          w = Math.round((w * maxWidth) / h);
          h = maxWidth;
        }
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(base64Str);
      
      // Fill with white background in case of transparent PNGs
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      
      // Compress to JPEG to aggressively save space
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}

export async function generateGroupPdfBlob(
  group:  GroupedData,
  header: QuotationHeader
): Promise<Blob> {
  const { default: jsPDF }     = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc    = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const PAGE_W = 210;
  const MARGIN = 10;
  let curY = 12;

  // ── Quotation header info table ───────────────────────────────────────────
  // Renders the customer/quotation metadata exactly as it appears on the
  // original PDF, so every split PDF is self-contained and traceable.
  const infoRows: [string, string][] = [];

  infoRows.push(["Customer Name",    header.customerName || ""]);
  infoRows.push(["Contact Name",     header.contactName || ""]);
  infoRows.push(["Customer Address", header.customerAddress || ""]);
  infoRows.push(["Quotation",        header.quotationNo || ""]);
  infoRows.push(["Date",             header.date || ""]);

  if (infoRows.length > 0) {
    autoTable(doc, {
      startY:     curY,
      body:       infoRows,
      margin:     { left: MARGIN, right: MARGIN },
      tableWidth: PAGE_W - MARGIN * 2,
      theme:      "grid",
      styles: {
        fontSize:    9,
        cellPadding: 2.5,
        lineWidth:   0.25,
        lineColor:   [0, 0, 0],
        valign:      "middle",
      },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 42, fillColor: [245, 242, 235] },
        1: { cellWidth: "auto" },
      },
    });
    curY = (doc as any).lastAutoTable.finalY + 2;
  }

  // Remarks — can be multi-line so we render it as a separate full-width block
  if (header.remarks) {
    autoTable(doc, {
      startY:     curY,
      body:       [["Remarks", header.remarks]],
      margin:     { left: MARGIN, right: MARGIN },
      tableWidth: PAGE_W - MARGIN * 2,
      theme:      "grid",
      styles: {
        fontSize:    8.5,
        cellPadding: 2.5,
        lineWidth:   0.25,
        lineColor:   [0, 0, 0],
        valign:      "top",
      },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 42, fillColor: [245, 242, 235], valign: "top" },
        1: { cellWidth: "auto" },
      },
    });
    curY = (doc as any).lastAutoTable.finalY + 4;
  }

  if (infoRows.length === 0 && !header.remarks) {
    curY += 3; // no header — give a little top padding
  }

  curY += 10; // Extra top margin before the Split Quotation title

  // ── Split title ───────────────────────────────────────────────────────────
  doc.setFont("times", "bold");
  doc.setFontSize(14);
  doc.text(`Split Quotation — ${group.groupName}`, PAGE_W / 2, curY, { align: "center" });
  curY += 7;

  // ── Summary line ─────────────────────────────────────────────────────────
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const stoneWtPart = group.totalStoneWt > 0
    ? ` | S Wt: ${group.totalStoneWt.toFixed(3)} g`
    : "";
  const summary =
    `Items: ${group.items.length}  |  Qty: ${group.totalQty}` +
    `  |  Gross: ${group.totalGrossWt.toFixed(3)} g` +
    `  |  Net: ${group.totalNetWt.toFixed(3)} g` +
    stoneWtPart;
  doc.text(summary, PAGE_W / 2, curY, { align: "center" });
  curY += 7;

  // ── Product table ─────────────────────────────────────────────────────────
  const IMAGE_COL = 1;
  const ROW_H     = 35;

  // Pre-compress images
  const compressedImages: Record<string, string> = {};
  await Promise.all(
    group.items.map(async (item) => {
      if (item.imageUrl && !compressedImages[item.imageUrl]) {
        const b64 = getCachedImage(item.imageUrl);
        if (b64) {
          compressedImages[item.imageUrl] = await compressImage(b64, 1200);
        }
      }
    })
  );

  const bodyRows = group.items.map((item, idx) => [
    idx + 1,
    "",
    item.designNumber,
    item.kt,
    item.color,
    item.grossWeight.toFixed(3),
    item.netWeight.toFixed(3),
    item.stoneWeight > 0 ? item.stoneWeight.toFixed(3) : "—",
    item.qty,
    item.remarks ?? "",
  ]);

  autoTable(doc, {
    startY: curY,
    head: [["Sr", "Image", "Design No.", "KT", "Color", "Gross Wt.", "Net Wt.", "S Wt.", "Qty", "Remarks"]],
    body: bodyRows,
    margin:       { left: MARGIN, right: MARGIN },
    tableWidth:   PAGE_W - MARGIN * 2,
    rowPageBreak: "avoid",
    columnStyles: {
      0: { cellWidth: 8  },
      [IMAGE_COL]: { cellWidth: 35 },
      2: { cellWidth: 30 },
      3: { cellWidth: 10 },
      4: { cellWidth: 12 },
      9: { cellWidth: "auto" },
    },
    theme:  "grid",
    styles: {
      fontSize:    7.5,
      halign:      "center",
      valign:      "middle",
      cellPadding: 2,
      lineWidth:   0.2,
      lineColor:   [0, 0, 0],
    },
    bodyStyles: { minCellHeight: ROW_H },
    headStyles: {
      fillColor:  [26, 26, 46],
      textColor:  [255, 255, 255],
      fontStyle:  "bold",
      valign:     "middle",
      fontSize:   8,
    },
    alternateRowStyles: { fillColor: [249, 246, 240] },

    didDrawCell(data: any) {
      if (data.section !== "body" || data.column.index !== IMAGE_COL) return;

      const item = group.items[data.row.index];
      if (!item) return;

      const b64 = item.imageUrl ? compressedImages[item.imageUrl] : null;
      if (!b64) return;

      const { x, y, width, height } = data.cell;
      try {
        const pad = 0.5;
        const props = doc.getImageProperties(b64);
        const cellW = width - pad * 2;
        const cellH = height - pad * 2;
        
        const imgRatio = props.width / props.height;
        let finalW = cellW;
        let finalH = cellW / imgRatio;
        
        if (finalH > cellH) {
          finalH = cellH;
          finalW = cellH * imgRatio;
        }
        
        const imgX = x + (width - finalW) / 2;
        const imgY = y + (height - finalH) / 2;
        
        doc.addImage(b64, "JPEG", imgX, imgY, finalW, finalH);
      } catch (e) {
        console.warn("[generateSplitPdf] addImage failed for", item.designNumber, e);
      }
    },
  });

  return doc.output("blob");
}
