/**
 * OAuth plumbing for the "Connect" buttons: the signed `state` that carries brand and platform through the platform's
 * consent screen and back, and the app's public origin (the redirect URI the platforms were told about).
 *
 * The state is a short-lived JWT signed with AUTH_SECRET. Its random nonce is also set as an httpOnly cookie when the
 * flow starts, and the callback requires both to match, so a callback URL forged by someone else (login CSRF) cannot
 * attach an attacker's social account to a brand. The callback needs the normal session cookie as well.
 */
import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { getAuthSecret } from "@/lib/auth";

const STATE_ISSUER = "content-studio-oauth";
const STATE_TTL_SECONDS = 10 * 60;
export const STATE_COOKIE = "cs_oauth_state";
export const STATE_COOKIE_PATH = "/api/connect";
export const STATE_COOKIE_MAX_AGE = STATE_TTL_SECONDS;

export type OAuthState = { platform: string; brandSlug: string; nonce: string };

export async function createState(platform: string, brandSlug: string): Promise<{ token: string; nonce: string }> {
  const nonce = randomBytes(16).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ platform, brand: brandSlug, nonce })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(STATE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(getAuthSecret());
  return { token, nonce };
}

/** The claims of a valid, unexpired state token, otherwise null (never throws). */
export async function verifyState(token: string | null | undefined): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getAuthSecret(), { algorithms: ["HS256"], issuer: STATE_ISSUER });
    const { platform, brand, nonce } = payload as Record<string, unknown>;
    if (typeof platform !== "string" || typeof brand !== "string" || typeof nonce !== "string") return null;
    return { platform, brandSlug: brand, nonce };
  } catch {
    return null;
  }
}

/**
 * Public origin of the app. APP_URL (e.g. https://studio.example.com) wins; otherwise it is rebuilt from the forwarded
 * headers, with https for every host except localhost (the app is only served over HTTPS in production, and the proxy in
 * front of the Node process may report the http leg). A wrong guess cannot be abused: the platforms only accept redirect
 * URIs registered in their consoles.
 */
export function appOrigin(req: Request): string {
  const configured = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  return `${local ? "http" : "https"}://${host}`;
}

/** The redirect URI to register in the platform's developer console, and to send with every authorize and code-exchange call. */
export function redirectUri(req: Request, platform: string): string {
  return `${appOrigin(req)}/api/connect/${platform}/callback`;
}
