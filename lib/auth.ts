/**
 * Session auth (single shared password).
 *
 * One shared password (APP_PASSWORD) → HS256 JWT (jose) in the httpOnly cookie `cs_session`, valid 30 days.
 * Runtime-agnostic (Web Crypto only) so the same module works in proxy.ts and in Node route handlers.
 *
 * Modes (see authMode()):
 *   "password" – APP_PASSWORD is set and at least APP_PASSWORD_MIN_LENGTH characters long: login required.
 *   "open"     – APP_PASSWORD unset in development: everything is accessible (local testing).
 *   "locked"   – APP_PASSWORD unset in production, or set but shorter than APP_PASSWORD_MIN_LENGTH (any
 *                environment): nobody can log in until the env var is fixed. lockedMessage() names the rule.
 *
 * Brute-force protection for the single password lives in app/api/login/route.ts (per-IP failure counter in the
 * LoginAttempt table with exponential lockout; works across serverless invocations).
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "cs_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
/** A short shared password is refused outright: the login endpoint is public and a hit yields a 30-day session. */
export const APP_PASSWORD_MIN_LENGTH = 16;
const JWT_SUBJECT = "cs-user";
const JWT_ISSUER = "content-studio";

export type AuthMode = "password" | "open" | "locked";
export type Session = { sub: string; iat: number; exp: number };

export class AuthConfigError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "AuthConfigError";
    this.hint = hint;
  }
}

export const ENV_HINT = (vars: string) =>
  `Set ${vars} in the app's environment variables (.env file or the container environment)`;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function configuredPassword(): string {
  return (process.env.APP_PASSWORD ?? "").trim();
}

export function authMode(): AuthMode {
  const pw = configuredPassword();
  if (pw.length >= APP_PASSWORD_MIN_LENGTH) return "password";
  // A password that is set but too short is refused everywhere so the rule is noticed before it reaches prod.
  if (pw.length > 0) return "locked";
  return isProduction() ? "locked" : "open";
}

export type LockedMessage = { error: string; hint: string; code: "unset" | "short" };

/** Error + hint shown when authMode() is "locked". Names the exact rule so the fix is obvious. */
export function lockedMessage(): LockedMessage {
  const pw = configuredPassword();
  if (pw.length > 0 && pw.length < APP_PASSWORD_MIN_LENGTH) {
    return {
      code: "short",
      error: `Access is locked: APP_PASSWORD is shorter than ${APP_PASSWORD_MIN_LENGTH} characters.`,
      hint: `Use a passphrase of at least ${APP_PASSWORD_MIN_LENGTH} characters. ${ENV_HINT("APP_PASSWORD and AUTH_SECRET")}, then redeploy.`,
    };
  }
  return {
    code: "unset",
    error: "Access is locked: APP_PASSWORD is not configured.",
    hint: `${ENV_HINT(`APP_PASSWORD (at least ${APP_PASSWORD_MIN_LENGTH} characters) and AUTH_SECRET`)}, then redeploy.`,
  };
}

let warnedFallbackSecret = false;

/** Signing key for the session JWT. Throws AuthConfigError in production when AUTH_SECRET is missing. */
export function getAuthSecret(): Uint8Array {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (secret.length >= 16) return new TextEncoder().encode(secret);
  if (isProduction()) {
    throw new AuthConfigError(
      "AUTH_SECRET is missing or shorter than 16 characters; sessions cannot be signed.",
      ENV_HINT("AUTH_SECRET (random string, 32+ characters)"),
    );
  }
  if (!warnedFallbackSecret) {
    warnedFallbackSecret = true;
    console.warn("[auth] AUTH_SECRET is not set; using an insecure development-only fallback secret.");
  }
  return new TextEncoder().encode("content-studio-development-only-secret-do-not-use-in-production");
}

export async function createSessionToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(JWT_SUBJECT)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_MAX_AGE_SECONDS)
    .sign(getAuthSecret());
}

/** Returns the session claims when the token is valid and unexpired, otherwise null (never throws). */
export async function verifySessionToken(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getAuthSecret(), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      subject: JWT_SUBJECT,
    });
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return { sub: String(payload.sub), iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}

/** Constant-time password check (compares SHA-256 digests so input length does not leak through timing). */
export async function verifyPassword(candidate: string): Promise<boolean> {
  const expected = configuredPassword();
  if (expected.length < APP_PASSWORD_MIN_LENGTH) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const A = new Uint8Array(a);
  const B = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/** Reads the session cookie from any Request (works for NextRequest and plain fetch Requests). */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === SESSION_COOKIE) {
      const value = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

/** Loopback, link-local, unique-local and private-range addresses: internal proxy hops, never a real client. */
function isInternalIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (v === "::1" || v === "localhost") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v)) return true;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Client IP for logging and rate limiting (never a secret; safe to log).
 *
 * `x-forwarded-for` is a list to which every proxy appends the address it received the request from, so entries on the
 * LEFT can be forged by the client while the entry the hosting layer appended sits on the RIGHT. Reading from the right
 * and skipping internal hops returns the address the first trusted proxy saw, so a forged header cannot dodge the
 * login lockout. Platforms that overwrite the header (Vercel) send a single entry, returned unchanged. Behind
 * Cloudflare's orange-cloud proxy the rightmost public entry is a Cloudflare edge address (visitors would share a
 * lockout), so keep the app hostname DNS-only.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isInternalIp(hops[i])) return hops[i].slice(0, 64);
    }
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "unknown";
}

export async function getSession(req: Request): Promise<Session | null> {
  return verifySessionToken(readSessionCookie(req));
}

/**
 * Defense in depth for route handlers (proxy.ts already gates /api/*).
 * Returns a 401 JSON Response when the caller is not authenticated, otherwise null.
 */
export async function requireSession(req: Request): Promise<Response | null> {
  const mode = authMode();
  if (mode === "open") return null;
  if (mode === "locked") {
    const locked = lockedMessage();
    return Response.json({ error: locked.error, hint: locked.hint, code: "auth_locked" }, { status: 401 });
  }
  const session = await getSession(req);
  if (session) return null;
  return Response.json({ error: "Unauthorized. Log in at /login." }, { status: 401 });
}
