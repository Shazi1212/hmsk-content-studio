import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { generateImage } from "@/lib/providers";
import { hostMedia } from "@/lib/media";
import { isProductKind, loadBrandReferences } from "@/lib/references";
import { requireSession } from "@/lib/auth";
import { errorResponse, zodIssues } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required").max(4000),
  aspectRatio: z.string().trim().regex(/^\d{1,2}:\d{1,2}$/, "aspectRatio must look like 9:16, 1:1 or 16:9").optional(),
  brandSlug: z.string().trim().min(1).max(100).optional(),
  /** false = text-only generation even when a brandSlug is given. */
  references: z.boolean().optional(),
  /** BrandAsset ids to send as references instead of the brand's default ones (exactly these; [] = none). Ignored without a brandSlug. */
  referenceIds: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
});

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * POST {prompt, aspectRatio?, brandSlug?, references?, referenceIds?} → image bytes (Content-Type from the provider) or 502 JSON.
 * References are the brand's reference images (BrandAsset, lib/references.ts): its default ones, or exactly the referenceIds picked
 * per generation; `references: false` sends none. The image is also hosted by the app itself (lib/media.ts) and its public URL
 * is returned in the X-Asset-Url header (used as the image-to-video start frame and stored as Generation.imageUrl on approve).
 */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {prompt, aspectRatio?, brandSlug?, references?, referenceIds?}." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }

  try {
    const { brandSlug, references: useRefs, referenceIds, ...input } = parsed.data;
    const references = brandSlug && useRefs !== false ? await loadBrandReferences(brandSlug, referenceIds ? { ids: referenceIds } : {}) : [];
    const image = await generateImage({ ...input, references });
    const mime = image.mime || "image/png";
    const ext = EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
    const filename = `key-visual-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    const assetUrl = await hostMedia("api/image", req, { kind: "image", mime, bytes: image.bytes });
    return new Response(toArrayBuffer(image.bytes), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(image.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Provider": image.provider,
        "X-Model": image.model,
        "X-References": String(references.length),
        "X-Reference-Products": String(references.filter((r) => isProductKind(r.kind)).length),
        ...(assetUrl ? { "X-Asset-Url": assetUrl } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err, "api/image");
  }
}
