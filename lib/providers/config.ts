/**
 * Provider configuration, status, shared error classes and a small HTTP helper.
 *
 * Every adapter in lib/providers/* reads its configuration from process.env at call time (never at import
 * time, so a changed environment applies without a rebuild), reaches the vendor over HTTPS with `fetch`, and
 * reports problems with the two error classes below. Secrets never appear in thrown messages: callers may
 * show `error.message` to the user verbatim.
 */
import type { TextProviderId } from "@/lib/types";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------

export type ImageProviderId = "openai" | "gemini";

export type ProviderStatus = {
  text: Record<TextProviderId, { configured: boolean; model?: string; note?: string }>;
  audio: { elevenlabs: { configured: boolean; voiceId?: string } };
  video: { higgsfield: { configured: boolean } };
  /** Key visual model: OpenAI gpt-image by default (Gemini image models need a billing-enabled key), see pickImageProvider(). */
  image: { configured: boolean; provider?: ImageProviderId; model?: string; note?: string };
  /** The Ideas tab's model (IDEAS_LLM_*, falling back to LOCAL_LLM_*): any OpenAI-compatible server. */
  ideas: { configured: boolean; model?: string; models: string[]; note?: string };
  /** Public hosting of generated media by the app itself (lib/media.ts, database-backed). */
  storage: { media: { configured: boolean } };
};

/** Human labels used in error messages and the status panel. */
export const PROVIDER_LABELS: Record<string, string> = {
  local: "Local / OpenAI-compatible LLM",
  openai: "OpenAI",
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
  mock: "Mock strategist",
  ideas: "Ideas model",
  elevenlabs: "ElevenLabs",
  higgsfield: "Higgsfield",
  "gemini-image": "Gemini image model",
  "openai-image": "OpenAI image model",
};

/** Defaults that apply when the corresponding env var is empty. Keep in sync with .env.example. */
export const PROVIDER_DEFAULTS = {
  openaiModel: "gpt-6-luna",
  geminiModel: "gemini-2.5-pro",
  anthropicModel: "claude-haiku-4-5",
  geminiImageModel: "gemini-2.5-flash-image",
  openaiImageModel: "gpt-image-2",
  elevenlabsModel: "eleven_multilingual_v2",
  elevenlabsBaseUrl: "https://api.elevenlabs.io",
  higgsfieldBaseUrl: "https://api.higgsfield.ai",
  openaiBaseUrl: "https://api.openai.com/v1",
  anthropicBaseUrl: "https://api.anthropic.com",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
} as const;

/** Request timeouts in milliseconds (AbortController). */
export const PROVIDER_TIMEOUTS = {
  text: 120_000,
  audio: 120_000,
  video: 60_000,
  image: 120_000,
} as const;

// ---------------------------------------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------------------------------------

/** Trimmed env value, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value === "" ? undefined : value;
}

/** Env value with a fallback. */
export function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

/**
 * The mock strategist (deterministic, offline, free) is available by default so the app can be tried without any API key.
 * MOCK_LLM=0 switches it off explicitly (for example once real providers are configured).
 */
export function isMockEnabled(): boolean {
  const flag = env("MOCK_LLM");
  if (flag !== undefined) return ["1", "true", "yes", "on"].includes(flag.toLowerCase());
  return true;
}

/** Base URL with any trailing slashes removed. */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------------

export function providerStatus(): ProviderStatus {
  const localBase = env("LOCAL_LLM_BASE_URL");
  const localModel = env("LOCAL_LLM_MODEL");
  const mockOn = isMockEnabled();

  return {
    text: {
      local: {
        configured: Boolean(localBase),
        model: localModel,
        note: !localBase
          ? "Set LOCAL_LLM_BASE_URL (OpenAI-compatible /v1 endpoint) and LOCAL_LLM_MODEL"
          : !localModel
            ? "LOCAL_LLM_MODEL is empty: the server's default/loaded model will be used (Ollama and OpenRouter require a model name)"
            : undefined,
      },
      openai: {
        configured: Boolean(env("OPENAI_API_KEY")),
        model: envOr("OPENAI_MODEL", PROVIDER_DEFAULTS.openaiModel),
        note: env("OPENAI_API_KEY") ? undefined : "Set OPENAI_API_KEY",
      },
      gemini: {
        configured: Boolean(env("GEMINI_API_KEY")),
        model: envOr("GEMINI_MODEL", PROVIDER_DEFAULTS.geminiModel),
        note: env("GEMINI_API_KEY") ? undefined : "Set GEMINI_API_KEY",
      },
      anthropic: {
        configured: Boolean(env("ANTHROPIC_API_KEY")),
        model: envOr("ANTHROPIC_MODEL", PROVIDER_DEFAULTS.anthropicModel),
        note: env("ANTHROPIC_API_KEY") ? undefined : "Set ANTHROPIC_API_KEY",
      },
      mock: {
        configured: mockOn,
        model: "mock-strategist-v1",
        note: mockOn
          ? "Deterministic offline output for testing the pipeline (no API call)"
          : "Disabled by MOCK_LLM=0",
      },
    },
    audio: {
      elevenlabs: {
        configured: Boolean(env("ELEVENLABS_API_KEY")),
        voiceId: env("ELEVENLABS_VOICE_ID"),
      },
    },
    video: {
      higgsfield: {
        configured: Boolean(env("HIGGSFIELD_API_KEY") && env("HIGGSFIELD_API_SECRET")),
      },
    },
    image: imageProviderStatus(),
    ideas: ideasProviderStatus(),
    storage: {
      media: { configured: Boolean(env("DATABASE_URL")) },
    },
  };
}

