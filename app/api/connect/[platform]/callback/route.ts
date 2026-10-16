import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { getConnector } from "@/lib/connectors";
import { STATE_COOKIE, STATE_COOKIE_PATH, appOrigin, redirectUri, verifyState } from "@/lib/connect";
import { syncConnection } from "@/lib/sync";
import { clip } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ platform: string }> };

function back(req: NextRequest, platform: string, status: string, extra: Record<string, string> = {}): NextResponse {
  const url = new URL("/", appOrigin(req));
  url.searchParams.set("connect", status);
  url.searchParams.set("platform", platform);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, clip(v, 500));
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}

/**
 * The platform sends the browser here after consent: ?code=…&state=… (or ?error=…). The state must verify, match the nonce
 * cookie set by /start and name this platform; then the code becomes a long-lived token set that is stored encrypted, and a
 * first sync starts in the background. Everything ends in a redirect to the app with a short result.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { platform } = await params;
  const connector = getConnector(platform);
  if (!connector) return NextResponse.json({ error: `No official connector for "${platform}".` }, { status: 404 });

  const q = req.nextUrl.searchParams;
  const refused = q.get("error");
  if (refused) return back(req, platform, "denied", { reason: q.get("error_description") ?? q.get("error_reason") ?? refused });

  const state = await verifyState(q.get("state"));
  const nonce = req.cookies.get(STATE_COOKIE)?.value;
  if (!state || state.platform !== platform || !nonce || nonce !== state.nonce) {
    return back(req, platform, "error", { reason: "The connection attempt expired or did not start here. Press Connect again." });
  }
  const code = q.get("code");
  if (!code) return back(req, platform, "error", { reason: "The platform did not return an authorization code." });

  const brand = await prisma.brand.findUnique({ where: { slug: state.brandSlug }, select: { id: true } });
  if (!brand) return back(req, platform, "error", { reason: "The brand of this connection no longer exists." });

  try {
    const tokens = await connector.exchangeCode({ code, redirectUri: redirectUri(req, platform) });
    const data = {
      handle: tokens.handle ?? null,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes ?? [],
      status: "ok",
      lastError: null,
    };
    const conn = await prisma.platformConnection.upsert({
      where: { brandId_platform_externalId: { brandId: brand.id, platform, externalId: tokens.externalId } },
      create: { brandId: brand.id, platform, externalId: tokens.externalId, ...data },
      update: data,
    });
    void syncConnection(conn.id).catch((err) => console.error(`[connect] first sync of ${platform} failed:`, err instanceof Error ? err.message : err));
    return back(req, platform, "ok", { handle: tokens.handle ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The connection failed.";
    console.error(`[connect] ${platform} callback failed: ${message}`);
    return back(req, platform, "error", { reason: message });
  }
}
