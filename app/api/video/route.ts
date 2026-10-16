import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createVideoJob } from "@/lib/providers";
import { requireSession } from "@/lib/auth";
import { errorResponse, zodIssues } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required").max(2500, "the video model accepts at most 2,500 characters"),
  imageUrl: z.url({ protocol: /^https$/, error: "imageUrl must be a public https URL" }).max(4000).optional(),
  durationSeconds: z.number().int().min(3, "duration is 3 to 15 seconds").max(15, "duration is 3 to 15 seconds").optional(),
  aspectRatio: z.enum(["9:16", "1:1", "16:9"]).optional(),
});

/** POST {prompt, imageUrl?, durationSeconds?, aspectRatio?} → {jobId, provider}. Poll GET /api/video/[jobId]. */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {prompt, imageUrl?, durationSeconds?, aspectRatio?}." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }

  try {
    const job = await createVideoJob(parsed.data);
    return NextResponse.json({ jobId: job.jobId, provider: job.provider, status: "queued" }, { status: 202 });
  } catch (err) {
    return errorResponse(err, "api/video");
  }
}
