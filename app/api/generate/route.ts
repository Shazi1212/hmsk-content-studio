import { NextResponse, type NextRequest } from "next/server";
import { BriefSchema } from "@/lib/types";
import { requireSession } from "@/lib/auth";
import { runGeneration, zodIssues } from "@/lib/pipeline";
import { keepAliveJson } from "@/lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Text providers may take a while (up to 2 × 120 s on retry); allow the maximum function duration where the host
// honours it (Vercel). Other hosts ignore this and apply their own request timeout.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be a JSON brief." }, { status: 400 });
  }
  const parsed = BriefSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid brief.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }
  const brief = parsed.data;
  if (brief.postType === "blog_to_social" && brief.sourceText.trim().length < 40) {
    return NextResponse.json(
      { error: "Post type 'Repurpose article / URL' needs the source text (paste the article, at least a few sentences).", code: "validation" },
      { status: 422 },
    );
  }

  return keepAliveJson(async () => {
    const result = await runGeneration(brief);
    return {
      draft: result.draft,
      usage: result.usage,
      durationMs: result.durationMs,
      references: result.references.map((r) => ({
        id: r.id,
        platform: r.platform,
        hook: r.hook,
        performanceLevel: r.performanceLevel,
        postUrl: r.postUrl,
        pillar: r.pillar,
        format: r.format,
        date: r.date,
      })),
      priorApproved: result.priorApproved.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        approvedAt: g.approvedAt,
        platform: g.platform,
        postType: g.postType,
        hook: firstHook(g.output, g.outputText),
      })),
      repetition: result.repetition,
      retrievalNotes: result.retrievalNotes,
      lint: result.lint,
      repaired: result.repaired,
      warnings: result.warnings,
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
    };
  }, "api/generate");
}

function firstHook(output: unknown, outputText: string): string {
  const o = output as { variants?: { hook?: unknown }[] } | null;
  const hook = o?.variants?.[0]?.hook;
  if (typeof hook === "string" && hook.trim()) return hook.trim();
  return outputText.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";
}
