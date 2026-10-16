import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { AuthConfigError, authMode, clientIp, createSessionToken, lockedMessage, sessionCookieOptions, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ password: z.string().min(1).max(500) });

/**
 * Brute-force protection for the single shared password (the endpoint is public and a hit yields a 30-day cookie).
 * A per-IP failure counter lives in the LoginAttempt table so it works across concurrent processes and invocations:
 * FREE_FAILURES wrong passwords inside WINDOW_MS are tolerated, then the IP is locked for 1, 2, 4, 8 … minutes
 * (doubling per further failure, capped at MAX_LOCK_MS). A successful login clears the row. Failed attempts are
 * logged with the IP (never the password) so abuse is visible in the app logs. An edge rate-limit rule on
 * /api/login is a good second layer but is not required.
 */
const WINDOW_MS = 15 * 60 * 1000;
const FREE_FAILURES = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
const STALE_ROW_MS = 24 * 60 * 60 * 1000;

function secondsLeft(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

function lockedResponse(seconds: number): NextResponse {
  const minutes = Math.ceil(seconds / 60);
  return NextResponse.json(
    {
      error: `Too many failed attempts. Try again in ${minutes > 1 ? `${minutes} minutes` : `${seconds} seconds`}.`,
      code: "rate_limited",
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

async function currentLock(ip: string, now: Date): Promise<number> {
  const row = await prisma.loginAttempt.findUnique({ where: { ip } });
  if (row?.lockedUntil && row.lockedUntil > now) return secondsLeft(row.lockedUntil, now);
  return 0;
}

async function registerFailure(ip: string, now: Date): Promise<{ failures: number; lockSeconds: number }> {
  const existing = await prisma.loginAttempt.findUnique({ where: { ip } });
  const inWindow = !!existing && now.getTime() - existing.windowStart.getTime() < WINDOW_MS;
  const failures = inWindow ? existing.failures + 1 : 1;
  const over = failures - FREE_FAILURES; // 1 → 1 min, 2 → 2 min, 3 → 4 min …
  const lockMs = over > 0 ? Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (over - 1)) : 0;
  const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;
  await prisma.loginAttempt.upsert({
    where: { ip },
    create: { ip, failures, windowStart: now, lockedUntil },
    update: inWindow ? { failures, lockedUntil } : { failures, windowStart: now, lockedUntil },
  });
  return { failures, lockSeconds: lockMs > 0 ? Math.ceil(lockMs / 1000) : 0 };
}

async function clearFailures(ip: string, now: Date): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { OR: [{ ip }, { updatedAt: { lt: new Date(now.getTime() - STALE_ROW_MS) } }] },
  });
}

function isDatabaseError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {\"password\": \"…\"}" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Password is required." }, { status: 422 });
  }

  const mode = authMode();
  if (mode === "locked") {
    const locked = lockedMessage();
    return NextResponse.json({ error: locked.error, hint: locked.hint, code: "auth_locked" }, { status: 503 });
  }

  const ip = clientIp(req);
  const now = new Date();

  if (mode === "password") {
    try {
      const lockSeconds = await currentLock(ip, now);
      if (lockSeconds > 0) {
        console.warn(`[api/login] blocked attempt from ${ip} (locked for ${lockSeconds}s)`);
        return lockedResponse(lockSeconds);
      }
      const ok = await verifyPassword(parsed.data.password);
      if (!ok) {
        const { failures, lockSeconds: newLock } = await registerFailure(ip, now);
        console.warn(`[api/login] failed attempt from ${ip} (${failures} in window${newLock ? `, locked for ${newLock}s` : ""})`);
        if (newLock > 0) return lockedResponse(newLock);
        // Small fixed delay on top of the counter so tight loops stay slow even below the lock threshold.
        await new Promise((r) => setTimeout(r, 400));
        return NextResponse.json({ error: "Wrong password." }, { status: 401 });
      }
      await clearFailures(ip, now);
    } catch (err) {
      if (isDatabaseError(err)) {
        // Fail closed: without the counter a brute-force attempt would run unthrottled, and the rest of the app
        // needs the database anyway.
        console.error(`[api/login] rate-limit store unavailable (${err instanceof Error ? err.message.split("\n")[0] : "unknown error"})`);
        return NextResponse.json(
          { error: "Login is temporarily unavailable because the database cannot be reached.", hint: "Check DATABASE_URL and that Postgres is running, then try again." },
          { status: 503 },
        );
      }
      throw err;
    }
  }

  try {
    const token = await createSessionToken();
    const res = NextResponse.json({ ok: true, mode });
    res.cookies.set({ ...sessionCookieOptions(), value: token });
    return res;
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json({ error: err.message, hint: err.hint }, { status: 503 });
    }
    console.error("[api/login]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not create a session." }, { status: 500 });
  }
}
