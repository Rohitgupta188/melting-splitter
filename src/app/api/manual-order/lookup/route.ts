import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Product } from "@/models/Product.model";
import { ImageIndex } from "@/models/ImageIndex.model";
import { normalizeDesignNumber } from "@/lib/design-number";

export interface ManualOrderItemData {
  id: string; // unique ID for React keys
  inputDesign: string; // Exact text user pasted
  normalizedDesign: string;
  matched: boolean;
  imageOnlyMatch?: boolean; // image found in image_index but not in catalogs
  sku?: string;
  itemType?: string;
  grossWeight: number;
  netWeight: number;
  stoneWeight: number;
  reserved1?: number; // CZ.Wt
  reserved3?: number; // BS.wt
  metalPurity: string; // KT (e.g. "18", "22")
  metalType: string; // Color (e.g. "Y", "W", "R", "S")
  imageUrl?: string;
  imageName?: string;
  qty: number;
  remarks?: string;
  recordCount: number;
  selected: boolean; // whether to include in PDF
}

function stripVariantSuffix(raw: string): string {
  return raw.replace(/-[A-Za-z]$/i, "").trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawList: string[] = Array.isArray(body.designNumbers) ? body.designNumbers : [];

    if (rawList.length === 0) {
      return NextResponse.json({
        success: true,
        items: [],
        stats: {
          totalPasted: 0,
          totalUnique: 0,
          foundCount: 0,
          notFoundCount: 0,
          duplicateCount: 0,
        },
      });
    }

    // Security & Performance: Limit batch lookup size to prevent resource exhaustion
    const MAX_DESIGNS = 500;
    if (rawList.length > MAX_DESIGNS) {
      return NextResponse.json(
        { error: `Too many designs submitted. Maximum limit is ${MAX_DESIGNS} items per lookup.` },
        { status: 400 }
      );
    }

    // Connect to database
    await connectDB();

    // Clean, sanitize, and limit individual design string length
    const parsedList = rawList
      .filter((d) => typeof d === "string" || typeof d === "number")
      .map((d) => String(d).replace(/[\r\n\t]/g, "").trim().slice(0, 60))
      .filter((d) => d.length > 0);

    const totalPasted = parsedList.length;
    const uniqueRawSet = new Set<string>();
    let duplicateCount = 0;

    for (const d of parsedList) {
      const lower = d.toLowerCase();
      if (uniqueRawSet.has(lower)) {
        duplicateCount++;
      } else {
        uniqueRawSet.add(lower);
      }
    }

    // Build unique search terms (both raw and normalized)
    const searchTerms = new Set<string>();
    for (const d of parsedList) {
      searchTerms.add(d);
      const norm = normalizeDesignNumber(d);
      if (norm) searchTerms.add(norm);
      const stripped = stripVariantSuffix(d);
      if (stripped) {
        searchTerms.add(stripped);
        const normStripped = normalizeDesignNumber(stripped);
        if (normStripped) searchTerms.add(normStripped);
      }
    }

    const searchArray = Array.from(searchTerms);

    // Common projection to only fetch necessary fields from MongoDB (high performance)
    const PROJECTION_FIELDS = "designNumber sku itemType grossWeight netWeight stoneWeight reserved1 reserved3 metalPurity metalType imageUrl imageName";

    // ── Layer 1: Find by designNumber in catalogs ──
    const layer1Docs = (await Product.find({
      designNumber: { $in: searchArray },
    })
      .select(PROJECTION_FIELDS)
      .lean()) as any[];

    // Group docs by matched key (case-insensitive & stripped)
    const docsByKey = new Map<string, any[]>();
    const registerDoc = (key: string, doc: any) => {
      if (!key) return;
      const k = key.trim().toLowerCase();
      if (!docsByKey.has(k)) docsByKey.set(k, []);
      docsByKey.get(k)!.push(doc);
    };

    for (const doc of layer1Docs) {
      if (doc.designNumber) {
        registerDoc(doc.designNumber, doc);
        registerDoc(normalizeDesignNumber(doc.designNumber), doc);
        registerDoc(stripVariantSuffix(doc.designNumber), doc);
      }
    }

    // ── Layer 2: imageName fallback in catalogs for remaining search terms ──
    const remainingToFind = searchArray.filter((term) => !docsByKey.has(term.toLowerCase()));
    if (remainingToFind.length > 0) {
      const imageNamesToSearch: string[] = [];
      const baseToTerms = new Map<string, string[]>();

      for (const term of remainingToFind) {
        let base = stripVariantSuffix(term);
        base = normalizeDesignNumber(base) || base;
        const extensions = [`${base}.jpg`, `${base}.JPG`, `${base}.jpeg`, `${base}.JPEG`, `${base}.png`, `${base}.PNG`];
        for (const ext of extensions) {
          imageNamesToSearch.push(ext);
        }
        if (!baseToTerms.has(base.toLowerCase())) {
          baseToTerms.set(base.toLowerCase(), []);
        }
        baseToTerms.get(base.toLowerCase())!.push(term);
      }

      const layer2Docs = (await Product.find({
        imageName: { $in: imageNamesToSearch },
      })
        .select(PROJECTION_FIELDS)
        .lean()) as any[];

      for (const doc of layer2Docs) {
        if (!doc.imageName) continue;
        const baseName = (doc.imageName as string).replace(/\.[^.]+$/, "").toLowerCase();
        const terms = baseToTerms.get(baseName);
        if (terms) {
          for (const term of terms) {
            registerDoc(term, doc);
          }
        }
      }
    }

    // ── Layer 3: Fallback to image_index collection for any designs missing imageUrl ──
    // This catches designs that are either:
    // (a) Not in the catalogs collection at all (e.g. DZBL-2890)
    // (b) In catalogs but have an empty or missing imageUrl
    const imageIndexByKey = new Map<string, { imageName: string; imageUrl: string }>();
    const imageNamesForIndex: string[] = [];
    const baseToIndexedKeys = new Map<string, string[]>();

    const EXTENSIONS = [".jpg", ".JPG", ".jpeg", ".JPEG", ".png", ".PNG"];

    for (const raw of parsedList) {
      const norm = normalizeDesignNumber(raw) || raw;
      const stripped = stripVariantSuffix(raw);
      const normStripped = normalizeDesignNumber(stripped) || stripped;

      const matchedDocs =
        docsByKey.get(raw.toLowerCase()) ??
        docsByKey.get(norm.toLowerCase()) ??
        docsByKey.get(stripped.toLowerCase());

      const hasCatalogImage = matchedDocs && matchedDocs.some((d: any) => Boolean(d.imageUrl));

      if (!hasCatalogImage) {
        const variants = new Set([raw, norm, stripped, normStripped]);
        for (const variant of variants) {
          const varLower = variant.toLowerCase();
          if (!baseToIndexedKeys.has(varLower)) {
            baseToIndexedKeys.set(varLower, [varLower]);
            for (const ext of EXTENSIONS) {
              imageNamesForIndex.push(`${variant}${ext}`);
            }
          }
        }
      }
    }

    if (imageNamesForIndex.length > 0) {
      const layer3Docs = (await ImageIndex.find({
        imageName: { $in: imageNamesForIndex },
      })
        .select("imageName imageUrl")
        .lean()) as any[];

      for (const imgDoc of layer3Docs) {
        if (!imgDoc.imageName || !imgDoc.imageUrl) continue;
        const base = (imgDoc.imageName as string).replace(/\.[^.]+$/, "").toLowerCase();
        imageIndexByKey.set(base, {
          imageName: imgDoc.imageName,
          imageUrl: imgDoc.imageUrl,
        });
        const strippedBase = stripVariantSuffix(base);
        imageIndexByKey.set(strippedBase, {
          imageName: imgDoc.imageName,
          imageUrl: imgDoc.imageUrl,
        });
      }
    }

    // Function to extract best representative data for a design from catalogs docs
    function extractBestData(docs: any[]): {
      sku: string;
      itemType: string;
      grossWeight: number;
      netWeight: number;
      stoneWeight: number;
      reserved1: number;
      reserved3: number;
      metalPurity: string;
      metalType: string;
      imageUrl: string;
      imageName: string;
    } {
      // Find document with highest grossWeight or positive grossWeight
      let primaryDoc = docs[0];
      for (const d of docs) {
        if (Number(d.grossWeight) > 0) {
          primaryDoc = d;
          break;
        }
      }

      // Merge positive reserved1 (CZ) and reserved3 (BS) across all docs
      let cz = 0;
      let bs = 0;
      let img = "";
      let imgName = "";
      let itemType = primaryDoc.itemType || "";
      const sku = primaryDoc.sku || primaryDoc.designNumber || "";

      for (const d of docs) {
        const dCz = Number(d.reserved1) || 0;
        if (dCz > cz) cz = dCz;
        const dBs = Number(d.reserved3) || 0;
        if (dBs > bs) bs = dBs;
        if (!img && d.imageUrl) img = d.imageUrl;
        if (!imgName && d.imageName) imgName = d.imageName;
        if (!itemType && d.itemType) itemType = d.itemType;
      }

      const grossWeight = Number(primaryDoc.grossWeight) || 0;
      const netWeight = Number(primaryDoc.netWeight) || (grossWeight > 0 ? grossWeight : 0);
      const stoneWeight = Number(primaryDoc.stoneWeight) || (cz + bs > 0 ? cz + bs : 0);

      // Clean metal purity (KT)
      let kt = "18";
      if (primaryDoc.metalPurity) {
        const cleaned = String(primaryDoc.metalPurity).replace(/[^0-9]/g, "");
        if (cleaned) kt = cleaned;
      }

      // Clean metal type (Color)
      let color = "Y";
      if (primaryDoc.metalType && String(primaryDoc.metalType).toLowerCase() !== "unknown") {
        color = String(primaryDoc.metalType).trim().toUpperCase();
      }

      return {
        sku,
        itemType,
        grossWeight: Number(grossWeight.toFixed(3)),
        netWeight: Number(netWeight.toFixed(3)),
        stoneWeight: Number(stoneWeight.toFixed(3)),
        reserved1: Number(cz.toFixed(3)),
        reserved3: Number(bs.toFixed(3)),
        metalPurity: kt,
        metalType: color,
        imageUrl: img || primaryDoc.imageUrl || "",
        imageName: imgName || primaryDoc.imageName || "",
      };
    }

    // Now map each item from parsedList in PRESERVED ORDER
    let foundCount = 0;
    let notFoundCount = 0;

    const items: ManualOrderItemData[] = parsedList.map((rawDesign, index) => {
      const norm = normalizeDesignNumber(rawDesign) || rawDesign;
      const stripped = stripVariantSuffix(rawDesign);
      const normStripped = normalizeDesignNumber(stripped) || stripped;

      // Check for docs in catalogs
      const matchedDocs =
        docsByKey.get(rawDesign.toLowerCase()) ??
        docsByKey.get(norm.toLowerCase()) ??
        docsByKey.get(stripped.toLowerCase());

      const matchedInCatalog = Array.isArray(matchedDocs) && matchedDocs.length > 0;

      // Check for fallback image in image_index
      const indexedImg =
        imageIndexByKey.get(rawDesign.toLowerCase()) ||
        imageIndexByKey.get(norm.toLowerCase()) ||
        imageIndexByKey.get(stripped.toLowerCase()) ||
        imageIndexByKey.get(normStripped.toLowerCase());

      if (matchedInCatalog) {
        foundCount++;
        const best = extractBestData(matchedDocs);

        // If catalog didn't have imageUrl, use fallback from image_index
        const finalImageUrl = best.imageUrl || indexedImg?.imageUrl || "";
        const finalImageName = best.imageName || indexedImg?.imageName || "";

        return {
          id: `item-${index}-${rawDesign}`,
          inputDesign: rawDesign,
          normalizedDesign: norm,
          matched: true,
          sku: best.sku,
          itemType: best.itemType || "Jewellery",
          grossWeight: best.grossWeight,
          netWeight: best.netWeight,
          stoneWeight: best.stoneWeight,
          reserved1: best.reserved1,
          reserved3: best.reserved3,
          metalPurity: best.metalPurity,
          metalType: best.metalType,
          imageUrl: finalImageUrl,
          imageName: finalImageName,
          qty: 1,
          remarks: "",
          recordCount: matchedDocs.length,
          selected: true,
        };
      } else if (indexedImg) {
        // Design was NOT in catalogs, but IS in image_index (e.g. DZBL-2890)!
        foundCount++;
        return {
          id: `item-${index}-${rawDesign}`,
          inputDesign: rawDesign,
          normalizedDesign: norm,
          matched: true,
          imageOnlyMatch: true,
          sku: norm,
          itemType: "Jewellery",
          grossWeight: 0,
          netWeight: 0,
          stoneWeight: 0,
          reserved1: 0,
          reserved3: 0,
          metalPurity: "18",
          metalType: "Y",
          imageUrl: indexedImg.imageUrl,
          imageName: indexedImg.imageName,
          qty: 1,
          remarks: "",
          recordCount: 0,
          selected: true,
        };
      } else {
        // Neither in catalogs nor in image_index
        notFoundCount++;
        return {
          id: `item-${index}-${rawDesign}`,
          inputDesign: rawDesign,
          normalizedDesign: norm,
          matched: false,
          sku: norm,
          itemType: "Jewellery",
          grossWeight: 0,
          netWeight: 0,
          stoneWeight: 0,
          reserved1: 0,
          reserved3: 0,
          metalPurity: "18",
          metalType: "Y",
          imageUrl: "",
          imageName: "",
          qty: 1,
          remarks: "",
          recordCount: 0,
          selected: false,
        };
      }
    });

    return NextResponse.json({
      success: true,
      items,
      stats: {
        totalPasted,
        totalUnique: uniqueRawSet.size,
        foundCount,
        notFoundCount,
        duplicateCount,
      },
    });
  } catch (error: any) {
    console.error("[manual-order/lookup] error:", error);
    return NextResponse.json(
      { error: error?.message ?? "Failed to lookup manual order designs" },
      { status: 500 }
    );
  }
}
