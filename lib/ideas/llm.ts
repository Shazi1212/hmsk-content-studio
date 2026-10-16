/**
 * One chat completion against the Ideas model (OpenAI-compatible: Open WebUI, Ollama, LM Studio, vLLM …).
 *
 * The request streams (`stream: true`) and the chunks are collected here. Streaming matters for two reasons: the path to
 * A tunnel such as Cloudflare answers 524 when the origin sends nothing for 100 s, and a reasoning model
 * can think for minutes before the answer starts; a live stream keeps bytes flowing the whole time. A server that answers
 * with plain JSON instead is handled as well.
 *
 * Failures become ProviderRequestError (status 0 = network, timeout or stall) with messages that say what to check.
 */
import { ProviderRequestError, readErrorBody, shortText } from "@/lib/providers/config";
import { IDEAS_PROVIDER, ideasLlmConfig } from "./config";

export type IdeasLlmRequest = {
  system: string;
  user: string;
  /** Must be one of the configured models; undefined = the configured default. */
  model?: string;
  temperature?: number;
  maxTokens: number;
  /** Ask the server for JSON mode (`response_format: json_object`); retried without it when the server rejects it. */
  json?: boolean;
};

export type IdeasLlmResponse = {
  text: string;
  model: string;
  finishReason?: string;
  truncated: boolean;
  usage: { input?: number; output?: number };
  /** Characters of reasoning the server streamed separately (not part of `text`). */
  reasoningChars: number;
};

/** The stream may pause while the server loads the model or evaluates a long prompt; beyond this it is considered dead. */
const STALL_MS = 150_000;

type Chunk = {
  model?: string;
  error?: { message?: string } | string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; thinking?: string | null };
    message?: { content?: string | { text?: string }[] | null };
    finish_reason?: string | null;
  }[];
};

/** Removes inline chain of thought that some servers leave in the content (`<think>…</think>`, Open WebUI reasoning blocks). */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<details type="reasoning"[\s\S]*?<\/details>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function friendlyHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return `The Ideas model server rejected the credentials. Check IDEAS_LLM_API_KEY (and the Cloudflare Access token, if one is used). ${detail}`;
  }
  if (status === 404) return `the endpoint was not found. IDEAS_LLM_BASE_URL should end in /api for Open WebUI (…/api/chat/completions). ${detail}`;
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) {
    return `The Ideas model server is not answering. Check that the server (and any tunnel) is running and that the model is loaded. ${detail}`;
  }
  return detail;
}

