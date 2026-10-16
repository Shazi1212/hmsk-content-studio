import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { AssetInputError, MAX_ASSET_BYTES, createAssetFromForm, findBrandBySlug, listAssets, toAssetDto } from "@/lib/brand-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The first list of a brand fetches its built-in website images (10 s timeout each, in parallel).
export const maxDuration = 60;

type Ctx = { params: Promise<{ slug: string }> };

/** Next's proxy buffers at most 10 MB of a request body (proxyClientMaxBodySize); anything near that cannot be a valid upload. */
const MAX_BODY_BYTES = MAX_ASSET_BYTES + 2 * 1024 * 1024;

/**
 * GET → { assets: [{ id, kind, label, isDefault, position, url, mime, size, source: "upload"|"website", createdAt }] }
 * Visible (not hidden) reference images of the brand, ordered by position then createdAt. The first call of a brand imports the
 * built-in website images of data/brands.ts (lib/references.ts). 404 for an unknown brand.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  try {
    const brand = await findBrandBySlug(slug);
    if (!brand) return NextResponse.json({ error: `Unknown brand "${slug}".`, code: "not_found" }, { status: 404 });
    return NextResponse.json({ assets: await listAssets(req, brand) });
  } catch (err) {
    return errorResponse(err, "api/brands/[slug]/assets GET");
  }
}

/**
 * POST multipart/form-data { file (png/jpeg/webp, ≤ 8 MB), kind (default "other"), label (1..200), isDefault ("true"/"false", default true) }
 * → 201 with the asset. 422 `{ error, issues, code: "validation" }` for a wrong type, size or field; 404 for an unknown brand.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  try {
    const brand = await findBrandBySlug(slug);
    if (!brand) return NextResponse.json({ error: `Unknown brand "${slug}".`, code: "not_found" }, { status: 404 });

    const length = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: `The upload is ${(length / (1024 * 1024)).toFixed(1)} MB; images may be at most 8 MB. Use a smaller image.`, code: "too_large" },
        { status: 413 },
      );
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Body must be multipart/form-data with the fields file, kind, label and isDefault.", code: "bad_request" }, { status: 400 });
    }
    const asset = await createAssetFromForm(brand, form);
    return NextResponse.json(toAssetDto(req, asset), { status: 201 });
  } catch (err) {
    if (err instanceof AssetInputError) {
      return NextResponse.json({ error: err.message, issues: err.issues, code: "validation" }, { status: err.status });
    }
    return errorResponse(err, "api/brands/[slug]/assets POST");
  }
}
