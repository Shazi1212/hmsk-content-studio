import { NextResponse, type NextRequest } from "next/server";
import { readMedia } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Parses a single `Range: bytes=…` header against `size`. null = no usable range (serve everything); "invalid" = 416. */
function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]); // last N bytes
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "invalid" : { start, end };
}

function slice(bytes: Uint8Array, start: number, endExclusive: number): ArrayBuffer {
  const ab = new ArrayBuffer(endExclusive - start);
  new Uint8Array(ab).set(bytes.subarray(start, endExclusive));
  return ab;
}

/**
 * GET → a hosted key visual or voice-over. Public on purpose (proxy.ts): the unguessable id is the access control, and
 * Higgsfield must be able to fetch the image. Range requests are supported because Safari will not play audio without them.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  let asset;
  try {
    asset = await readMedia(id);
  } catch (err) {
    console.error("[api/media] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "The media store is not available." }, { status: 503 });
  }
  if (!asset) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const etag = `"${id}"`;
  const base: Record<string, string> = {
    "Content-Type": asset.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  };
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": base["Cache-Control"] } });

  const range = parseRange(req.headers.get("range"), asset.size);
  if (range === "invalid") return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${asset.size}` } });
  if (range) {
    const body = slice(asset.bytes, range.start, range.end + 1);
    return new Response(body, {
      status: 206,
      headers: { ...base, "Content-Length": String(body.byteLength), "Content-Range": `bytes ${range.start}-${range.end}/${asset.size}` },
    });
  }
  const body = slice(asset.bytes, 0, asset.size);
  return new Response(body, { status: 200, headers: { ...base, "Content-Length": String(body.byteLength) } });
}
