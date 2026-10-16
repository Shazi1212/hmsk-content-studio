import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { getConnector } from "@/lib/connectors";
import { clip } from "@/lib/text";
import { STATE_COOKIE, STATE_COOKIE_MAX_AGE, STATE_COOKIE_PATH, appOrigin, createState, redirectUri } from "@/lib/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ platform: string }> };

/** Back to the app with a result the UI turns into a toast (ContentStudio reads ?connect=…). */
function back(req: NextRequest, platform: string, status: string, reason?: string): NextResponse {
  const url = new URL("/", appOrigin(req));
  url.searchParams.set("connect", status);
  url.searchParams.set("platform", platform);
  if (reason) url.searchParams.set("reason", clip(reason, 500));
  return NextResponse.redirect(url);
}

/**
 * GET ?brand=<slug>[&reauth=1] → 302 to the platform's consent screen. The "Connect" buttons are plain links to this
 * route, so the browser carries the session cookie. `reauth=1` forces the login screen (second account in one browser).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { platform } = await params;
  const connector = getConnector(platform);
  if (!connector) return NextResponse.json({ error: `No official connector for "${platform}".` }, { status: 404 });

  const brandSlug = req.nextUrl.searchParams.get("brand")?.trim() ?? "";
  const brand = brandSlug ? await prisma.brand.findUnique({ where: { slug: brandSlug }, select: { slug: true } }) : null;
  if (!brand) return NextResponse.json({ error: "Unknown brand. Open the link from the Data sources panel." }, { status: 422 });
  if (!connector.isConfigured()) return back(req, platform, "not_configured", `Set ${connector.requiredEnv.join(" and ")} in the app's environment variables first.`);

  const { token, nonce } = await createState(platform, brand.slug);
  const res = NextResponse.redirect(
    connector.authorizeUrl({ redirectUri: redirectUri(req, platform), state: token, forceReauth: req.nextUrl.searchParams.get("reauth") === "1" }),
  );
  res.cookies.set(STATE_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: STATE_COOKIE_PATH, maxAge: STATE_COOKIE_MAX_AGE });
  return res;
}