/**
 * Which key-visual provider is used. IMAGE_PROVIDER=openai|gemini forces one (null when its key is missing); otherwise OpenAI
 * when OPENAI_API_KEY is set, else Gemini. OpenAI comes first because Gemini's image models answer 429 "limit: 0" on a key
 * without billing, while the OpenAI key that already serves the text models just works.
 */
export function pickImageProvider(): ImageProviderId | null {
  const forced = (env("IMAGE_PROVIDER") ?? "").toLowerCase();
  const openai = Boolean(env("OPENAI_API_KEY"));
  const gemini = Boolean(env("GEMINI_API_KEY"));
  if (forced === "gemini") return gemini ? "gemini" : null;
  if (forced === "openai") return openai ? "openai" : null;
  return openai ? "openai" : gemini ? "gemini" : null;
}

function imageProviderStatus(): ProviderStatus["image"] {
  const provider = pickImageProvider();
  if (!provider) {
    const forced = (env("IMAGE_PROVIDER") ?? "").toLowerCase();
    return { configured: false, note: forced === "gemini" ? "Set GEMINI_API_KEY" : forced === "openai" ? "Set OPENAI_API_KEY" : "Set OPENAI_API_KEY (or GEMINI_API_KEY)" };
  }
  return {
    configured: true,
    provider,
    model: provider === "openai" ? envOr("OPENAI_IMAGE_MODEL", PROVIDER_DEFAULTS.openaiImageModel) : envOr("GEMINI_IMAGE_MODEL", PROVIDER_DEFAULTS.geminiImageModel),
  };
}

/**
 * Ideas connection settings: IDEAS_LLM_*. When IDEAS_LLM_BASE_URL is empty, the Ideas tab reuses the `local` text provider's
 * LOCAL_LLM_BASE_URL / LOCAL_LLM_API_KEY / LOCAL_LLM_MODEL, so one OpenAI-compatible server can serve both tabs.
 */
export function ideasEnv(name: "BASE_URL" | "API_KEY" | "MODEL" | "MODELS" | "TIMEOUT_S" | "CF_CLIENT_ID" | "CF_CLIENT_SECRET"): string | undefined {
  const own = env(`IDEAS_LLM_${name}`);
  if (own !== undefined) return own;
  if (env("IDEAS_LLM_BASE_URL") === undefined && (name === "BASE_URL" || name === "API_KEY" || name === "MODEL")) return env(`LOCAL_LLM_${name}`);
  return undefined;
}

/** Models offered by the Ideas tab: IDEAS_LLM_MODELS (comma separated), always including IDEAS_LLM_MODEL, which comes first. */
export function ideasModels(): string[] {
  const def = ideasEnv("MODEL");
  const list = (ideasEnv("MODELS") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([...(def ? [def] : []), ...list])];
}

