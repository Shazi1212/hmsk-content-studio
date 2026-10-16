import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { BrandInputSchema, brandData, firstIssue, slugify, toBrandDto } from "@/lib/brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → { brands: BrandDto[] } with every field (the Brands tab edits them). */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const brands = await prisma.brand.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json({ brands: brands.map(toBrandDto) });
  } catch (err) {
    return errorResponse(err, "api/brands GET");
  }
}

/** POST BrandInput → 201 BrandDto. The slug is derived from the name when absent and made unique with a numeric suffix. */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON.", code: "bad_request" }, { status: 400 });
  }
  const parsed = BrandInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error), code: "validation" }, { status: 422 });
  try {
    const base = parsed.data.slug || slugify(parsed.data.name);
    let slug = base;
    for (let i = 2; await prisma.brand.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`;
    const brand = await prisma.brand.create({ data: { slug, ...brandData(parsed.data) } });
    return NextResponse.json(toBrandDto(brand), { status: 201 });
  } catch (err) {
    return errorResponse(err, "api/brands POST");
  }
}
