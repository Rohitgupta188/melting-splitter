import { NextRequest, NextResponse } from 'next/server';

// Only allow fetching from https origins (no local file:// etc.)
const ALLOWED_PROTOCOLS = ['https:', 'http:'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB limit

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: 'url param is required' }, { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) {
    return NextResponse.json({ error: 'Protocol not allowed' }, { status: 400 });
  }

  try {
    const upstream = await fetch(rawUrl, {
      headers: { 'User-Agent': 'BrahammandJewels-ImageProxy/1.0' },
      // 8-second timeout via AbortSignal
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Upstream request failed', details: upstream.statusText },
        { status: 502 }
      );
    }
    
    const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
    const buffer = await upstream.arrayBuffer();
    
    if (buffer.byteLength > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      return NextResponse.json({ error: 'Image fetch timed out' }, { status: 504 });
    }
    console.error('[GET /api/image-proxy]', err);
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
  }
}
