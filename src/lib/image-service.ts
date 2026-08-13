import { ParsedRow } from "./types";

// ---------------------------------------------------------------------------
// In-memory cache: imageUrl -> base64 data-URL
// Lives for the lifetime of the browser tab (module scope).
// Cleared at the start of each processing run via resetImageState().
// ---------------------------------------------------------------------------
const imageCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Stats - reset each run via resetImageState()
// ---------------------------------------------------------------------------
let _statsFetched = 0;  // fetched fresh from the proxy (unique URLs)
let _statsCached  = 0;  // served from in-memory cache (duplicate designs pointing to same URL)
let _statsMissing = 0;  // DB had no record OR proxy returned a non-OK response

export interface ImageStats {
  fetched: number;
  cached:  number;
  missing: number;
}

export function resetImageState(): void {
  imageCache.clear();
  _statsFetched = 0;
  _statsCached  = 0;
  _statsMissing = 0;
}

export function getImageStats(): ImageStats {
  return { fetched: _statsFetched, cached: _statsCached, missing: _statsMissing };
}

// ---------------------------------------------------------------------------
// Concurrency limiter - runs at most `limit` async tasks simultaneously.
//
// WHY: Without this, Promise.allSettled fires ALL image fetches at once.
// The browser has a per-origin connection limit (~6 for HTTP/1.1). Excess
// requests sit in the browser connection queue. Any client-side timer that
// fires while a request is still queued produces:
//   "AbortError: signal is aborted without reason"
// even though the network was never contacted.
//
// Limiting to 8 concurrent requests keeps the queue empty so every fetch
// starts immediately and has the full network RTT available.
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
//
// NO client-side AbortController/setTimeout here.
// The /api/image-proxy route applies its own AbortSignal.timeout() server-side
// and returns a 504 if ImageKit is slow. A second client-side timer would only
// abort requests that are legitimately waiting their turn in the connection pool.
// ---------------------------------------------------------------------------
async function fetchBase64ThroughProxy(url: string): Promise<string | null> {
  // Cache hit - no network call needed
  if (imageCache.has(url)) {
    return imageCache.get(url)!;
  }

  try {
    const resp = await fetch(`/api/image-proxy?url=${encodeURIComponent(url)}`);

    if (!resp.ok) {
      // 4xx / 5xx from the proxy - image unavailable, not a crash
      return null;
    }

    // arrayBuffer + btoa: modern, synchronous, no FileReader callback needed.
    // Chunked to avoid call-stack overflow on large images (btoa is limited
    // by the JS engine argument count when spreading large Uint8Arrays).
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
    // Real network/parse error - non-fatal
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
//   4. Fetch unique imageUrls concurrency-limited to 8 simultaneous requests.
//   5. Tally stats.
// ---------------------------------------------------------------------------
export async function resolveImages(rows: ParsedRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Step 1 – build two lookup sets
  //
  //   uniqueRaw  = exact PDF strings (e.g. "TRPD073-c", "DZPS21815")
  //                Needed so Layer 1 can match DB records where designNumber
  //                includes the -c/-d variant suffix.
  //
  //   uniqueNorm = normalized forms   (e.g. "TRPD073",   "DZPS-21815")
  //                Needed because normalizeDesignNumber inserts hyphens for DZ/WH
  //                prefixes, and the DB stores "DZPS-21815" not "DZPS21815".
  //
  // We send both to the API and key the productMap by whichever form matches.
  const uniqueRaw  = [...new Set(rows.map(r => r.rawDesignNumber))];
  const uniqueNorm = [...new Set(rows.map(r => r.designNumber))];
  // Combine and deduplicate (raw === norm when there is no transformation)
  const allLookup  = [...new Set([...uniqueRaw, ...uniqueNorm])];

  // Step 2 – batch DB lookup with both forms
  let productMap: Record<string, { imageUrl?: string, itemType?: string }> = {};
  try {
    const res = await fetch("/api/images-lookup", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ designNumbers: allLookup }),
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
  // Try the raw key first (preserves -c/-d variant match), then fall back to
  // the normalized key (handles hyphen-inserted forms like DZPS-21815).
  for (const row of rows) {
    const data = productMap[row.rawDesignNumber] ?? productMap[row.designNumber];
    if (data) {
      if (data.imageUrl) row.imageUrl = data.imageUrl;
      if (data.itemType) row.itemType = data.itemType;
    }
  }

  // Step 4 – count DB-missing (unique raw designs that resolved to nothing)
  const foundKeys = new Set(Object.keys(productMap));
  for (const d of uniqueRaw) {
    const norm = rows.find(r => r.rawDesignNumber === d)?.designNumber;
    if (!foundKeys.has(d) && (!norm || !foundKeys.has(norm))) {
      _statsMissing++;
    }
  }

  // Step 5 - fetch unique image URLs with concurrency cap
  const uniqueUrls   = [...new Set(Object.values(productMap).map(p => p.imageUrl).filter(Boolean) as string[])];
  const urlsToFetch  = uniqueUrls.filter(u => !imageCache.has(u));
  const urlsInCache  = uniqueUrls.filter(u =>  imageCache.has(u));

  // URLs already cached = cache hits (deduplicated image reuse across designs)
  _statsCached += urlsInCache.length;

  // Fetch the rest 8 at a time
  const fetchTasks = urlsToFetch.map(url => () => fetchBase64ThroughProxy(url));
  const settled    = await runWithConcurrency(fetchTasks, 8);

  for (const result of settled) {
    if (result.status === "fulfilled" && result.value !== null) {
      _statsFetched++;
    } else {
      // null = proxy returned non-OK; rejected = unexpected error
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
  return imageCache.get(url) ?? null;
}
