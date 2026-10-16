import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { BrandInputSchema, brandData, firstIssue, toBrandDto } from "@/lib/brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const notFound = (slug: string) => NextResponse.json({ error: `Unknown brand "${slug}".`, code: "not_found" }, { status: 404 });

export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  try {
    const brand = await prisma.brand.findUnique({ where: { slug } });
    return brand ? NextResponse.json(toBrandDto(brand)) : notFound(slug);
  } catch (err) {
    return errorResponse(err, "api/brands/[slug] GET");
  }
}

/** PUT BrandInput → BrandDto. Replaces every editable field; the slug never changes (generations and assets keep their link). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON.", code: "bad_request" }, { status: 400 });
  }
  const parsed = BrandInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error), code: "validation" }, { status: 422 });
  try {
    const existing = await prisma.brand.findUnique({ where: { slug }, select: { id: true } });
    if (!existing) return notFound(slug);
    const brand = await prisma.brand.update({ where: { slug }, data: brandData(parsed.data) });
    return NextResponse.json(toBrandDto(brand));
  } catch (err) {
    return errorResponse(err, "api/brands/[slug] PUT");
  }
}

/**
 * DELETE → { ok: true }. Removes the brand with its reference posts, generations, idea batches, connections and reference images
 * (cascade). The last remaining brand cannot be deleted (409): the studio always needs one.
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  try {
    const brand = await prisma.brand.findUnique({ where: { slug }, select: { id: true } });
    if (!brand) return notFound(slug);
    if ((await prisma.brand.count()) <= 1) {
      return NextResponse.json({ error: "The last brand cannot be deleted. Create another brand first.", code: "conflict" }, { status: 409 });
    }
    const assets = await prisma.brandAsset.findMany({ where: { brandId: brand.id }, select: { mediaId: true } });
    await prisma.brand.delete({ where: { slug } });
    if (assets.length) await prisma.mediaAsset.deleteMany({ where: { id: { in: assets.map((a) => a.mediaId) } } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "api/brands/[slug] DELETE");
  }
}
