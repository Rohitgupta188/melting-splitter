import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Product } from '@/models/Product.model';
import { normalizeDesignNumber } from '@/lib/design-number';

// ---------------------------------------------------------------------------
// Strip trailing single-letter variant suffixes from a design number.
// Examples:
//   "TRPD073-c"    → "TRPD073"
//   "DZBER-8711-c" → "DZBER-8711"
//   "TRPD073"      → "TRPD073"  (no suffix, returned as-is)
//
// We strip any trailing  "-[single letter]"  because the catalogue image files
// never include the variant letter (imageName is always the base form).
// ---------------------------------------------------------------------------
function stripVariantSuffix(raw: string): string {
  return raw.replace(/-[A-Za-z]$/i, "").trim();
}

export async function POST(req: Request) {
  try {
    const { designNumbers: rawNumbers } = await req.json();

    if (!Array.isArray(rawNumbers) || rawNumbers.length === 0) {
      return NextResponse.json({ productMap: {} });
    }

    // Safety net: ensure the backend checks the normalized version (with hyphens added) 
    // even if the frontend only sent the raw string.
    const designNumbers = [...new Set([
      ...rawNumbers,
      ...rawNumbers.map((d: string) => normalizeDesignNumber(d)).filter(Boolean)
    ])];

    await connectDB();

    const productMap: Record<string, { imageUrl?: string, itemType?: string }> = {};

    // ── Layer 1: exact match on designNumber ──────────────────────────
    // Uses the raw PDF string (e.g. "TRPD073-c") which is exactly what MongoDB
    // stores in the designNumber field.
    const layer1 = await Product.find({
      designNumber: { $in: designNumbers }
    }).select('designNumber imageUrl itemType').lean() as any[];

    const foundByLayer1 = new Set<string>();

    for (const p of layer1) {
      if (p.designNumber && designNumbers.includes(p.designNumber)) {
        productMap[p.designNumber] = {
          imageUrl: p.imageUrl,
          itemType: p.itemType
        };
        foundByLayer1.add(p.designNumber);
      }
    }

    // ── Layer 2: imageName fallback for anything not found in Layer 1 ───────
    // For each unfound raw number, strip the variant suffix to get the base
    // design number, then search the imageName field (stored as "TRPD073.jpg").
    // This handles the case where the PDF contains "TRPD073-c" but the DB
    // only has imageName "TRPD073.jpg" with no matching designNumber field.
    const notFound = designNumbers.filter((d: string) => {
      // Don't send to Layer 2 if this exact string was found, OR if its normalized version was found!
      return !foundByLayer1.has(d) && !foundByLayer1.has(normalizeDesignNumber(d));
    });

    if (notFound.length > 0) {
      // Build a reverse map:  baseDesignNumber → [rawDesignNumbers that strip to it]
      // (multiple raws can share the same base, e.g. "TRPD073-c" & "TRPD073-d")
      const baseToRaws = new Map<string, string[]>();
      const imageNamesToSearch: string[] = [];

      for (const raw of notFound) {
        let base = stripVariantSuffix(raw);
        base = normalizeDesignNumber(base) || base; // Ensure hyphen is added if missing
        
        // Add multiple extensions for catalogue matching
        const names = [`${base}.jpg`, `${base}.JPG`, `${base}.jpeg`, `${base}.JPEG`];

        if (!baseToRaws.has(base)) {
          baseToRaws.set(base, []);
          imageNamesToSearch.push(...names);
        }
        baseToRaws.get(base)!.push(raw);
      }

      const layer2 = await Product.find({
        imageName: { $in: imageNamesToSearch },
      }).select('imageName imageUrl itemType').lean() as any[];

      for (const p of layer2) {
        if (!p.imageName) continue;

        // Strip the file extension to recover the base design number.
        const base = (p.imageName as string).replace(/\.[^.]+$/, "");

        // Map the data back to every raw design number that strips to this base.
        const raws = baseToRaws.get(base) ?? baseToRaws.get(base.toLowerCase());
        if (raws) {
          for (const raw of raws) {
            productMap[raw] = {
              imageUrl: p.imageUrl,
              itemType: p.itemType
            };
          }
        }
      }
    }

    return NextResponse.json({ productMap });

  } catch (error: any) {
    console.error("[images-lookup] error:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to lookup images" },
      { status: 500 }
    );
  }
}

