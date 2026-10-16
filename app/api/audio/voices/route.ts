import { NextResponse, type NextRequest } from "next/server";
import { ProviderNotConfiguredError, listVoices, providerStatus } from "@/lib/providers";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → ElevenLabs voices, or [] when ELEVENLABS_API_KEY is not configured. */
export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    if (!providerStatus().audio.elevenlabs.configured) return NextResponse.json([]);
    const voices = await listVoices();
    return NextResponse.json(voices);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) return NextResponse.json([]);
    return errorResponse(err, "api/audio/voices");
  }
}
