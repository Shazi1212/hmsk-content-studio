import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { performanceBucket } from "@/lib/retrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything the Research tab shows; the raw import blob and the keyword search column stay on the server.
const SELECT = {
  id: true,
  brand: { select: { slug: true, name: true } },
  platform: true,
  postUrl: true,
  date: true,
  format: true,
  pillar: true,
  topic: true,
  product: true,
  hook: true,
  hookType: true,
  mainMessage: true,
  visualConcept: true,
  visualStyle: true,
  colors: true,
  typography: true,
  people: true,
  productPlacement: true,
  captionStyle: true,
  captionStructure: true,
  cta: true,
  ctaType: true,
  views: true,
  likes: true,
  comments: true,
  shares: true,
  saves: true,
  engagementIndicators: true,
  performanceLevel: true,
  performanceEvidence: true,
  audienceReaction: true,
  trendReference: true,
  storytelling: true,
  emotionalDriver: true,
  contentMechanism: true,
  replicability: true,
  observations: true,
  confidence: true,
  sourceEvidence: true,
  source: true,
} satisfies Prisma.ReferencePostSelect;

/**
 * GET ?brandSlug= → the researched posts the strategist learns from (one brand, or all brands), each with its
 * performance bucket (exceptional | high | typical | mixed | low | unknown). The set is usually small (hundreds of rows), so the UI
 * filters and sorts it client-side.
 */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const brandSlug = req.nextUrl.searchParams.get("brandSlug")?.trim() || undefined;
  try {
    const rows = await prisma.referencePost.findMany({
      where: brandSlug ? { brand: { slug: brandSlug } } : {},
      orderBy: [{ brand: { slug: "asc" } }, { createdAt: "asc" }],
      select: SELECT,
    });
    return NextResponse.json({
      references: rows.map(({ brand, ...r }) => ({
        ...r,
        brandSlug: brand.slug,
        brandName: brand.name,
        bucket: performanceBucket(r.performanceLevel),
      })),
      count: rows.length,
    });
  } catch (err) {
    return errorResponse(err, "api/references GET");
  }
}
