// import { PdfQuotationLineItem } from "./quotation"
import { jsPDF } from "jspdf";


export interface PdfQuotationLineItem {
  sku: string;
  designNumber: string;
  itemType?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalPurity?: string;
  metalType?: string;
  imageUrl?: string;
  qty?: number;
  remarks?: string;
}
/**
 * Detect the image format from a base64 Data URL so jsPDF gets the right hint.
 */
function detectImageFormat(dataUrl: string): string {
  if (dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg")) return "JPEG";
  if (dataUrl.startsWith("data:image/png")) return "PNG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "JPEG"; // safe default
}

// ---------------------------------------------------------------------------
// normalizeToSquare
//
// Converts ANY image (portrait, landscape, square) into a perfectly consistent
// square JPEG thumbnail:
//   • Fixed pixel dimensions (THUMB_SIZE × THUMB_SIZE)
//   • White background — eliminates dark/black surrounds from native PDF images
//   • Inner padding so the subject never touches the edge
//   • object-fit: contain — scaled to fit, never cropped, never stretched
//
// This is the only place where images are processed for PDF output.
// Every image in production.ts is this exact square — no exceptions.
// ---------------------------------------------------------------------------
const THUMB_SIZE = 1500; // px — canvas resolution (higher = sharper print)
const THUMB_PAD  = 60;  // px — whitespace on each side

async function normalizeToSquare(base64Str: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      const canvas  = document.createElement("canvas");
      canvas.width  = THUMB_SIZE;
      canvas.height = THUMB_SIZE;

      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(base64Str); return; }

      // White background — covers dark/transparent source images
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);

      // Drawable area (canvas minus padding on all sides)
      const drawArea = THUMB_SIZE - THUMB_PAD * 2;

      // Scale image to fit inside drawArea × drawArea, preserving ratio
      const scale = Math.min(drawArea / img.width, drawArea / img.height);
      const dw = img.width  * scale;
      const dh = img.height * scale;

      // Centre the scaled image inside the padded area
      const dx = THUMB_PAD + (drawArea - dw) / 2;
      const dy = THUMB_PAD + (drawArea - dh) / 2;

      ctx.drawImage(img, dx, dy, dw, dh);

      resolve(canvas.toDataURL("image/jpeg", 0.98));
    };

    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}

/** Compress the company logo for the header — keeps its original aspect ratio. */
async function compressLogo(base64Str: string, maxPx: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(base64Str); return; }
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}

import { getCachedImage } from "./image-service";

export interface BuildProductionPDFParams {
  quotationNo: string;
  companyName: string;
  contactName: string;
  address: string;
  remarks: string;
  date: string;
  lineItems: PdfQuotationLineItem[];
  logoBase64: string | null;
}