export async function ideasChat(req: IdeasLlmRequest): Promise<IdeasLlmResponse> {
  const cfg = ideasLlmConfig();
  const model = req.model ?? cfg.model;
  const url = `${cfg.baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json", accept: "text/event-stream, application/json", ...cfg.headers };

  const baseBody: Record<string, unknown> = {
    model, // undefined is dropped by JSON.stringify: the server then uses its default
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens,
    stream: true,
  };

  // One log line per call (server logs): how far a stream got is the first question when the model server or a tunnel misbehaves.
  const t0 = Date.now();
  let firstByteMs = -1;
  let chunkCount = 0;
  let contentChars = 0;
  const trace = (outcome: string) =>
    console.log(`[ideas] ${model ?? "default model"}: ${outcome} after ${((Date.now() - t0) / 1000).toFixed(1)} s (first byte ${firstByteMs < 0 ? "never" : `${(firstByteMs / 1000).toFixed(1)} s`}, ${chunkCount} chunks, ${contentChars} answer characters)`);

  const controller = new AbortController();
  let abortReason = "";
  const abort = (reason: string) => {
    abortReason = reason;
    controller.abort();
  };
  const total = setTimeout(() => abort(`no complete answer within ${Math.round(cfg.timeoutMs / 1000)} s`), cfg.timeoutMs);
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => abort(`no data for ${Math.round(STALL_MS / 1000)} s`), STALL_MS);
  };

  try {
    armStall();
    const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });

    let res = await post(req.json ? { ...baseBody, response_format: { type: "json_object" } } : baseBody);
    // Some servers reject response_format instead of ignoring it: retry once without it.
    if (!res.ok && req.json && (res.status === 400 || res.status === 422)) res = await post(baseBody);
    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new ProviderRequestError(IDEAS_PROVIDER, res.status, friendlyHttpError(res.status, shortText(detail, 300)));
    }
    armStall();

    let text = "";
    let reasoningChars = 0;
    let finishReason: string | undefined;
    let serverModel: string | undefined;
    const usage: { input?: number; output?: number } = {};
    let streamError: string | undefined;

    const absorb = (chunk: Chunk) => {
      if (chunk.error) streamError = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "the server reported an error");
      if (chunk.model) serverModel = chunk.model;
      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === "number") usage.input = chunk.usage.prompt_tokens;
        if (typeof chunk.usage.completion_tokens === "number") usage.output = chunk.usage.completion_tokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta) {
        if (typeof delta.content === "string") text += delta.content;
        for (const r of [delta.reasoning_content, delta.reasoning, delta.thinking]) if (typeof r === "string") reasoningChars += r.length;
      }
      const content = choice.message?.content;
      if (typeof content === "string") text += content;
      else if (Array.isArray(content)) text += content.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    };

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleLine = (raw: string) => {
        const line = raw.replace(/\r$/, "");
        if (!line.startsWith("data:")) return; // comments (": keep-alive"), event names, blank lines
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        try {
          absorb(JSON.parse(payload) as Chunk);
        } catch {
          /* a partial or non-JSON data line: ignore it, the next chunk carries on */
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armStall();
        if (firstByteMs < 0) firstByteMs = Date.now() - t0;
        chunkCount++;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } else {
      const raw = await res.text();
      try {
        absorb(JSON.parse(raw) as Chunk);
      } catch {
        throw new ProviderRequestError(IDEAS_PROVIDER, 502, `non-JSON response: ${shortText(raw, 300) || "(empty)"}`);
      }
    }

    if (streamError) throw new ProviderRequestError(IDEAS_PROVIDER, 502, shortText(streamError, 300));
    contentChars = text.length;
    const answer = stripReasoning(text);
    const truncated = finishReason === "length";
    trace(`finished (${finishReason ?? "no finish_reason"}${reasoningChars ? `, ${reasoningChars} reasoning characters` : ""})`);
    if (!answer) {
      throw new ProviderRequestError(
        IDEAS_PROVIDER,
        502,
        truncated
          ? "the reply hit the token limit before any answer text was produced (the model spent it all on reasoning); try the faster model or fewer ideas"
          : `the model returned an empty answer (finish_reason: ${finishReason ?? "unknown"}${reasoningChars ? `, ${reasoningChars} characters of reasoning` : ""})`,
      );
    }
    return { text: answer, model: serverModel ?? model ?? "server-default", finishReason, truncated, usage, reasoningChars };
  } catch (err) {
    trace(`failed (${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)})`);
    if (err instanceof ProviderRequestError) throw err;
    if (controller.signal.aborted) throw new ProviderRequestError(IDEAS_PROVIDER, 0, `timed out: ${abortReason || "request aborted"}`);
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new ProviderRequestError(IDEAS_PROVIDER, 0, `network error: ${cause}. Check that the model server is online.`);
  } finally {
    clearTimeout(total);
    if (stall) clearTimeout(stall);
  }
}

/** GET {base}/models with a short timeout: the "Check connection" button of the Ideas tab. Never throws. */
export async function probeIdeasLlm(): Promise<{ reachable: boolean; detail: string; serverModels: string[]; ms: number }> {
  const started = Date.now();
  const done = (reachable: boolean, detail: string, serverModels: string[] = []) => ({ reachable, detail, serverModels, ms: Date.now() - started });
  let cfg;
  try {
    cfg = ideasLlmConfig();
  } catch (err) {
    return done(false, err instanceof Error ? err.message : "not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: { accept: "application/json", ...cfg.headers }, signal: controller.signal });
    if (!res.ok) return done(false, friendlyHttpError(res.status, `HTTP ${res.status}: ${shortText(await readErrorBody(res), 200)}`));
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] } | null;
    const ids = [
      ...(body?.data ?? []).map((m) => (typeof m.id === "string" ? m.id : "")),
      ...(body?.models ?? []).map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "")),
    ].filter(Boolean);
    return done(true, ids.length ? `${ids.length} model${ids.length === 1 ? "" : "s"} listed` : "answered, but listed no models", ids.slice(0, 40));
  } catch (err) {
    if (controller.signal.aborted) return done(false, "no answer within 12 s. Check that the model server is online.");
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return done(false, `network error: ${cause}`);
  } finally {
    clearTimeout(timer);
  }
}
