import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ ...sessionCookieOptions(), value: "", maxAge: 0 });
  return res;
}
