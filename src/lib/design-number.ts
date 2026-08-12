/**
 * Normalizes a design number extracted from a PDF.
 * - Removes file extensions (.jpg, .png)
 * - Removes -c suffix
 * - Adds hyphen for specific prefixes (e.g., WH1234 -> WH-1234)
 */
export function normalizeDesignNumber(raw: string): string {
  let designNo = raw.trim();

  if (!designNo) return "";
  if (designNo.toLowerCase() === "design no.") return "";

  // Remove .jpg and similar extensions
  designNo = designNo.replace(/\.(jpg|jpeg|png|webp).*$/i, "");

  // Remove -c suffix
  designNo = designNo.replace(/-c$/i, "");

  // Add hyphen for specific prefixes if missing
  // WH12614 -> WH-12614, DZER12614 -> DZER-12614
  if (/^(WH|DZ)/i.test(designNo) && !designNo.includes("-")) {
    designNo = designNo.replace(/^([A-Za-z]+)(\d+)$/, "$1-$2");
  }

  // Validate
  if (!/^[A-Za-z]{2,6}-?\d+$/.test(designNo)) {
    return "";
  }

  return designNo;
}
