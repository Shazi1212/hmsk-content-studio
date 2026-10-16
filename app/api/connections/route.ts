import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { CONNECTOR_PLATFORMS, connectorStatus } from "@/lib/connectors";
import { redirectUri } from "@/lib/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → the connected accounts (never tokens) plus which connectors have their env vars and the redirect URI each platform
 * console must list. The Research tab's "Data sources" panel renders this.
 */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const rows = await prisma.platformConnection.findMany({
      orderBy: [{ brand: { slug: "asc" } }, { platform: "asc" }],
      select: {
        id: true,
        platform: true,
        externalId: true,
        handle: true,
        status: true,
        expiresAt: true,
        scopes: true,
        lastSyncAt: true,
        lastSyncCount: true,
        lastError: true,
        createdAt: true,
        brand: { select: { slug: true, name: true } },
      },
    });
    return NextResponse.json({
      connections: rows.map(({ brand, ...c }) => ({ ...c, brandSlug: brand.slug, brandName: brand.name })),
      connectors: connectorStatus().map((c) => ({ ...c, redirectUri: redirectUri(req, c.platform) })),
      platforms: CONNECTOR_PLATFORMS,
    });
  } catch (err) {
    return errorResponse(err, "api/connections GET");
  }
}
