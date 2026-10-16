import { NextResponse, type NextRequest } from "next/server";
import { getVideoJob } from "@/lib/providers";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ jobId: string }> };

/** GET → {status: queued|processing|completed|failed, url?, error?} */
export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { jobId } = await params;
  const id = decodeURIComponent(jobId ?? "").trim();
  if (!id || id.length > 200) return NextResponse.json({ error: "jobId is required." }, { status: 422 });
  try {
    const job = await getVideoJob(id);
    return NextResponse.json({ jobId: id, ...job }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "api/video/[jobId]");
  }
}