function ideasProviderStatus(): ProviderStatus["ideas"] {
  const base = ideasEnv("BASE_URL");
  const models = ideasModels();
  return {
    configured: Boolean(base),
    model: models[0],
    models,
    note: !base
      ? "Set IDEAS_LLM_BASE_URL (or LOCAL_LLM_BASE_URL): any OpenAI-compatible server"
      : models.length === 0
        ? "IDEAS_LLM_MODEL is empty: the server's default model will be used"
        : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------

/** Thrown when a provider is selected but its key / URL is missing. The message names the env var(s). */
export class ProviderNotConfiguredError extends Error {
  readonly provider: string;
  readonly envVars: string[];

  constructor(provider: string, envVars: string[], hint?: string) {
    const label = PROVIDER_LABELS[provider] ?? provider;
    const vars = envVars.join(" and ");
    super(
      `${label} is not configured. Set ${vars} in the app's environment variables (.env file or the container environment)` +
        (hint ? `. ${hint}` : "."),
    );
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
    this.envVars = envVars;
  }
}

/**
 * Thrown for HTTP errors (status >= 400), timeouts / network failures (status 0) and malformed responses
 * (status 502). `body` is a short, secret-redacted excerpt of what the vendor returned.
 */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;

  constructor(provider: string, status: number, body: string) {
    const label = PROVIDER_LABELS[provider] ?? provider;
    const excerpt = redactSecrets(shortText(body, 600));
    super(status > 0 ? `${label} request failed (HTTP ${status}): ${excerpt}` : `${label} request failed: ${excerpt}`);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.status = status;
    this.body = excerpt;
  }
}

export function isProviderError(err: unknown): err is ProviderNotConfiguredError | ProviderRequestError {
  return err instanceof ProviderNotConfiguredError || err instanceof ProviderRequestError;
}

/** Ensures the listed env vars are set; returns their values. Throws ProviderNotConfiguredError otherwise. */
export function requireEnv(provider: string, names: string[], hint?: string): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const v = env(name);
    if (v === undefined) missing.push(name);
    else values[name] = v;
  }
  if (missing.length > 0) throw new ProviderNotConfiguredError(provider, missing, hint);
  return values;
}

// ---------------------------------------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------------------------------------

const SECRET_ENV_NAMES = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "LOCAL_LLM_API_KEY",
  "IDEAS_LLM_API_KEY",
  "IDEAS_LLM_CF_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "ELEVENLABS_API_KEY",
  "HIGGSFIELD_API_KEY",
  "HIGGSFIELD_API_SECRET",
  "APP_PASSWORD",
  "AUTH_SECRET",
  "DATABASE_URL",
  "DIRECT_URL",
];

/** Replaces any configured secret value (and `?key=` query params) found in `text` with "[redacted]". */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env(name);
    if (value && value.length >= 6) out = out.split(value).join("[redacted]");
  }
  out = out.replace(/([?&](?:key|api_key|apikey|token|secret)=)[^&\s"']+/gi, "$1[redacted]");
  out = out.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, "$1…[redacted]");
  return out;
}

/** Collapses whitespace and truncates to `max` characters. */
export function shortText(text: string, max = 600): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${clip(collapsed, max)}…` : collapsed;
}

// ---------------------------------------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------------------------------------

/**
 * `fetch` with an AbortController timeout. Network errors and timeouts become ProviderRequestError(status 0).
 * HTTP error statuses are NOT thrown here; call `expectOk` to convert them.
 */
export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const seconds = timeoutMs >= 1000 ? String(Math.round(timeoutMs / 1000)) : (timeoutMs / 1000).toFixed(1);
      throw new ProviderRequestError(provider, 0, `timed out after ${seconds} s`);
    }
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new ProviderRequestError(provider, 0, `network error: ${cause}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a short, redacted excerpt of an error body (JSON `error.message`/`message`/`detail` when present). */
export async function readErrorBody(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    return res.statusText || "no response body";
  }
  const trimmed = raw.trim();
  if (!trimmed) return res.statusText || "empty response body";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const msg = extractMessage(parsed);
    if (msg) return msg;
  } catch {
    // not JSON — fall through
  }
  return trimmed;
}

function extractMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error_message", "msg"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  for (const key of ["error", "detail", "errors"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length > 0) return extractMessage(v[0], depth + 1);
    const nested = extractMessage(v, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** Throws ProviderRequestError when the response is not 2xx. Returns the response otherwise. */
export async function expectOk(provider: string, res: Response): Promise<Response> {
  if (res.ok) return res;
  throw new ProviderRequestError(provider, res.status, await readErrorBody(res));
}

/** Parses a JSON body; throws ProviderRequestError(502) when it is not valid JSON. */
export async function readJsonBody<T = unknown>(provider: string, res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderRequestError(provider, 502, `non-JSON response: ${text || "(empty)"}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Gemini helpers shared by text.ts and image.ts
// ---------------------------------------------------------------------------------------------------------

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
};

export type GeminiGenerateContentResponse = {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
    finishMessage?: string;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
};

/** `…/v1beta/models/{model}:generateContent`. The key is sent as the `x-goog-api-key` header, never in the URL. */
export function geminiGenerateContentUrl(model: string): string {
  const base = trimBaseUrl(envOr("GEMINI_BASE_URL", PROVIDER_DEFAULTS.geminiBaseUrl));
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": apiKey };
}
