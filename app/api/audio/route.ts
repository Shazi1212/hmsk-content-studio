import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { synthesizeVoice } from "@/lib/providers";
import { hostMedia } from "@/lib/media";
import { requireSession } from "@/lib/auth";
import { errorResponse, zodIssues } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  text: z.string().trim().min(1, "text is required").max(5000, "text must be at most 5000 characters"),
  voiceId: z.string().trim().max(100).optional(),
  modelId: z.string().trim().max(100).optional(),
});

/** Copies provider bytes into a fresh ArrayBuffer so the Response body type is exact. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * POST {text, voiceId?} → audio/mpeg bytes (attachment) or 502 JSON.
 * The MP3 is also hosted by the app itself (lib/media.ts) and its public URL is returned in the X-Asset-Url header
 * (stored as Generation.audioUrl on approve).
 */
export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: {text, voiceId?}." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request.", issues: zodIssues(parsed.error), code: "validation" }, { status: 422 });
  }
  const { text, voiceId, modelId } = parsed.data;

  try {
    const audio = await synthesizeVoice({ text, voiceId: voiceId || undefined, modelId: modelId || undefined });
    const filename = `voiceover-${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
    const assetUrl = await hostMedia("api/audio", req, { kind: "audio", mime: audio.mime, bytes: audio.bytes });
    return new Response(toArrayBuffer(audio.bytes), {
      status: 200,
      headers: {
        "Content-Type": audio.mime,
        "Content-Length": String(audio.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Voice-Id": audio.voiceId,
        "X-Provider": audio.provider,
        ...(assetUrl ? { "X-Asset-Url": assetUrl } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err, "api/audio");
  }
}
