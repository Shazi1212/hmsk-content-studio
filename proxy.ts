/**
 * Next.js 16 proxy (formerly middleware): gates every page and API route behind the shared-password session.
 * Public: /login, /api/login, /api/logout, /api/media/{id} (hosted key visuals and voice-overs; the unguessable id is the
 * capability, and Higgsfield has to fetch the start image without a session) and static assets (see matcher).
 * Unauthenticated /api/* → 401 JSON; unauthenticated pages → redirect to /login?next=…
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authMode, lockedMessage, verifySessionToken } from "@/lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout"]);
const PUBLIC_PREFIXES = ["/api/media/"];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const mode = authMode();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = mode === "password" && token ? await verifySessionToken(token) : null;
  const authenticated = mode === "open" || session !== null;

  if (PUBLIC_PATHS.has(pathname)) {
    // Already logged in → skip the login page.
    if (pathname === "/login" && authenticated && mode === "password") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (authenticated || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    if (mode === "locked") {
      const locked = lockedMessage();
      return NextResponse.json({ error: locked.error, hint: locked.hint, code: "auth_locked" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized. Log in at /login." }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
  if (mode === "locked") loginUrl.searchParams.set("reason", lockedMessage().code === "short" ? "short" : "config");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json|woff2?|ttf|css|js|map)$).*)"],
};
