import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { errorResponse, zodIssues } from "@/lib/pipeline";
import { UpdateAssetSchema, deleteAsset, findBrandBySlug, findVisibleAsset, toAssetDto, updateAsset } from "@/lib/brand-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

/** Resolves brand and asset; a missing brand, an unknown asset, a hidden one or one of another brand is a 404. */
async function resolve(slug: string, id: string) {
  const brand = await findBrandBySlug(slug);
  if (!brand) return { ok: false as const, response: NextResponse.json({ error: `Unknown brand "${slug}".`, code: "not_found" }, { status: 404 }) };
  const asset = await findVisibleAsset(brand.id, id);
  if (!asset) return { ok: false as const, response: NextResponse.json({ error: "Asset not found.", code: "not_found" }, { status: 404 }) };
  return { ok: true as const, asset };
}

/** PATCH JSON { kind?, label?, isDefault?, position? } → the updated asset. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug, id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {kind?, label?, isDefault?, position?}.", code: "bad_request" }, { status: 400 });
  }
  const parsed = UpdateAssetSchema.safeParse(body);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; "), issues, code: "validation" }, { status: 422 });
  }
  try {
    const found = await resolve(slug, id);
    if (!found.ok) return found.response;
    return NextResponse.json(toAssetDto(req, await updateAsset(found.asset, parsed.data)));
  } catch (err) {
    return errorResponse(err, "api/brands/[slug]/assets/[id] PATCH");
  }
}

/** DELETE → { ok: true }. An uploaded image is deleted with its bytes; an imported website image is hidden (not re-imported). */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug, id } = await params;
  try {
    const found = await resolve(slug, id);
    if (!found.ok) return found.response;
    await deleteAsset(found.asset);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "api/brands/[slug]/assets/[id] DELETE");
  }
}
