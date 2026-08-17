// Metadata from the top of the original quotation PDF.
export interface QuotationHeader {
  customerName?:    string;
  contactName?:     string;
  customerAddress?: string;
  quotationNo?:     string;
  date?:            string;
  remarks?:         string;
}

export interface ParsedRow {
  sr: number;
  designNumber: string;    // Normalised — used for display in the PDF
  rawDesignNumber: string; // Exact string from the PDF — used for DB lookup
  kt: string;
  color: string;
  grossWeight: number;
  netWeight: number;
  stoneWeight: number;
  qty: number;
  remarks?: string;

  // Geometry for image extraction
  pageNo: number;
  imageCellX: number;
  imageCellWidth: number;
  imageCellTop: number;
  imageCellBottom: number;

  imageUrl?: string; // Resolved from Image Service (Catalogue, Native, or Crop)
  imageSource?: "catalogue" | "pdf-native" | "pdf-crop" | "missing";
  itemType?: string; // Resolved from MongoDB for category splitting
}
