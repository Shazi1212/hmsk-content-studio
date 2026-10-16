/**
 * Text / script generation adapters. One entry point: `generateText(req)`.
 *
 *  - local      OpenAI-compatible chat completions (LM Studio, Ollama, vLLM, OpenRouter …)
 *  - openai     https://api.openai.com/v1/chat/completions
 *  - gemini     Google Generative Language API generateContent
 *  - anthropic  https://api.anthropic.com/v1/messages
 *  - mock       deterministic, schema-valid GenerationOutput built from hints in the prompt (no network)
 *
 * All adapters use `fetch` with an AbortController timeout (120 s) and throw ProviderNotConfiguredError /
 * ProviderRequestError from ./config. Secrets never appear in error messages.
 */
import {
  GenerationOutputSchema,
  HOOK_TYPES,
  PLATFORMS,
  POST_TYPES,
  type GenerationOutput,
  type TextProviderId,
  type Variant,
} from "@/lib/types";
import { joinSystemPrompt, type SystemPromptParts } from "@/lib/prompt/system";
import {
  PROVIDER_DEFAULTS,
  PROVIDER_TIMEOUTS,
  ProviderNotConfiguredError,
  ProviderRequestError,
  env,
  envOr,
  expectOk,
  geminiGenerateContentUrl,
  geminiHeaders,
  isMockEnabled,
  providerFetch,
  readJsonBody,
  requireEnv,
  shortText,
  trimBaseUrl,
  type GeminiGenerateContentResponse,
} from "./config";

// ---------------------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------------------

export type TextRequest = {
  provider: TextProviderId;
  /**
   * A plain string, or the stable/variable split from buildSystemPrompt. Anthropic sends the split as two system
   * blocks with a cache breakpoint on the stable one; every other provider receives the joined string, whose
   * stable-first order lets their automatic prefix caching apply.
   */
  system: string | SystemPromptParts;
  user: string;
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export type TextResponse = {
  text: string;
  model: string;
  provider: TextProviderId;
  usage?: TextUsage;
  /** Vendor stop reason as reported (finish_reason / finishReason / stop_reason). */
  finishReason?: string;
  /** True when the reply was cut at the max token limit; the pipeline retries and warns instead of trusting it. */
  truncated?: boolean;
};

/**
 * Token counts as reported by the vendor. `input` is every prompt token of the request, including tokens read from
 * or written to a prompt cache; `cacheRead` is the part of `input` served from the cache (Anthropic
 * cache_read_input_tokens, OpenAI cached_tokens, Gemini cachedContentTokenCount); `cacheWrite` is the part written
 * to the cache (Anthropic cache_creation_input_tokens only).
 */
export type TextUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** The system prompt as one string (providers without system blocks). */
function systemText(system: TextRequest["system"]): string {
  return typeof system === "string" ? system : joinSystemPrompt(system);
}

export async function generateText(req: TextRequest): Promise<TextResponse> {
  if (!req.user || !req.user.trim()) {
    throw new ProviderRequestError(req.provider, 400, "user prompt is empty");
  }
  switch (req.provider) {
    case "local":
      return generateLocal(req);
    case "openai":
      return generateOpenAI(req);
    case "gemini":
      return generateGemini(req);
    case "anthropic":
      return generateAnthropic(req);
    case "mock":
      return generateMock(req);
    default: {
      const unknown: never = req.provider;
      throw new ProviderRequestError(String(unknown), 400, `unknown text provider "${String(unknown)}"`);
    }
  }
}

const DEFAULT_TEMPERATURE = 0.7;

/**
 * Output token budgets. Reasoning models count thinking tokens against the same cap (Gemini 2.5 maxOutputTokens,
 * OpenAI gpt-5+ max_completion_tokens), and a 3-variant reel with image/video prompts, VO text and altVersion runs
 * well past 8k tokens, so the defaults are generous and grow with the variant count. Local servers get a smaller
 * default because their loaded context is often 16-32k (override with LOCAL_LLM_MAX_TOKENS).
 */
const TOKEN_BUDGETS: Record<Exclude<TextProviderId, "mock">, { base: number; perExtraVariant: number; cap: number }> = {
  gemini: { base: 32_000, perExtraVariant: 8_000, cap: 64_000 },
  openai: { base: 16_000, perExtraVariant: 6_000, cap: 64_000 },
  anthropic: { base: 16_000, perExtraVariant: 6_000, cap: 64_000 },
  local: { base: 16_000, perExtraVariant: 4_000, cap: 24_000 },
};
const MOCK_MAX_TOKENS = 8_000;

/** Max output tokens for a run: base budget per provider, scaled by variants; `retry` adds 25 % within the cap. */
export function suggestedMaxTokens(provider: TextProviderId, variants = 1, opts: { retry?: boolean } = {}): number {
  if (provider === "mock") return MOCK_MAX_TOKENS;
  const b = TOKEN_BUDGETS[provider];
  const n = Math.max(1, Math.min(3, Math.round(variants) || 1));
  let cap = b.cap;
  let base = b.base;
  if (provider === "local") {
    const override = Number.parseInt(env("LOCAL_LLM_MAX_TOKENS") ?? "", 10);
    if (Number.isFinite(override) && override >= 1000) {
      base = override;
      cap = override;
    }
  }
  let tokens = base + b.perExtraVariant * (n - 1);
  if (opts.retry) tokens = Math.round(tokens * 1.25);
  return Math.min(cap, tokens);
}

function defaultMaxTokens(provider: TextProviderId): number {
  return suggestedMaxTokens(provider, 1);
}

// ---------------------------------------------------------------------------------------------------------
// OpenAI-compatible chat completions (local + openai)
// ---------------------------------------------------------------------------------------------------------

type OpenAIChatResponse = {
  model?: string;
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      refusal?: string | null;
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
};

function openAIUsage(data: OpenAIChatResponse): TextUsage {
  return {
    input: data.usage?.prompt_tokens,
    output: data.usage?.completion_tokens,
    cacheRead: data.usage?.prompt_tokens_details?.cached_tokens,
  };
}

function extractOpenAIText(provider: string, data: OpenAIChatResponse): { text: string; finishReason?: string; truncated: boolean } {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new ProviderRequestError(provider, 502, `no choices in response: ${shortText(JSON.stringify(data), 300)}`);
  }
  const message = choice.message;
  if (message?.refusal) throw new ProviderRequestError(provider, 502, `model refused: ${message.refusal}`);
  const content = message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  // Local reasoning models (Qwen3, DeepSeek-R1 …) may wrap their chain of thought in <think> tags.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  const truncated = finishReason === "length";
  if (!text) {
    throw new ProviderRequestError(
      provider,
      502,
      truncated
        ? "the reply hit the max token limit before any answer text was produced (reasoning used the whole budget); raise the token budget or reduce variants"
        : `empty completion (finish_reason: ${finishReason ?? "unknown"})`,
    );
  }
  return { text, finishReason, truncated };
}

