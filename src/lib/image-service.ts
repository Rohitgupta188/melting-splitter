import { ParsedRow } from "./types";
import { extractNativeImages } from "./pdf-native-image";
import { extractFallbackImages } from "./pdf-fallback";
import type { PDFDocumentProxy } from "pdfjs-dist";

// ---------------------------------------------------------------------------
// In-memory cache: imageUrl -> base64 data-URL
// Lives for the lifetime of the browser tab (module scope).
// Cleared at the start of each processing run via resetImageState().
// ---------------------------------------------------------------------------
const imageCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Stats - reset each run via resetImageState()
// ---------------------------------------------------------------------------
let _statsCatalogue = 0;
let _statsCached  = 0;
let _statsNative = 0;
let _statsCrop = 0;
let _statsMissing = 0;

export interface ImageStats {
  catalogue: number;
  cached:  number;
  native: number;
  crop: number;
  missing: number;
}

export function resetImageState(): void {
  imageCache.clear();
  _statsCatalogue = 0;
  _statsCached  = 0;
  _statsNative = 0;
  _statsCrop = 0;
  _statsMissing = 0;
}

export function getImageStats(): ImageStats {
  return { 
    catalogue: _statsCatalogue, 
    cached: _statsCached, 
    native: _statsNative, 
    crop: _statsCrop, 
    missing: _statsMissing 
  };
}

// ---------------------------------------------------------------------------
// Concurrency limiter - runs at most `limit` async tasks simultaneously.
// ---------------------------------------------------------------------------
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Internal: fetch one image through the server-side proxy.
// ---------------------------------------------------------------------------
async function fetchBase64ThroughProxy(url: string): Promise<string | null> {
  if (imageCache.has(url)) {
    return imageCache.get(url)!;
  }

  try {
    const resp = await fetch(`/api/image-proxy?url=${encodeURIComponent(url)}`);

    if (!resp.ok) {
      return null;
    }

    const buffer = await resp.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }

    const contentType = resp.headers.get("content-type") ?? "image/jpeg";
    const base64 = `data:${contentType};base64,${btoa(binary)}`;

    imageCache.set(url, base64);
    return base64;
  } catch (err) {
    console.warn(`[image-service] Proxy fetch failed for ${url}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: batch-resolve images for all rows.
//
// Pipeline:
//   1. Collect unique design numbers.
//   2. One POST to /api/images-lookup -> { productMap: { designNumber: imageUrl } }.
//   3. Assign imageUrls onto rows (mutates in-place).
//   4. Fetch catalogue URLs. If any fail, clear their imageUrl.
//   5. Fallback 1: Native PDF Image Extraction for missing rows.
//   6. Fallback 2: Visual PDF Crop for remaining missing rows.
//   7. Tally stats.
// ---------------------------------------------------------------------------
export async function resolveImages(rows: ParsedRow[], pdfDoc: PDFDocumentProxy): Promise<void> {
  if (rows.length === 0) return;

  // Step 1 – build two lookup sets
  const uniqueRaw  = [...new Set(rows.map(r => r.rawDesignNumber))];
  const uniqueNorm = [...new Set(rows.map(r => r.designNumber))];
  const allLookup  = [...new Set([...uniqueRaw, ...uniqueNorm])];

  // Step 2 – batch DB lookup with both forms
  let productMap: Record<string, { imageUrl?: string, itemType?: string }> = {};
  try {
    const res = await fetch("/api/images-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designNumbers: allLookup }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.productMap && typeof data.productMap === "object") {
        productMap = data.productMap;
      }
    } else {
      console.error("[image-service] images-lookup HTTP error:", res.status, res.statusText);
    }
  } catch (err) {
    console.error("[image-service] images-lookup network error:", err);
  }

  // Step 3 – assign imageUrls and itemType to rows
  for (const row of rows) {
    const data = productMap[row.rawDesignNumber] ?? productMap[row.designNumber];
    if (data) {
      if (data.imageUrl) {
        row.imageUrl = data.imageUrl;
        row.imageSource = "catalogue";
      }
      if (data.itemType) row.itemType = data.itemType;
    }
  }

  // Step 4 - fetch catalogue image URLs with concurrency cap
  const catalogueRows = rows.filter(r => r.imageSource === "catalogue" && r.imageUrl);
  const uniqueUrls = [...new Set(catalogueRows.map(r => r.imageUrl!))];
  const urlsToFetch = uniqueUrls.filter(u => !imageCache.has(u));
  const urlsInCache = uniqueUrls.filter(u => imageCache.has(u));

  _statsCached += urlsInCache.length;

  const fetchTasks = urlsToFetch.map(url => () => fetchBase64ThroughProxy(url));
  await runWithConcurrency(fetchTasks, 8);

  // If fetch failed, unset it so it falls back to native/crop
  for (const row of catalogueRows) {
    if (!imageCache.has(row.imageUrl!)) {
      row.imageUrl = undefined;
      row.imageSource = undefined;
    }
  }

  // Step 5 - Native PDF Extraction
  const missingAfterCatalogue = rows.filter(r => !r.imageUrl);
  if (missingAfterCatalogue.length > 0) {
    await extractNativeImages(pdfDoc, missingAfterCatalogue);
  }

  // Step 6 - Visual PDF Crop
  const missingAfterNative = missingAfterCatalogue.filter(r => !r.imageUrl);
  if (missingAfterNative.length > 0) {
    await extractFallbackImages(pdfDoc, missingAfterNative);
  }

  // Step 7 - Tally stats based on final row states
  for (const row of rows) {
    if (row.imageSource === "catalogue") _statsCatalogue++;
    else if (row.imageSource === "pdf-native") _statsNative++;
    else if (row.imageSource === "pdf-crop") _statsCrop++;
    else {
      row.imageSource = "missing";
      _statsMissing++;
    }
  }
}

// ---------------------------------------------------------------------------
// Public: retrieve a cached base64 data-URL by imageUrl.
// Called by generateSplitPdf.ts inside didDrawCell to embed images.
// ---------------------------------------------------------------------------
export function getCachedImage(url: string | undefined): string | null {
  if (!url) return null;
  
  // Note: PDF-extracted images store their base64 data directly in row.imageUrl 
  // (which is passed as 'url' here) instead of in the cache map. 
  // We check if it's already a data URL.
  if (url.startsWith("data:image/")) return url;
  
  return imageCache.get(url) ?? null;
}
