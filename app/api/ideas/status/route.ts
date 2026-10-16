import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { ideasConfigured, ideasWeeklyEnabled } from "@/lib/ideas/config";
import { probeIdeasLlm } from "@/lib/ideas/llm";
import { ideasModels } from "@/lib/providers/config";
import type { IdeasStatus } from "@/lib/ideas/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → whether the Ideas model is configured and which models the tab offers; ?probe=1 also asks the model server. */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const models = ideasModels();
  const status: IdeasStatus = {
    configured: ideasConfigured(),
    model: models[0],
    models,
    weekly: ideasConfigured() && ideasWeeklyEnabled(),
    note: ideasConfigured() ? undefined : "Set IDEAS_LLM_BASE_URL, IDEAS_LLM_API_KEY and IDEAS_LLM_MODEL (see the README, Ideas tab).",
  };
  if (req.nextUrl.searchParams.get("probe") === "1") status.probe = await probeIdeasLlm();
  return NextResponse.json(status);
}