async function generateLocal(req: TextRequest): Promise<TextResponse> {
  const { LOCAL_LLM_BASE_URL: base } = requireEnv(
    "local",
    ["LOCAL_LLM_BASE_URL"],
    "Example: http://<host>:1234/v1 for LM Studio, http://<host>:11434/v1 for Ollama, https://openrouter.ai/api/v1 for OpenRouter. Also set LOCAL_LLM_MODEL.",
  );
  const model = env("LOCAL_LLM_MODEL");
  const apiKey = env("LOCAL_LLM_API_KEY");
  const url = `${trimBaseUrl(base)}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const baseBody: Record<string, unknown> = {
    model, // undefined is dropped by JSON.stringify → LM Studio then uses the loaded model
    messages: [
      { role: "system", content: systemText(req.system) },
      { role: "user", content: req.user },
    ],
    temperature: req.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: req.maxTokens ?? defaultMaxTokens("local"),
    stream: false,
  };

  const post = (body: Record<string, unknown>) =>
    providerFetch("local", url, { method: "POST", headers, body: JSON.stringify(body) }, PROVIDER_TIMEOUTS.text);

  let res = await post(req.json ? { ...baseBody, response_format: { type: "json_object" } } : baseBody);
  // Some OpenAI-compatible servers reject response_format instead of ignoring it → retry once without it.
  if (!res.ok && req.json && (res.status === 400 || res.status === 422)) {
    res = await post(baseBody);
  }
  await expectOk("local", res);
  const data = await readJsonBody<OpenAIChatResponse>("local", res);
  const out = extractOpenAIText("local", data);
  return {
    text: out.text,
    model: data.model ?? model ?? "local-default",
    provider: "local",
    usage: openAIUsage(data),
    finishReason: out.finishReason,
    truncated: out.truncated,
  };
}

/** gpt-5 and newer (gpt-6-luna …) and the o-series only accept the default temperature and use max_completion_tokens. */
function openAISupportsTemperature(model: string): boolean {
  return !/^(gpt-[5-9]|o[1-9])/i.test(model);
}

async function generateOpenAI(req: TextRequest): Promise<TextResponse> {
  const { OPENAI_API_KEY: apiKey } = requireEnv("openai", ["OPENAI_API_KEY"]);
  const model = envOr("OPENAI_MODEL", PROVIDER_DEFAULTS.openaiModel);
  const url = `${trimBaseUrl(envOr("OPENAI_BASE_URL", PROVIDER_DEFAULTS.openaiBaseUrl))}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemText(req.system) },
      { role: "user", content: req.user },
    ],
    max_completion_tokens: req.maxTokens ?? defaultMaxTokens("openai"),
    stream: false,
  };
  if (openAISupportsTemperature(model)) body.temperature = req.temperature ?? DEFAULT_TEMPERATURE;
  if (req.json) body.response_format = { type: "json_object" };

  const res = await providerFetch(
    "openai",
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    PROVIDER_TIMEOUTS.text,
  );
  await expectOk("openai", res);
  const data = await readJsonBody<OpenAIChatResponse>("openai", res);
  const out = extractOpenAIText("openai", data);
  return {
    text: out.text,
    model: data.model ?? model,
    provider: "openai",
    usage: openAIUsage(data),
    finishReason: out.finishReason,
    truncated: out.truncated,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------------------

async function generateGemini(req: TextRequest): Promise<TextResponse> {
  const { GEMINI_API_KEY: apiKey } = requireEnv("gemini", ["GEMINI_API_KEY"]);
  const model = envOr("GEMINI_MODEL", PROVIDER_DEFAULTS.geminiModel);

  // maxOutputTokens includes thinking tokens on Gemini 2.5 models; the budget from suggestedMaxTokens accounts for it.
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: req.maxTokens ?? defaultMaxTokens("gemini"),
  };
  if (req.json) generationConfig.responseMimeType = "application/json";

  const body = {
    systemInstruction: { parts: [{ text: systemText(req.system) }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig,
  };

  const res = await providerFetch(
    "gemini",
    geminiGenerateContentUrl(model),
    { method: "POST", headers: geminiHeaders(apiKey), body: JSON.stringify(body) },
    PROVIDER_TIMEOUTS.text,
  );
  await expectOk("gemini", res);
  const data = await readJsonBody<GeminiGenerateContentResponse>("gemini", res);

  if (data.error?.message) throw new ProviderRequestError("gemini", data.error.code ?? 502, data.error.message);
  if (data.promptFeedback?.blockReason) {
    throw new ProviderRequestError(
      "gemini",
      502,
      `prompt blocked (${data.promptFeedback.blockReason})${data.promptFeedback.blockReasonMessage ? `: ${data.promptFeedback.blockReasonMessage}` : ""}`,
    );
  }
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const finishReason = candidate?.finishReason;
  const truncated = finishReason === "MAX_TOKENS";
  if (!text) {
    throw new ProviderRequestError(
      "gemini",
      502,
      truncated
        ? "the reply hit maxOutputTokens before any answer text was produced (thinking used the whole budget); raise the token budget or reduce variants"
        : `empty response (finishReason: ${finishReason ?? "none"}${candidate?.finishMessage ? `, ${candidate.finishMessage}` : ""})`,
    );
  }
  return {
    text,
    model: data.modelVersion ?? model,
    provider: "gemini",
    usage: {
      input: data.usageMetadata?.promptTokenCount,
      output: data.usageMetadata?.candidatesTokenCount,
      cacheRead: data.usageMetadata?.cachedContentTokenCount,
    },
    finishReason,
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------------------

type AnthropicMessagesResponse = {
  model?: string;
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  error?: { type?: string; message?: string };
};

/** Sampling parameters were removed on Claude 4.6+ (400 when sent); only legacy families still accept them. */
function anthropicSupportsTemperature(model: string): boolean {
  return /claude-(3|sonnet-4-5|opus-4-5|opus-4-1|haiku-4-5|sonnet-4-2|opus-4-2)/i.test(model);
}

/** Anthropic's input_tokens excludes cached tokens; add them back so `input` means every prompt token, as elsewhere. */
function anthropicUsage(data: AnthropicMessagesResponse): TextUsage {
  const u = data.usage;
  if (!u) return {};
  const cacheRead = u.cache_read_input_tokens ?? undefined;
  const cacheWrite = u.cache_creation_input_tokens ?? undefined;
  const input = u.input_tokens === undefined ? undefined : u.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return { input, output: u.output_tokens, cacheRead, cacheWrite };
}

async function generateAnthropic(req: TextRequest): Promise<TextResponse> {
  const { ANTHROPIC_API_KEY: apiKey } = requireEnv("anthropic", ["ANTHROPIC_API_KEY"]);
  const model = envOr("ANTHROPIC_MODEL", PROVIDER_DEFAULTS.anthropicModel);
  const url = `${trimBaseUrl(envOr("ANTHROPIC_BASE_URL", PROVIDER_DEFAULTS.anthropicBaseUrl))}/v1/messages`;

  // The stable part (role, standards, brand block) carries the cache breakpoint, so the retry and every later brief
  // for the same brand within the cache TTL read it from the cache. Below the model's minimum cacheable length the
  // request still succeeds, just without a cache write.
  const system =
    typeof req.system === "string"
      ? req.system
      : [
          { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: req.system.variable },
        ];
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? defaultMaxTokens("anthropic"),
    system,
    messages: [{ role: "user", content: req.user }],
  };
  if (req.temperature !== undefined && anthropicSupportsTemperature(model)) body.temperature = req.temperature;
  // JSON mode: no response_format / prefill on current Claude models; the system prompt's output contract
  // plus parseGenerationOutput (which strips fences and finds the outermost object) handle it.

  const res = await providerFetch(
    "anthropic",
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
    PROVIDER_TIMEOUTS.text,
  );
  await expectOk("anthropic", res);
  const data = await readJsonBody<AnthropicMessagesResponse>("anthropic", res);

  if (data.error?.message) throw new ProviderRequestError("anthropic", 502, data.error.message);
  if (data.stop_reason === "refusal") {
    const why = data.stop_details?.explanation ?? data.stop_details?.category ?? "no explanation";
    throw new ProviderRequestError("anthropic", 502, `model refused the request: ${why}`);
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  if (!text) {
    throw new ProviderRequestError("anthropic", 502, `empty response (stop_reason: ${data.stop_reason ?? "none"})`);
  }
  return {
    text,
    model: data.model ?? model,
    provider: "anthropic",
    usage: anthropicUsage(data),
    finishReason: data.stop_reason ?? undefined,
    truncated: data.stop_reason === "max_tokens",
  };
}

// ---------------------------------------------------------------------------------------------------------
// Mock strategist (no network). Builds a schema-valid GenerationOutput from hints in the user prompt.
// ---------------------------------------------------------------------------------------------------------

type MockLang = "de" | "en";

export type MockHints = {
  brandSlug: string;
  brandName: string;
  /** Brand website from the prompt's brand line, when present. */
  website?: string;
  platform: string;
  postType: string;
  topic: string;
  language: "de" | "en" | "de_en";
  variants: number;
  hookType: string;
  goal: string;
  pillar: string;
  tone: string;
  register: string;
  emotionalDriver: string;
  ctaOverride: string;
  audience: string;
  length: string;
  hasSourceText: boolean;
};

const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
const POST_TYPE_IDS = POST_TYPES.map((p) => p.id);
const HOOK_TYPE_IDS = HOOK_TYPES.map((h) => h.id);

/** Brand names the legacy hint scanner recognises without a BRIEF_JSON line (none by default). */
const KNOWN_BRANDS: { slug: string; name: string; patterns: RegExp[] }[] = [];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Value of a `label: value` / `"label": "value"` / `label = value` line, or "" when absent. */
function pickText(text: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(
      `(?:^|[\\n{,;(])[\\s"'*_\\-#]*${escapeRegExp(label)}[\\s"'*_]*[:=]\\s*["']?([^\\n"]+?)["']?\\s*,?\\s*(?:\\n|$)`,
      "i",
    );
    const m = re.exec(text);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return "";
}

/** Like pickText but normalised to a lowercase id-style token (letters, digits, _ and -). */
function pickId(text: string, labels: string[]): string {
  const raw = pickText(text, labels);
  if (!raw) return "";
  const m = /[a-z0-9_-]+/i.exec(raw);
  return m ? m[0].toLowerCase() : "";
}

function earliestMatch(text: string, candidates: { id: string; re: RegExp }[]): string {
  let best: { id: string; index: number } | undefined;
  for (const c of candidates) {
    const m = c.re.exec(text);
    if (m && (best === undefined || m.index < best.index)) best = { id: c.id, index: m.index };
  }
  return best?.id ?? "";
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const strOf = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** The machine-readable first line lib/prompt/user.ts emits: `BRIEF_JSON: {...}` (free text is not in it). */
function parseBriefJsonLine(user: string): Rec | null {
  const m = /^BRIEF_JSON:\s*(\{.*\})\s*$/m.exec(user);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[1]);
    return isRec(v) ? v : null;
  } catch {
    return null;
  }
}

/** Value of a `Label: «…»` line as written by buildUserPrompt (guillemets wrap every free-text field). */
function guillemetField(user: string, label: string): string {
  const re = new RegExp(`^${escapeRegExp(label)}:\\s*«([^»]*)»`, "m");
  const m = re.exec(user);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Reads the brief hints the prompt engine embeds in the user prompt. The BRIEF_JSON line is authoritative
 * (exact ids for every dropdown); the labelled-line scan is only a fallback for prompts that lack it.
 */
export function extractMockHints(user: string): MockHints {
  const json = parseBriefJsonLine(user);
  if (json) return hintsFromBriefJson(user, json);
  return extractMockHintsLegacy(user);
}

function hintsFromBriefJson(user: string, json: Rec): MockHints {
  const brandSlug = strOf(json.brandSlug).toLowerCase() || "generic";
  const known = KNOWN_BRANDS.find((b) => b.slug === brandSlug);
  const jobBrand = /^Date: .*? Brand: (.+?)\. Platform: /m.exec(user)?.[1]?.trim();
  const brandName = known?.name ?? (jobBrand || brandSlug);

  const platformRaw = strOf(json.platform).toLowerCase();
  let platform = PLATFORM_IDS.includes(platformRaw) ? platformRaw : "";
  if (!platform) platform = "instagram";

  const postTypeRaw = strOf(json.postType).toLowerCase();
  let postType = POST_TYPE_IDS.includes(postTypeRaw) ? postTypeRaw : "";
  if (!postType) postType = platform === "linkedin" ? "linkedin_text" : "reel_script";

  const langRaw = strOf(json.language).toLowerCase();
  const language: MockHints["language"] = langRaw === "de_en" || langRaw === "en" || langRaw === "de" ? langRaw : "en";

  const variantsRaw = Number.parseInt(strOf(json.variants), 10);
  const variants = Number.isFinite(variantsRaw) ? Math.min(3, Math.max(1, variantsRaw)) : 1;

  const hookRaw = strOf(json.hookType).toLowerCase();
  const hookType = HOOK_TYPE_IDS.includes(hookRaw) ? hookRaw : "auto";

  const pillarRaw = strOf(json.pillar);
  const topic = guillemetField(user, "Topic / angle");

  const websiteRaw = /· Website: (\S+) ·/.exec(user)?.[1] ?? "";
  return {
    brandSlug,
    brandName,
    website: websiteRaw && websiteRaw !== "-" ? websiteRaw : undefined,
    platform,
    postType,
    topic: shortText(topic, 200),
    language,
    variants,
    hookType,
    goal: strOf(json.goal).toLowerCase() || "awareness",
    pillar: shortText(pillarRaw.toLowerCase() === "custom" ? "" : pillarRaw, 120),
    tone: strOf(json.tone).toLowerCase() || "brand_default",
    register: strOf(json.register).toLowerCase() || "brand_default",
    emotionalDriver: strOf(json.emotionalDriver).toLowerCase() || "auto",
    ctaOverride: shortText(guillemetField(user, "CTA override"), 200),
    audience: shortText(guillemetField(user, "Audience"), 160),
    length: strOf(json.length).toLowerCase() || "medium",
    hasSourceText: /^=== SOURCE TEXT/m.test(user) || /^<<<SOURCE$/m.test(user),
  };
}

/** Fallback for prompts without a BRIEF_JSON line (labelled lines or loose JSON fields). */
export function extractMockHintsLegacy(user: string): MockHints {
  const text = user;

  // Brand
  let brandSlug = "";
  let brandName = "";
  const brandLabel = pickText(text, ["brandSlug", "brand slug", "brand name", "brandName", "brand", "marke"]);
  const probe = brandLabel || text;
  const detected = brandLabel
    ? KNOWN_BRANDS.find((b) => b.patterns.some((re) => re.test(probe)))
    : KNOWN_BRANDS.map((b) => ({ b, idx: Math.min(...b.patterns.map((re) => { const m = re.exec(text); return m ? m.index : Number.POSITIVE_INFINITY; })) }))
        .filter((x) => Number.isFinite(x.idx))
        .sort((a, b) => a.idx - b.idx)[0]?.b;
  if (detected) {
    brandSlug = detected.slug;
    brandName = detected.name;
  } else {
    brandName = brandLabel || "the brand";
    brandSlug = brandLabel ? brandLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "generic";
  }

  // Platform
  let platform = pickId(text, ["platform", "plattform", "channel", "kanal"]);
  if (!PLATFORM_IDS.includes(platform)) {
    platform = earliestMatch(
      text,
      PLATFORM_IDS.map((id) => ({ id, re: new RegExp(`\\b${id === "x" ? "x \\(twitter\\)|twitter" : id}\\b`, "i") })),
    );
  }
  if (!platform) platform = "instagram";

  // Post type
  let postType = pickId(text, ["postType", "post type", "post_type", "format", "content type", "contentType"]);
  if (!POST_TYPE_IDS.includes(postType)) {
    const byLabel = pickText(text, ["postType", "post type", "post_type", "format"]).toLowerCase();
    const found = POST_TYPES.find((p) => byLabel && byLabel.includes(p.label.toLowerCase().split(" ")[0]));
    postType = found?.id ?? earliestMatch(text, POST_TYPE_IDS.map((id) => ({ id, re: new RegExp(`\\b${id}\\b`, "i") })));
  }
  if (!postType) postType = platform === "linkedin" ? "linkedin_text" : "reel_script";

  // Language
  const langRaw = pickId(text, ["language", "sprache", "lang"]);
  let language: MockHints["language"];
  if (/^de[_+-]?en$/.test(langRaw) || /\bde_en\b/i.test(text)) language = "de_en";
  else if (/^(en|english|englisch)/.test(langRaw)) language = "en";
  else if (/^(de|deutsch|german)/.test(langRaw)) language = "de";
  else language = "en";

  // Variants
  let variants = Number.parseInt(pickId(text, ["variants", "variant count", "variantCount", "number of variants", "varianten"]), 10);
  if (!Number.isFinite(variants)) {
    const m = /(\d)\s*(?:variants?|varianten|versions?)\b/i.exec(text);
    variants = m ? Number.parseInt(m[1], 10) : 1;
  }
  variants = Math.min(3, Math.max(1, variants || 1));

  const hookTypeRaw = pickId(text, ["hookType", "hook type", "hook_type", "hook"]);
  const hookType = HOOK_TYPE_IDS.includes(hookTypeRaw) ? hookTypeRaw : "auto";

  return {
    brandSlug,
    brandName,
    platform,
    postType,
    topic: shortText(pickText(text, ["topic", "thema", "subject", "angle", "brief"]), 200),
    language,
    variants,
    hookType,
    goal: pickId(text, ["goal", "ziel", "objective"]) || "awareness",
    pillar: shortText(pickText(text, ["pillar", "content pillar", "säule"]), 120),
    tone: pickId(text, ["tone", "tonalität", "ton"]) || "brand_default",
    register: pickId(text, ["register", "anrede"]) || "brand_default",
    emotionalDriver: pickId(text, ["emotionalDriver", "emotional driver", "emotional_driver", "driver"]) || "auto",
    ctaOverride: shortText(pickText(text, ["ctaOverride", "cta override", "cta_override", "cta"]), 200),
    audience: shortText(pickText(text, ["audience", "zielgruppe", "persona"]), 160),
    length: pickId(text, ["length", "länge"]) || "medium",
    hasSourceText: /sourceText|source text|quelltext/i.test(text),
  };
}

type Bi = { de: string; en: string };
type BiList = { de: string[]; en: string[] };

type MockAngle = {
  key: string;
  label: Bi;
  hookType: string;
  driver: string;
  hook: Bi;
  body: BiList;
  caption: Bi; // may contain {cta}
  thumbnail: Bi;
};

type MockBrand = {
  slug: string;
  name: string;
  handle: string;
  site: string;
  cta: Bi;
  hashtags: string[];
  visual: string;
  audio: string;
  imagePrompt: string;
  videoPrompt: string;
  shots: string[];
  compliance: string;
  disclaimer?: string;
  angles: MockAngle[];
};

function genericBrand(name: string, website?: string): MockBrand {
  const site = (website ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "") || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`;
  return {
    slug: "generic",
    name,
    handle: `@${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    site,
    cta: { de: `Mehr auf ${site}`, en: `More at ${site}` },
    hashtags: ["#marketing", "#content", "#smallbusiness", "#brand", "#behindthescenes", "#socialmedia"],
    visual: "Brand default visual system: one headline, one accent colour, generous whitespace, logo top corner.",
    audio: "Calm VO, subtle underscore.",
    imagePrompt: "Clean editorial brand visual, minimal composition, one accent colour, soft light, no text, no people",
    videoPrompt: "Slow push-in on a minimal branded scene, soft light, subtle motion, 9:16",
    shots: ["Opening hook card", "Product or person in context", "Detail insert", "Proof or example", "Closing card with CTA"],
    compliance: "Mock output: verify every fact, price and claim against the brand knowledge base before publishing.",
    angles: [
      {
        key: "problem",
        label: { de: "Problem zuerst", en: "Problem first" },
        hookType: "problem_question",
        driver: "relief",
        hook: { de: `Warum kostet das eigentlich jede Woche so viel Zeit?`, en: `Why does this take so much time every week?` },
        body: {
          de: ["Das Problem ist selten das, was zuerst auffällt.", "Wir zeigen den Ablauf, wie er heute ist.", "Und den einen Schritt, der ihn verändert.", `${name} macht genau das.`, "Ein Schritt. Diese Woche."],
          en: ["The problem is rarely the thing you notice first.", "We show the process as it is today.", "And the one step that changes it.", `${name} does exactly that.`, "One step. This week."],
        },
        caption: { de: `Das Problem zuerst, dann die Lösung.\n\n${name} zeigt den einen Schritt, der den Unterschied macht.\n\n{cta}`, en: `Problem first, then the solution.\n\n${name} shows the one step that makes the difference.\n\n{cta}` },
        thumbnail: { de: "Das Problem zuerst.", en: "Problem first." },
      },
      {
        key: "scene",
        label: { de: "Eine Szene aus dem Alltag", en: "A scene from everyday life" },
        hookType: "time_stamped_scene",
        driver: "identification",
        hook: { de: "Dienstag, 9:12 Uhr. Der Kaffee ist noch heiß, die erste Frage schon da.", en: "Tuesday, 9:12 a.m. The coffee is still hot, the first question already here." },
        body: {
          de: ["Jeder kennt diesen Moment.", "Die Frage ist dieselbe wie gestern.", "Die Antwort auch.", `Genau hier setzt ${name} an.`, "Weniger Wiederholung. Mehr Zeit für das, was zählt."],
          en: ["Everyone knows this moment.", "The question is the same as yesterday.", "So is the answer.", `This is exactly where ${name} starts.`, "Less repetition. More time for what matters."],
        },
        caption: { de: `Dienstag, 9:12 Uhr. Kennen Sie den Moment?\n\n${name} nimmt die Wiederholung raus.\n\n{cta}`, en: `Tuesday, 9:12 a.m. Know that moment?\n\n${name} takes the repetition out.\n\n{cta}` },
        thumbnail: { de: "9:12 Uhr", en: "9:12 a.m." },
      },
      {
        key: "myth",
        label: { de: "Mythos vs. Fakt", en: "Myth vs. fact" },
        hookType: "myth_bust",
        driver: "curiosity",
        hook: { de: "Mythos: Das braucht ein neues Tool. Fakt: Meistens nicht.", en: "Myth: this needs a new tool. Fact: usually it doesn't." },
        body: {
          de: ["Die meisten Probleme sind Prozessprobleme.", "Ein neues Tool überdeckt sie nur.", "Erst der Prozess, dann das Werkzeug.", `So arbeitet ${name}.`, "Das klingt unspektakulär. Es funktioniert."],
          en: ["Most problems are process problems.", "A new tool only covers them.", "Process first, then the tool.", `That is how ${name} works.`, "It sounds unspectacular. It works."],
        },
        caption: { de: `Mythos: Ein neues Tool löst das. Fakt: Erst der Prozess.\n\n{cta}`, en: `Myth: a new tool solves it. Fact: process first.\n\n{cta}` },
        thumbnail: { de: "Mythos vs. Fakt", en: "Myth vs. fact" },
      },
    ],
  };
}

/** Brand-specific mock templates (none ship by default; every brand uses the generic templates built from its name). */
const MOCK_BRANDS: Record<string, MockBrand> = {};

const VIDEO_TYPES = new Set(["reel_script", "talking_head", "youtube_script", "ugc_testimonial_brief"]);
const SLIDE_TYPES = new Set(["carousel", "linkedin_document", "story_sequence"]);

const CTA_TYPE_BY_GOAL: Record<string, string> = {
  awareness: "share",
  traffic: "link",
  lead: "dm_or_trial",
  purchase: "shop",
  engagement: "comment",
  save_share: "save",
  follow: "follow",
  trust: "proof_link",
  retention: "community",
};

const UGC_QUESTIONS: BiList = {
  de: [
    "Wie war deine Situation, bevor du angefangen hast?",
    "Was hat dich anfangs skeptisch gemacht?",
    "Wie sieht dein Alltag damit heute konkret aus?",
    "Was würdest du jemandem sagen, der noch zögert?",
    "Was hat dich am meisten überrascht?",
  ],
  en: [
    "What was your situation before you started?",
    "What made you sceptical at first?",
    "What does your everyday routine look like today, concretely?",
    "What would you tell someone who is still hesitating?",
    "What surprised you most?",
  ],
};

function firstClause(line: string, max = 42): string {
  const cleaned = line.replace(/[→↳📍🖤]/g, "").trim();
  const sentence = cleaned.split(/(?<=[.!?:])\s/)[0] ?? cleaned;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function cleanForTts(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu, "")
    .replace(/[→↳📍🖤🤍✨]/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\{cta\}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function variantPlainText(hook: string, body: string[], cta: string): string {
  return [hook, ...body, cta].filter(Boolean).join("\n\n");
}

function buildMockVariant(brand: MockBrand, angle: MockAngle, hints: MockHints, lang: MockLang, index: number): Variant {
  const isLinkedIn = hints.platform === "linkedin";
  const cta = hints.ctaOverride || brand.cta[lang];
  const hook = angle.hook[lang];
  const body = angle.body[lang];
  const caption = angle.caption[lang].replace("{cta}", cta);
  const hashtags = isLinkedIn ? brand.hashtags.slice(0, 4) : brand.hashtags;
  const hookType = hints.hookType !== "auto" ? hints.hookType : angle.hookType;
  const topicNote = hints.topic ? ` Topic from the brief: "${hints.topic}".` : "";
  const overlays = [angle.thumbnail[lang], ...body.slice(0, 3).map((l) => firstClause(l))];
  const altLang: MockLang = lang === "de" ? "en" : "de";
  const altVersion =
    hints.language === "de_en"
      ? variantPlainText(angle.hook[altLang], angle.body[altLang], hints.ctaOverride || brand.cta[altLang])
      : "";

  const base: Variant = {
    title: `${String.fromCharCode(65 + index)} · ${angle.label[lang]} (${brand.name})`,
    hook,
    hookType,
    script: "",
    onScreenText: [],
    shots: [],
    caption,
    hashtags,
    cta,
    ctaType: CTA_TYPE_BY_GOAL[hints.goal] ?? "link",
    visualDirection: `${brand.visual}${topicNote}`,
    audioDirection: brand.audio,
    thumbnailText: angle.thumbnail[lang],
    imagePrompt: brand.imagePrompt,
    videoPrompt: brand.videoPrompt,
    voiceoverText: "",
    altVersion,
  };

  if (VIDEO_TYPES.has(hints.postType)) {
    const lines = hints.postType === "ugc_testimonial_brief" ? UGC_QUESTIONS[lang] : body;
    const script =
      hints.postType === "ugc_testimonial_brief"
        ? [
            lang === "de" ? "Interviewfragen (Kunde spricht frei, nicht ablesen):" : "Interview questions (customer speaks freely, no reading):",
            ...lines.map((q, i) => `${i + 1}. ${q}`),
            lang === "de" ? "Schnittstruktur: Hook aus Antwort 2, dann 1, 3, 4, Abschluss mit 5." : "Edit structure: hook from answer 2, then 1, 3, 4, close with 5.",
            brand.disclaimer ? `Disclaimer (on screen + caption): ${brand.disclaimer}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : hints.postType === "youtube_script"
          ? [
              `00:00 Hook. ${hook}`,
              ...body.map((l, i) => `0${i + 1}:${String((i + 1) * 15).padStart(2, "0")} ${l}`),
              `Outro. ${cta}`,
            ].join("\n\n")
          : variantPlainText(hook, body, cta);
    const shotCount = Math.min(brand.shots.length, lines.length);
    return {
      ...base,
      script,
      onScreenText: overlays,
      shots: Array.from({ length: shotCount }, (_, i) => ({
        order: i + 1,
        duration: hints.postType === "youtube_script" ? "20–40 s" : i === 0 ? "2 s" : "3–4 s",
        visual: brand.shots[i],
        text: overlays[i] ?? "",
        audio: `VO: ${firstClause(i === 0 ? hook : lines[i - 1] ?? lines[i], 80)}`,
      })),
      voiceoverText: cleanForTts(variantPlainText(hook, hints.postType === "ugc_testimonial_brief" ? [] : body, cta)),
      caption:
        brand.disclaimer && hints.postType === "ugc_testimonial_brief" ? `${caption}\n\n${brand.disclaimer}` : caption,
    };
  }

  if (SLIDE_TYPES.has(hints.postType)) {
    const isStory = hints.postType === "story_sequence";
    const slideLines = isStory ? body.slice(0, 4) : body;
    const stickers = lang === "de"
      ? ["Sticker: Umfrage (Ja / Nein)", "Sticker: Frage-Box", "Sticker: Slider", "Sticker: Link"]
      : ["Sticker: poll (yes / no)", "Sticker: question box", "Sticker: slider", "Sticker: link"];
    const shots = [
      { order: 1, duration: isStory ? "5 s" : "", visual: `${brand.shots[0]}${isStory ? ` · ${stickers[0]}` : ""}`, text: hook, audio: "" },
      ...slideLines.map((line, i) => ({
        order: i + 2,
        duration: isStory ? "5 s" : "",
        visual: `${brand.shots[Math.min(i + 1, brand.shots.length - 1)]}${isStory ? ` · ${stickers[Math.min(i + 1, stickers.length - 1)]}` : ""}`,
        text: line,
        audio: "",
      })),
      { order: slideLines.length + 2, duration: isStory ? "5 s" : "", visual: brand.shots[brand.shots.length - 1], text: cta, audio: "" },
    ];
    return { ...base, shots, onScreenText: shots.map((s) => firstClause(s.text, 60)) };
  }

  // Text formats: linkedin_text, static_post, ad_creative, blog_to_social
  if (hints.postType === "ad_creative") {
    const primary = [variantPlainText(hook, body.slice(0, 2), cta), variantPlainText(body[2] ?? hook, [body[3] ?? ""], cta), variantPlainText(angle.thumbnail[lang], body.slice(0, 1), cta)];
    const script = [
      `Primary text A:\n${primary[0]}`,
      `Primary text B:\n${primary[1]}`,
      `Primary text C:\n${primary[2]}`,
      `Headline: ${angle.thumbnail[lang]}`,
      `Description: ${firstClause(body[0], 80)}`,
      `Asset brief: ${brand.visual}`,
    ].join("\n\n");
    return { ...base, script, caption: primary[0], onScreenText: [angle.thumbnail[lang]] };
  }
  if (hints.postType === "static_post") {
    return { ...base, script: variantPlainText(hook, body.slice(0, 2), cta), onScreenText: [angle.thumbnail[lang]] };
  }
  if (hints.postType === "blog_to_social") {
    const note = hints.hasSourceText
      ? lang === "de"
        ? "Hinweis: Mock-Modus. Der Quelltext wurde nicht analysiert; die Kernaussagen stammen aus den Marken-Templates."
        : "Note: mock mode. The source text was not analysed; the key points come from the brand templates."
      : "";
    const text = variantPlainText(hook, body, cta);
    return { ...base, script: text, caption: `${text}${note ? `\n\n${note}` : ""}`, onScreenText: overlays };
  }
  // linkedin_text and anything else: full body text, ready to paste
  const text = variantPlainText(hook, body, cta);
  return { ...base, script: text, caption: `${text}\n\n${hashtags.join(" ")}` };
}

/** Builds the deterministic mock output. Exported so tests / the pipeline can call it without generateText. */
export function buildMockOutput(hints: MockHints): GenerationOutput {
  const brand = MOCK_BRANDS[hints.brandSlug] ?? genericBrand(hints.brandName, hints.website);
  const lang: MockLang = hints.language === "en" ? "en" : "de";
  const variants = brand.angles.slice(0, hints.variants).map((angle, i) => buildMockVariant(brand, angle, hints, lang, i));
  const angleLabels = brand.angles.slice(0, hints.variants).map((a) => a.label[lang]).join(" / ");

  const output: GenerationOutput = {
    strategy: {
      angle: `${angleLabels} for ${brand.name} on ${hints.platform} (${hints.postType}).${hints.topic ? ` Topic: ${hints.topic}.` : ""}`,
      whyItFits: `Mock strategist: the angle mirrors ${brand.name}'s observed voice, matches the goal "${hints.goal}"${hints.pillar ? ` and the pillar "${hints.pillar}"` : ""}${hints.audience ? ` for the audience "${hints.audience}"` : ""}. Replace with a real provider for brief-specific reasoning.`,
      referencesUsed: ["Mock mode: reference posts in the prompt were not analysed; the pipeline still records which references were shown."],
      repetitionCheck: "Mock mode: hooks are fixed per angle. Run the repetition report against approved generations before publishing.",
      emotionalDriver: hints.emotionalDriver !== "auto" ? hints.emotionalDriver : brand.angles[0].driver,
    },
    variants,
    selfReview: {
      score: 6,
      strengths: [
        "Hook stands alone and names a concrete detail",
        "Facts, prices and links limited to the brand knowledge base",
        `CTA type matches the goal (${CTA_TYPE_BY_GOAL[hints.goal] ?? "link"})`,
      ],
      risks: [
        "Mock output: no brief-specific reasoning; verify every fact before publishing",
        hints.register !== "brand_default" ? `Register "${hints.register}" was requested but the mock templates use the brand default register` : "Tone and length were not adapted to the brief",
        hints.language === "de_en" ? "altVersion is a template translation, not a localisation" : "Only one language version was produced",
      ],
      complianceCheck: brand.compliance,
    },
  };
  return output;
}

async function generateMock(req: TextRequest): Promise<TextResponse> {
  if (!isMockEnabled()) {
    throw new ProviderNotConfiguredError("mock", ["MOCK_LLM=1"], "The mock strategist is enabled automatically outside production.");
  }
  const hints = extractMockHints(req.user);
  const candidate = buildMockOutput(hints);
  const parsed = GenerationOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProviderRequestError("mock", 502, `mock output failed schema validation: ${parsed.error.message}`);
  }
  const text = JSON.stringify(parsed.data, null, 2);
  return {
    text,
    model: "mock-strategist-v1",
    provider: "mock",
    usage: {
      input: Math.ceil((systemText(req.system).length + req.user.length) / 4),
      output: Math.ceil(text.length / 4),
    },
  };
}
