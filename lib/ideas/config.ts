/**
 * Ideas tab: connection to an OpenAI-compatible model server (LM Studio, Ollama, vLLM, Open WebUI, OpenRouter ...).
 * Everything is read from process.env at call time, so a changed environment value applies without a rebuild.
 *
 *   IDEAS_LLM_BASE_URL            e.g. http://localhost:1234/v1   ("/chat/completions" and "/models" are appended)
 *   IDEAS_LLM_API_KEY             optional Bearer key
 *   IDEAS_LLM_MODEL               default model id, e.g. gpt-oss:20b
 *   IDEAS_LLM_MODELS              optional comma list offered in the dropdown (IDEAS_LLM_MODEL is always included)
 *   IDEAS_LLM_CF_CLIENT_ID/_SECRET  optional Cloudflare Access service token (sent as CF-Access-Client-* headers)
 *   IDEAS_LLM_TIMEOUT_S           time budget of one model call (default 420; small local models can be slow)
 *   IDEAS_WEEKLY                  "on" enables the Monday idea bank (off by default)
 *
 * When IDEAS_LLM_BASE_URL is empty the LOCAL_LLM_* settings of the `local` text provider are used instead.
 */
import { ProviderNotConfiguredError, env, ideasEnv, ideasModels, trimBaseUrl } from "@/lib/providers/config";

export const IDEAS_PROVIDER = "ideas";

export type IdeasLlmConfig = {
  baseUrl: string;
  /** Request headers for the model server: Bearer key and the optional Cloudflare Access service token. */
  headers: Record<string, string>;
  /** The configured default model id; undefined lets the server choose. */
  model: string | undefined;
  models: string[];
  timeoutMs: number;
};

export function ideasConfigured(): boolean {
  return Boolean(ideasEnv("BASE_URL"));
}

/** Cloudflare's Browser Integrity Check answers 403 to clients without a believable User-Agent ("Python-urllib" is one), which looks exactly like a broken tunnel. */
const USER_AGENT = "ContentStudio/1.0";

export function ideasWeeklyEnabled(): boolean {
  const flag = (env("IDEAS_WEEKLY") ?? "").toLowerCase();
  return ["on", "1", "true", "yes"].includes(flag);
}

/** Headers shared by the chat call and the connection probe. */
export function ideasHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  const key = ideasEnv("API_KEY");
  if (key) headers.authorization = `Bearer ${key}`;
  const cfId = ideasEnv("CF_CLIENT_ID");
  const cfSecret = ideasEnv("CF_CLIENT_SECRET");
  if (cfId && cfSecret) {
    headers["cf-access-client-id"] = cfId;
    headers["cf-access-client-secret"] = cfSecret;
  }
  return headers;
}

/** Throws ProviderNotConfiguredError (naming IDEAS_LLM_BASE_URL) when the Ideas model is not set up. */
export function ideasLlmConfig(): IdeasLlmConfig {
  const base = ideasEnv("BASE_URL");
  if (!base) {
    throw new ProviderNotConfiguredError(
      IDEAS_PROVIDER,
      ["IDEAS_LLM_BASE_URL"],
      "It is the address of any OpenAI-compatible server, for example http://localhost:1234/v1 (LM Studio). LOCAL_LLM_BASE_URL is used when IDEAS_LLM_BASE_URL is empty",
    );
  }
  const models = ideasModels();
  const seconds = Number.parseInt(ideasEnv("TIMEOUT_S") ?? "", 10);
  return {
    baseUrl: trimBaseUrl(base),
    headers: ideasHeaders(),
    model: models[0],
    models,
    timeoutMs: (Number.isFinite(seconds) && seconds >= 30 ? Math.min(seconds, 900) : 420) * 1000,
  };
}
