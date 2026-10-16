import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { zodIssues } from "@/lib/pipeline";
import { syncAll } from "@/lib/sync";
import { keepAliveJson } from "@/lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({ connectionId: z.string().min(1).optional() }).default({});

/** POST {connectionId?} → syncs one connected account (or all that can work) now; keep-alive streaming like /api/generate. */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });

  return keepAliveJson(async () => ({ reports: await syncAll({ connectionId: parsed.data.connectionId }) }), "api/sync");
}
