import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Product } from '@/models/Product.model';

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
    const { designNumbers } = await req.json();

    if (!Array.isArray(designNumbers) || designNumbers.length === 0) {
      return NextResponse.json({ productMap: {} });
    }

    await connectDB();

    const productMap: Record<string, string> = {};

    // ── Layer 1: exact match on designNumber / sku ──────────────────────────
    // Uses the raw PDF string (e.g. "TRPD073-c") which is exactly what MongoDB
    // stores in the designNumber and sku fields.
    const layer1 = await Product.find({
      $or: [
        { designNumber: { $in: designNumbers } },
        { sku: { $in: designNumbers } },
      ],
    }).select('designNumber sku imageUrl').lean() as any[];

    const foundByLayer1 = new Set<string>();

    for (const p of layer1) {
      if (!p.imageUrl) continue;
      // Key by whichever field matched the incoming raw design number.
      if (p.designNumber && designNumbers.includes(p.designNumber)) {
        productMap[p.designNumber] = p.imageUrl;
        foundByLayer1.add(p.designNumber);
      }
      if (p.sku && designNumbers.includes(p.sku)) {
        productMap[p.sku] = p.imageUrl;
        foundByLayer1.add(p.sku);
      }
    }

    // ── Layer 2: imageName fallback for anything not found in Layer 1 ───────
    // For each unfound raw number, strip the variant suffix to get the base
    // design number, then search the imageName field (stored as "TRPD073.jpg").
    // This handles the case where the PDF contains "TRPD073-c" but the DB
    // only has imageName "TRPD073.jpg" with no matching designNumber field.
    const notFound = designNumbers.filter((d: string) => !foundByLayer1.has(d));

    if (notFound.length > 0) {
      // Build a reverse map:  baseDesignNumber → [rawDesignNumbers that strip to it]
      // (multiple raws can share the same base, e.g. "TRPD073-c" & "TRPD073-d")
      const baseToRaws = new Map<string, string[]>();
      const imageNamesToSearch: string[] = [];

      for (const raw of notFound) {
        const base = stripVariantSuffix(raw);
        // Search for both .jpg and .jpeg in case the catalogue uses either
        const imageName = `${base}.jpg`;

        if (!baseToRaws.has(base)) {
          baseToRaws.set(base, []);
          imageNamesToSearch.push(imageName);
        }
        baseToRaws.get(base)!.push(raw);
      }

      const layer2 = await Product.find({
        imageName: { $in: imageNamesToSearch },
      }).select('imageName imageUrl').lean() as any[];

      for (const p of layer2) {
        if (!p.imageUrl || !p.imageName) continue;

        // Strip the file extension to recover the base design number.
        const base = (p.imageName as string).replace(/\.[^.]+$/, "");

        // Map the imageUrl back to every raw design number that strips to this base.
        const raws = baseToRaws.get(base) ?? baseToRaws.get(base.toLowerCase());
        if (raws) {
          for (const raw of raws) {
            productMap[raw] = p.imageUrl;
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

