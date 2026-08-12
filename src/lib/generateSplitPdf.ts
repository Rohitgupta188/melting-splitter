import { GroupedData } from "./grouping";
import { getCachedImage } from "./image-service";
import { QuotationHeader } from "./types";

/** Detect image format from a base64 data-URL prefix. */
function detectImageFormat(b64: string): "JPEG" | "PNG" | "WEBP" {
  if (b64.startsWith("data:image/png"))  return "PNG";
  if (b64.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
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

  if (header.customerName)    infoRows.push(["Customer Name",    header.customerName]);
  if (header.contactName)     infoRows.push(["Contact Name",     header.contactName]);
  if (header.customerAddress) infoRows.push(["Customer Address", header.customerAddress]);
  if (header.quotationNo)     infoRows.push(["Quotation",        header.quotationNo]);
  if (header.date)            infoRows.push(["Date",             header.date]);

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

      const b64 = getCachedImage(item.imageUrl);
      if (!b64) return;

      const { x, y, width, height } = data.cell;
      const pad  = 2;
      const size = Math.min(width - pad * 2, height - pad * 2);
      const imgX = x + (width  - size) / 2;
      const imgY = y + (height - size) / 2;

      try {
        doc.addImage(b64, detectImageFormat(b64), imgX, imgY, size, size);
      } catch (e) {
        console.warn("[generateSplitPdf] addImage failed for", item.designNumber, e);
      }
    },
  });

  return doc.output("blob");
}
