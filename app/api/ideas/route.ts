import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { errorResponse, zodIssues } from "@/lib/pipeline";
import { IdeasParamsSchema } from "@/lib/ideas/types";
import { ideasConfigured } from "@/lib/ideas/config";
import { runIdeas, toBatchDTO } from "@/lib/ideas/run";
import { kickScheduler } from "@/lib/scheduler";
import { keepAliveJson } from "@/lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A local model can take minutes (two attempts at up to IDEAS_LLM_TIMEOUT_S each); the keep-alive stream keeps the host's
// proxy from cutting the request, and maxDuration covers hosts that enforce a function limit.
export const maxDuration = 600;

/** POST {brandSlug, platform, pillar?, goal?, language?, count?, direction?, model?} → one batch of ideas (streamed keep-alive + JSON). */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = IdeasParamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }
  if (!ideasConfigured()) {
    return NextResponse.json(
      {
        error: "The Ideas model is not connected yet.",
        hint: "Set IDEAS_LLM_BASE_URL, IDEAS_LLM_API_KEY and IDEAS_LLM_MODEL in the app's environment variables (see the README, Ideas tab).",
        code: "provider_not_configured",
      },
      { status: 503 },
    );
  }
  return keepAliveJson(() => runIdeas(parsed.data, { source: "manual" }), "api/ideas");
}

/** GET ?brandSlug=&source=&limit= → recent batches, newest first (the tab's history and the weekly idea bank). */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  void kickScheduler();

  const q = req.nextUrl.searchParams;
  const brandSlug = q.get("brandSlug")?.trim() || undefined;
  const source = q.get("source") === "weekly" ? "weekly" : q.get("source") === "manual" ? "manual" : undefined;
  const limit = Math.max(1, Math.min(60, Number.parseInt(q.get("limit") ?? "", 10) || 30));
  try {
    const rows = await prisma.ideaBatch.findMany({
      where: { ...(brandSlug ? { brand: { slug: brandSlug } } : {}), ...(source ? { source } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { brand: { select: { slug: true, name: true } } },
    });
    return NextResponse.json({ batches: rows.map((r) => toBatchDTO(r, r.brand)) });
  } catch (err) {
    return errorResponse(err, "api/ideas GET");
  }
}