export async function buildProductionPDF(params: BuildProductionPDFParams): Promise<Blob> {
  const {
    quotationNo,
    companyName,
    contactName,
    address,
    date,
    remarks,
    lineItems,
    logoBase64,
  } = params;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = 210;
  const pageH = 297;
  const margin = 4; // decreased margin for more space

  // Grid Settings
  const cols = 2;
  const colGap = 4;
  const rowGap = 2;
  const cellW = (pageW - 2 * margin - (cols - 1) * colGap) / cols; // ~93mm
  const cellH = 44;

  // Image Settings inside cell
  const imgW = 55; // slightly decreased image width to give text more room
  const imgH = 42; // keep height within cell
  const textStartX = imgW - 2; // Offset for text area
  const textW = cellW - textStartX;

  // Pre-process: normalise every image to a consistent square thumbnail.
  // A fixed IMG_W × IMG_W square is drawn for every item — no exceptions.
  const IMG_W = 42; // mm — the square drawn in the PDF cell

  const normalizedImages: (string | null)[] = await Promise.all(
    lineItems.map(async (item) => {
      if (!item.imageUrl) return null;
      const b64 = getCachedImage(item.imageUrl);
      if (!b64) return null;
      return await normalizeToSquare(b64);
    })
  );

  const { default: autoTable } = await import("jspdf-autotable");

  let curY = margin;

  // --- DRAW HEADER (First Page Only) ---
  doc.setFont("helvetica", "bolditalic");
  doc.setFontSize(8);
  doc.setTextColor(197, 160, 89);
  doc.text(`Q No. ${quotationNo}`, pageW - margin, curY, { align: "right" });

  doc.setFont("times", "bold");
  doc.setFontSize(14);
  doc.setTextColor(0, 0, 0);
  doc.text("QUOTATION", pageW / 2, curY + 2, { align: "center" });

  curY += 8;

  const tableW = pageW - 2 * margin;
  const infoW = tableW * 0.7;
  const logoX = margin + infoW;
  const logoW = tableW - infoW;

  const infoRows = [
    ["Customer Name: ", companyName || ""],
    ["Contact Name: ", contactName || ""],
    ["Customer Address: ", address || ""],
    ["Date & Quotation: ", `Date: ${date || ""}       |      Quotation: ${quotationNo || ""}`],
  ];

  autoTable(doc, {
    startY: curY,
    body: infoRows,
    margin: { left: margin },
    tableWidth: infoW,
    theme: "grid",
    styles: {
      fontSize: 9,
      cellPadding: 1.5,
      lineWidth: 0.25,
      lineColor: [0, 0, 0],
      valign: "middle",
    },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 35, fillColor: [245, 242, 235] },
      1: { fontStyle: "bold", cellWidth: "auto" },
    },
  });

  const infoFinalY = (doc as any).lastAutoTable.finalY;
  const totalH = infoFinalY - curY;

  // Draw the logo box right next to the info table
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.25);
  doc.rect(logoX, curY, logoW, totalH);

  let finalLogo = logoBase64;
  if (logoBase64) {
    try {
      finalLogo = await compressLogo(logoBase64, 1500);
    } catch (e) {
      console.warn("Failed to compress logo", e);
    }
  }

  if (finalLogo) {
    try {
      const imgProps = doc.getImageProperties(finalLogo);
      const maxLogoWidth = logoW - 4;
      const maxLogoHeight = totalH - 2;

      const ratio = Math.min(maxLogoWidth / imgProps.width, maxLogoHeight / imgProps.height);
      const renderW = imgProps.width * ratio;
      const renderH = imgProps.height * ratio;

      const lX = logoX + 2 + (maxLogoWidth - renderW) / 2;
      const lY = curY + 1 + (maxLogoHeight - renderH) / 2;

      const format = detectImageFormat(finalLogo);
      doc.addImage(finalLogo, format, lX, lY, renderW, renderH);
    } catch { /* skip */ }
  } else {
    doc.setFont("times", "bold");
    doc.setFontSize(9);
    doc.setTextColor(197, 160, 89);
    doc.text("Brahammand\nJewellery", logoX + logoW / 2, curY + totalH / 2, { align: "center", baseline: "middle" });
    doc.setTextColor(0, 0, 0);
  }
  
  curY = infoFinalY + 1;

  // Remarks
  if (remarks && remarks.trim() !== "") {
    autoTable(doc, {
      startY: curY,
      body: [["Remarks: ", remarks.trim().replace(/\n/g, "\n")]],
      margin: { left: margin },
      tableWidth: tableW,
      theme: "grid",
      styles: {
        fontSize: 8.5,
        cellPadding: 2.5,
        lineWidth: 0.25,
        lineColor: [0, 0, 0],
        valign: "top",
      },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 35, fillColor: [245, 242, 235], valign: "top" },
        1: { fontStyle: "bold", cellWidth: "auto" },
      },
    });
    curY = (doc as any).lastAutoTable.finalY + 4;
  }

  // Summary Line Below Header
  const totalQty = lineItems.reduce((sum, item) => sum + (item.qty ?? 1), 0);
  const totalGrossWtStr = lineItems.reduce((sum, item) => sum + (item.grossWeight ?? 0), 0).toFixed(3);
  const totalNetWtStr = lineItems.reduce((sum, item) => sum + (item.netWeight ?? 0), 0).toFixed(3);
  const totalStoneWt = lineItems.reduce((sum, item) => sum + (item.stoneWeight ?? 0), 0);

  const stoneWtPart = totalStoneWt > 0
    ? `  |  S Wt: ${totalStoneWt.toFixed(3)} g`
    : "";
  const summaryLine = 
    `Items: ${lineItems.length}  |  Qty: ${totalQty}` +
    `  |  Gross: ${totalGrossWtStr} g` +
    `  |  Net: ${totalNetWtStr} g` +
    stoneWtPart;

  // Add much more top margin before the summary section
  curY += 5.5;

  // Write "SUMMARY" in an attractive way
  doc.setFont("times", "bold");
  doc.setFontSize(12);
  doc.setTextColor(197, 160, 89);
  doc.text("S U M M A R Y", pageW / 2, curY, { align: "center" });
  
  curY += 6.5;

  // Reset color and write the actual summary string
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.text(summaryLine, pageW / 2, curY, { align: "center" });
  
  curY += 9;


  // --- DRAW GRID ---
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const b64 = normalizedImages[i];

    // Check page break
    if (curY + cellH > pageH - margin) {
      doc.addPage();
      curY = margin;

      // Minimal header on subsequent pages
      doc.setFont("helvetica", "bolditalic");
      doc.setFontSize(9);
      doc.setTextColor(197, 160, 89);
      doc.text(`Q No. ${quotationNo}`, pageW - margin, curY + 3, { align: "right" });
      curY += 8;
    }

    const colIdx = i % cols;
    const cx = margin + colIdx * (cellW + colGap);

    // Draw outer cell bottom border only
    doc.setDrawColor(150, 150, 150);
    doc.setLineWidth(0.3);
    doc.line(cx, curY + cellH, cx + cellW, curY + cellH);

    // Draw Image — always a fixed square, centred in the image area
    if (b64) {
      try {
        // Centre the fixed square within the image column area
        const xOff = cx + (imgW - IMG_W) / 2;
        const yOff = curY + (cellH - IMG_W) / 2;
        doc.addImage(b64, "JPEG", xOff, yOff, IMG_W, IMG_W);
      } catch {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(120, 120, 120);
        doc.text("Error", cx + imgW / 2, curY + imgH / 2, { align: "center" });
      }
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(120, 120, 120);
      doc.text("No Image", cx + imgW / 2, curY + imgH / 2, { align: "center" });
    }

    // Vertical line separating image and text
    // doc.setLineWidth(0.15);
    // doc.line(cx + imgW, curY, cx + imgW, curY + cellH);

    // Draw a vertical line between Column 1 and Column 2
    if (colIdx === 0) {
      const middleX = cx + cellW + (colGap / 2);
      doc.setDrawColor(150, 150, 150);
      doc.line(middleX, curY, middleX, curY + cellH);
    }

    // --- Text Area ---
    doc.setTextColor(0, 0, 0);
    const tx = cx + textStartX;
    let ty = curY + 4; // Start Y inside text area

    // Checkboxes Row (CAM, WAX, CAST)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    const boxSize = 3.5;

    // CAM
    doc.rect(tx, ty - 2.5, boxSize, boxSize);
    doc.text("CAM", tx + boxSize + 1.2, ty);

    // WAX
    const waxX = tx + 15;
    doc.rect(waxX, ty - 2.5, boxSize, boxSize);
    doc.text("WAX", waxX + boxSize + 1.2, ty);

    // CAST
    const castX = tx + 30;
    doc.rect(castX, ty - 2.5, boxSize, boxSize);
    doc.text("CAST", castX + boxSize + 1.2, ty);

    // Divider line below checkboxes
    ty += 2.5;
    doc.setDrawColor(200, 200, 200);
    doc.line(tx, ty, cx + cellW, ty);

    ty += 4;

    // Text styling
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);

    const lineHeight = 4.2; // Slightly tighter line height to fit line-by-line comfortably
    const kt = li.metalPurity?.replace(/[^0-9]/g, "") || "18";
    const color = li.metalType?.charAt(0).toUpperCase() || "Y";

    // Write all properties
    doc.setFont("helvetica", "bold");
    doc.text(`Design No : ${li.designNumber || "-"}`, tx, ty + 0.5);
    doc.setFont("helvetica", "bold");
    ty += lineHeight;

    // Gross Wt & Karat on one line (2 columns)
    const col2X = tx + 25; // Increased gap for 2nd column
    doc.text(`Gross Wt : ${(li.grossWeight ?? 0).toFixed(3)}`, tx, ty + 0.5);
    doc.text(`Karat : ${kt}K`, col2X, ty + 0.5);
    ty += lineHeight;

    // Net Wt & Color on one line (2 columns)
    doc.text(`Net Wt : ${(li.netWeight ?? 0).toFixed(3)}`, tx, ty + 0.5);
    doc.text(`Color : ${color}`, col2X, ty + 0.5);
    ty += lineHeight;

    // Stone Wt & Quantity on one line (2 columns)
    doc.text(`Stone Wt : ${(li.stoneWeight ?? 0).toFixed(3)}`, tx, ty + 0.5);
    doc.text(`Quantity : ${li.qty ?? 1}`, col2X, ty + 0.5);
    ty += lineHeight;

    // Row 5: Remarks (Full width, can wrap)
    if (li.remarks) {
      const lines = doc.splitTextToSize(`Remarks: ${li.remarks}`, textW - 1);
      doc.text(lines, tx, ty + 1);
    }

    // Advance Y only if we completed a row (every 2 items)
    if (colIdx === cols - 1) {
      curY += cellH + rowGap;
    }
  }

  // Add a final Y adjustment if the last row was incomplete
  if (lineItems.length % cols !== 0) {
    curY += cellH + rowGap;
  }

  // Check if we need to add a page for the summary table
  if (curY > pageH - margin - 25) {
    doc.addPage();
    curY = margin;
  }

  const totalGrossWt = lineItems.reduce((sum, item) => sum + (item.grossWeight ?? 0), 0);
  const totalNetWt = lineItems.reduce((sum, item) => sum + (item.netWeight ?? 0), 0);
  

  autoTable(doc, {
    startY: curY + 5,
    body: [
      [
        { content: "Total Gross Wt", styles: { halign: "center", fontStyle: "bold", fillColor: [245, 242, 235], textColor: [0, 0, 0] } },
        { content: `Approx. ${totalGrossWt.toFixed(3)} gms`, styles: { halign: "center", fontStyle: "bold", textColor: [0, 0, 0] } }
      ],
      [
        { content: "Total Net Wt", styles: { halign: "center", fontStyle: "bold", fillColor: [245, 242, 235], textColor: [0, 0, 0] } },
        { content: `Approx. ${totalNetWt.toFixed(3)} gms`, styles: { halign: "center", fontStyle: "bold", textColor: [0, 0, 0] } }
      ]
    ],
    theme: "grid",
    margin: { left: margin, right: margin },
    tableWidth: pageW - 2 * margin,
    styles: {
      lineWidth: 0.2,
      lineColor: [0, 0, 0],
    },
    columnStyles: {
      0: { cellWidth: (pageW - 2 * margin) / 2 },
      1: { cellWidth: (pageW - 2 * margin) / 2 },
    }
  });

  // Return Blob
  return doc.output('blob');

}
