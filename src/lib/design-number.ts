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

  // Add hyphen for specific prefixes if missing
  // WH12614-c -> WH-12614-c, DZER12614 -> DZER-12614
  if (/^(WH|DZ)/i.test(designNo) && !/^[A-Za-z]+-\d+/.test(designNo)) {
    designNo = designNo.replace(/^([A-Za-z]+)(\d+)/, "$1-$2");
  }

  // Validate
  if (!/^[A-Za-z]{2,6}-?\d+/.test(designNo)) {
    return "";
  }

  return designNo;
}
