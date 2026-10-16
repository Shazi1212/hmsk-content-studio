/**
 * ElevenLabs text-to-speech adapter.
 *
 *  POST {ELEVENLABS_BASE_URL}/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128   → audio/mpeg bytes
 *  GET  {ELEVENLABS_BASE_URL}/v1/voices                                                  → voice list
 *
 * Env: ELEVENLABS_API_KEY (required), ELEVENLABS_VOICE_ID (default voice), ELEVENLABS_MODEL (default
 * eleven_multilingual_v2), ELEVENLABS_BASE_URL (optional, default https://api.elevenlabs.io).
 */
import {
  PROVIDER_DEFAULTS,
  PROVIDER_TIMEOUTS,
  ProviderNotConfiguredError,
  ProviderRequestError,
  env,
  envOr,
  expectOk,
  providerFetch,
  readJsonBody,
  requireEnv,
  trimBaseUrl,
} from "./config";

/** ElevenLabs multilingual models accept up to 5,000 characters per request (turbo/flash: 40,000). */
const MAX_TTS_CHARACTERS = 5000;
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type SynthesizeVoiceInput = { text: string; voiceId?: string; modelId?: string };
export type SynthesizeVoiceResult = {
  bytes: Uint8Array;
  mime: "audio/mpeg";
  provider: "elevenlabs";
  voiceId: string;
};

function elevenlabsBase(): string {
  return trimBaseUrl(envOr("ELEVENLABS_BASE_URL", PROVIDER_DEFAULTS.elevenlabsBaseUrl));
}

export async function synthesizeVoice(p: SynthesizeVoiceInput): Promise<SynthesizeVoiceResult> {
  const { ELEVENLABS_API_KEY: apiKey } = requireEnv("elevenlabs", ["ELEVENLABS_API_KEY"]);

  const voiceId = (p.voiceId ?? "").trim() || env("ELEVENLABS_VOICE_ID");
  if (!voiceId) {
    throw new ProviderNotConfiguredError(
      "elevenlabs",
      ["ELEVENLABS_VOICE_ID"],
      "Or pick a voice per request (GET /api/audio/voices lists the voices of your account).",
    );
  }
  if (!VOICE_ID_PATTERN.test(voiceId)) {
    throw new ProviderRequestError("elevenlabs", 400, `invalid voiceId "${voiceId}"`);
  }

  const text = (p.text ?? "").trim();
  if (!text) throw new ProviderRequestError("elevenlabs", 400, "text is empty: generate a script first");
  if (text.length > MAX_TTS_CHARACTERS) {
    throw new ProviderRequestError(
      "elevenlabs",
      400,
      `text has ${text.length} characters; the limit per request is ${MAX_TTS_CHARACTERS}. Shorten the voice-over text.`,
    );
  }

  const modelId = (p.modelId ?? "").trim() || envOr("ELEVENLABS_MODEL", PROVIDER_DEFAULTS.elevenlabsModel);
  const url = `${elevenlabsBase()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

  const res = await providerFetch(
    "elevenlabs",
    url,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: modelId }),
    },
    PROVIDER_TIMEOUTS.audio,
  );
  await expectOk("elevenlabs", res);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // A 2xx with JSON means the API answered with a message instead of audio (e.g. quota notice).
    const body = await res.text();
    throw new ProviderRequestError("elevenlabs", 502, `expected audio/mpeg but received JSON: ${body}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new ProviderRequestError("elevenlabs", 502, "empty audio response");

  return { bytes, mime: "audio/mpeg", provider: "elevenlabs", voiceId };
}

type ElevenLabsVoicesResponse = {
  voices?: { voice_id?: string; name?: string; category?: string; labels?: Record<string, string> }[];
};

/** Voices available to the configured ElevenLabs account. Throws ProviderNotConfiguredError without a key. */
export async function listVoices(): Promise<{ voiceId: string; name: string }[]> {
  const { ELEVENLABS_API_KEY: apiKey } = requireEnv("elevenlabs", ["ELEVENLABS_API_KEY"]);
  const res = await providerFetch(
    "elevenlabs",
    `${elevenlabsBase()}/v1/voices`,
    { method: "GET", headers: { "xi-api-key": apiKey, accept: "application/json" } },
    PROVIDER_TIMEOUTS.video, // list call: 60 s is plenty
  );
  await expectOk("elevenlabs", res);
  const data = await readJsonBody<ElevenLabsVoicesResponse>("elevenlabs", res);
  const voices = Array.isArray(data.voices) ? data.voices : [];
  return voices
    .filter((v) => typeof v.voice_id === "string" && v.voice_id.length > 0)
    .map((v) => {
      const language = v.labels?.language ? ` (${v.labels.language})` : "";
      return { voiceId: v.voice_id as string, name: `${v.name ?? v.voice_id}${language}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
