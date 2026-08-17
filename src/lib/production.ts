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

/**
 * Compress an image aggressively to a JPEG to save space.
 */
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

  // Pre-compress images like in generateSplitPdf.ts
  const compressedImages: (string | null)[] = await Promise.all(
    lineItems.map(async (item) => {
      if (!item.imageUrl) return null;
      const b64 = getCachedImage(item.imageUrl);
      if (!b64) return null;
      return await compressImage(b64, 1200);
    })
  );

  let curY = margin;

  // --- DRAW HEADER (First Page Only) ---
  doc.setFont("helvetica", "italic");
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
    [`Customer Name: ${companyName}`],
    [`Contact Name: ${contactName}`],
    [`Customer Address: ${address}`],
    [`Date: ${date}`],
    // [`Remarks: ${remarks}`],
  ];

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);

  const parsedRows = infoRows.map(r => {
    const lines = doc.splitTextToSize(r[0], infoW - 4);
    return { text: lines, height: Math.max(5, lines.length * 4 + 2) };
  });

  const totalH = parsedRows.reduce((sum, r) => sum + r.height, 0);

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(margin, curY, tableW, totalH);
  doc.line(logoX, curY, logoX, curY + totalH);

  let currentYOffset = curY;
  parsedRows.forEach((row, i) => {
    if (i > 0) doc.line(margin, currentYOffset, logoX, currentYOffset);
    doc.text(row.text, margin + 2, currentYOffset + 3.5);
    currentYOffset += row.height;
  });

  let finalLogo = logoBase64;
  if (logoBase64) {
    try {
      finalLogo = await compressImage(logoBase64, 1500);
    } catch (e) {
      console.warn("Failed to compress logo", e);
    }
  }

  if (finalLogo) {
    try {
      // 1. Get the original dimensions of the logo
      const imgProps = doc.getImageProperties(finalLogo);

      // 2. Set the maximum space allowed for the logo (Increase or decrease these numbers to change size)
      const maxLogoWidth = logoW - 4;
      const maxLogoHeight = totalH - 2;

      // 3. Calculate the ratio to fit the image inside the max space without stretching
      const ratio = Math.min(maxLogoWidth / imgProps.width, maxLogoHeight / imgProps.height);
      const renderW = imgProps.width * ratio;
      const renderH = imgProps.height * ratio;

      // 4. Calculate X and Y to center the logo nicely in the box
      const lX = logoX + 2 + (maxLogoWidth - renderW) / 2;
      const lY = curY + (totalH - renderH) / 2;

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
  let remarksHeight = 0;

  // Only draw this box if 'remarks' exists and isn't just empty spaces
  if (remarks && remarks.trim() !== "") {
    // 1. Trim the remarks to remove any trailing newlines or spaces that cause empty lines
    const remarksText = `Remarks: ${remarks.trim()}`;
    const remarksLines = doc.splitTextToSize(remarksText, tableW - 4);
    
    // 2. Adjust the height multiplier. An 8pt font with standard line height takes ~3.2mm per line.
    remarksHeight = Math.max(6, remarksLines.length * 3.5 + 2);

    // Draw a full-width rectangle below the top header
    const remarksY = curY + totalH;
    doc.rect(margin, remarksY, tableW, remarksHeight);
    doc.text(remarksLines, margin + 2, remarksY + 3.5); // Write the text
  }

  // Update the final Y position for the products grid
  // (If remarks is empty, remarksHeight is 0, so it skips the extra space!)
  curY += totalH + remarksHeight + 6;


  // --- DRAW GRID ---
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const b64 = compressedImages[i];

    // Check page break
    if (curY + cellH > pageH - margin) {
      doc.addPage();
      curY = margin;

      // Minimal header on subsequent pages
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
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

    // Draw Image
    if (b64) {
      try {
        const format = detectImageFormat(b64);
        const props = doc.getImageProperties(b64);
        const ratio = Math.min((imgW - 2) / props.width, (imgH - 2) / props.height);
        const renderW = props.width * ratio;
        const renderH = props.height * ratio;
        const xOff = cx + (imgW - 2 - renderW) / 2;
        const yOff = curY + 1 + (imgH - 2 - renderH) / 2;
        doc.addImage(b64, format, xOff, yOff, renderW, renderH);
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

  // Return Blob
  return doc.output('blob');

}
