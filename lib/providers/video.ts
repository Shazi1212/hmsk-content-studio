/**
 * Higgsfield video adapter (text-to-video and image-to-video), asynchronous request model.
 *
 * API (docs.higgsfield.ai, checked 2026-10-01):
 *   submit  POST {base}/{model path}               the model's own JSON body → {status: "queued", request_id, status_url, cancel_url}
 *   status  GET  {base}/requests/{request_id}/status → {status: queued | in_progress | nsfw | failed | completed, video: {url}}
 *   auth    Authorization: Key {HIGGSFIELD_API_KEY}:{HIGGSFIELD_API_SECRET}
 *           An Idempotency-Key header makes a retried submit safe (a fresh key per call here).
 *
 * The default model is Kling 3.0 Standard. Its bodies (duration 3-15 s, sound on|off, aspect_ratio 16:9|9:16|1:1, prompt up to
 * 2,500 characters; image-to-video takes image_url and keeps the picture's own ratio):
 *   kling-video/v3.0/std/text-to-video    {prompt, duration, sound, aspect_ratio}
 *   kling-video/v3.0/std/image-to-video   {image_url, prompt, duration, sound}
 *
 * Env (all optional except the key pair):
 *   HIGGSFIELD_BASE_URL    default https://api.higgsfield.ai
 *   HIGGSFIELD_T2V_MODEL   default kling-video/v3.0/std/text-to-video
 *   HIGGSFIELD_I2V_MODEL   default kling-video/v3.0/std/image-to-video
 *   HIGGSFIELD_SOUND       on | off, default off (the pipeline adds its own voice-over, generated sound would clash with it)
 * A different model needs the same field names as Kling 3.0 (see docs.higgsfield.ai/docs/models/...).
 */
import { randomUUID } from "node:crypto";
import {
  PROVIDER_DEFAULTS,
  PROVIDER_TIMEOUTS,
  ProviderRequestError,
  envOr,
  expectOk,
  providerFetch,
  readJsonBody,
  requireEnv,
  shortText,
  trimBaseUrl,
} from "./config";

export type VideoAspectRatio = "9:16" | "1:1" | "16:9";
export type CreateVideoJobInput = {
  prompt: string;
  imageUrl?: string;
  durationSeconds?: number;
  aspectRatio?: VideoAspectRatio;
};
export type VideoJobStatus = "queued" | "processing" | "completed" | "failed";

/** Request ids are UUIDs; anything else never reaches the vendor URL. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const ASPECT_RATIOS: VideoAspectRatio[] = ["9:16", "1:1", "16:9"];
/** Kling 3.0 accepts 3-15 s; the pipeline default is a 5 s clip. */
const MIN_SECONDS = 3;
const MAX_SECONDS = 15;
const DEFAULT_SECONDS = 5;
const MAX_PROMPT_CHARS = 2500;

type HiggsfieldConfig = {
  authorization: string;
  baseUrl: string;
  t2vModel: string;
  i2vModel: string;
  sound: "on" | "off";
};

function higgsfieldConfig(): HiggsfieldConfig {
  const { HIGGSFIELD_API_KEY: id, HIGGSFIELD_API_SECRET: secret } = requireEnv(
    "higgsfield",
    ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"],
    "Both values come from the Higgsfield API dashboard (key id and key secret).",
  );
  const modelPath = (value: string) => value.replace(/^\/+|\/+$/g, "");
  return {
    authorization: `Key ${id}:${secret}`,
    baseUrl: trimBaseUrl(envOr("HIGGSFIELD_BASE_URL", PROVIDER_DEFAULTS.higgsfieldBaseUrl)),
    t2vModel: modelPath(envOr("HIGGSFIELD_T2V_MODEL", "kling-video/v3.0/std/text-to-video")),
    i2vModel: modelPath(envOr("HIGGSFIELD_I2V_MODEL", "kling-video/v3.0/std/image-to-video")),
    sound: envOr("HIGGSFIELD_SOUND", "off").toLowerCase() === "on" ? "on" : "off",
  };
}

function headers(cfg: HiggsfieldConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: cfg.authorization, "content-type": "application/json", accept: "application/json", ...extra };
}

// ---------------------------------------------------------------------------------------------------------
// Defensive JSON navigation (the status body is read tolerantly: the vendor adds fields between model families)
// ---------------------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a dotted path like "video.url" or "videos.0.url". */
function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(key, 10);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else if (isObject(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

function firstString(root: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = getPath(root, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

const ID_PATHS = ["request_id", "requestId", "id", "data.request_id", "data.id"];
const STATUS_PATHS = ["status", "data.status", "state"];
const URL_PATHS = ["video.url", "videos.0.url", "results.raw.url", "output.video.url", "output.url", "data.video.url", "result.url", "video_url", "url"];
const ERROR_PATHS = ["error.message", "error", "error_message", "failure_reason", "detail", "message", "reason"];

function normaliseStatus(raw: string | undefined): VideoJobStatus | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (/^(queued|pending|in_queue|submitted|created|waiting|scheduled|not_started)$/.test(s)) return "queued";
  if (/^(in_progress|processing|running|started|generating|rendering|active)$/.test(s)) return "processing";
  if (/^(completed|complete|succeeded|success|successful|done|finished|ready)$/.test(s)) return "completed";
  if (/^(failed|failure|error|errored|cancelled|canceled|nsfw|rejected|timeout|timed_out|expired)$/.test(s)) return "failed";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------

export async function createVideoJob(p: CreateVideoJobInput): Promise<{ jobId: string; provider: "higgsfield" }> {
  const cfg = higgsfieldConfig();

  const prompt = (p.prompt ?? "").trim();
  if (!prompt) throw new ProviderRequestError("higgsfield", 400, "prompt is empty: generate a video prompt first");

  const imageUrl = (p.imageUrl ?? "").trim();
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    throw new ProviderRequestError("higgsfield", 400, "imageUrl must be a public https URL (Higgsfield fetches it from its own servers)");
  }

  const aspectRatio: VideoAspectRatio = p.aspectRatio && ASPECT_RATIOS.includes(p.aspectRatio) ? p.aspectRatio : "9:16";
  const duration =
    typeof p.durationSeconds === "number" && Number.isFinite(p.durationSeconds)
      ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(p.durationSeconds)))
      : DEFAULT_SECONDS;

  // The prompt cap is the model's (2,500 characters): cut at a word boundary instead of letting the vendor reject the request.
  const text = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS).replace(/\s+\S*$/, "") : prompt;

  const body: JsonObject = imageUrl
    ? { image_url: imageUrl, prompt: text, duration, sound: cfg.sound }
    : { prompt: text, duration, sound: cfg.sound, aspect_ratio: aspectRatio };
  const model = imageUrl ? cfg.i2vModel : cfg.t2vModel;

  const res = await providerFetch(
    "higgsfield",
    `${cfg.baseUrl}/${model}`,
    { method: "POST", headers: headers(cfg, { "idempotency-key": randomUUID() }), body: JSON.stringify(body) },
    PROVIDER_TIMEOUTS.video,
  );
  await expectOk("higgsfield", res);
  const data = await readJsonBody<unknown>("higgsfield", res);

  const jobId = firstString(data, ID_PATHS);
  if (!jobId) {
    throw new ProviderRequestError("higgsfield", 502, `request accepted but no request_id in the response: ${shortText(JSON.stringify(data), 300)}`);
  }
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new ProviderRequestError("higgsfield", 502, `unexpected request id format: ${jobId}`);
  }
  return { jobId, provider: "higgsfield" };
}

export async function getVideoJob(jobId: string): Promise<{ status: VideoJobStatus; url?: string; error?: string }> {
  const cfg = higgsfieldConfig();
  const id = (jobId ?? "").trim();
  if (!JOB_ID_PATTERN.test(id)) throw new ProviderRequestError("higgsfield", 400, `invalid jobId "${id}"`);

  const res = await providerFetch(
    "higgsfield",
    `${cfg.baseUrl}/requests/${encodeURIComponent(id)}/status`,
    { method: "GET", headers: headers(cfg) },
    PROVIDER_TIMEOUTS.video,
  );
  if (res.status === 404) throw new ProviderRequestError("higgsfield", 404, `request ${id} not found (it may have expired at Higgsfield)`);
  await expectOk("higgsfield", res);
  const data = await readJsonBody<unknown>("higgsfield", res);

  const rawStatus = firstString(data, STATUS_PATHS);
  const url = firstString(data, URL_PATHS);
  const errorText = firstString(data, ERROR_PATHS);
  let status = normaliseStatus(rawStatus);

  // Infer when the vendor uses a status word that is not in the vocabulary above.
  if (!status) {
    if (url && /^https?:\/\//i.test(url)) status = "completed";
    else if (errorText && !rawStatus) status = "failed";
    else if (rawStatus) throw new ProviderRequestError("higgsfield", 502, `unknown request status "${rawStatus}": ${shortText(JSON.stringify(data), 300)}`);
    else status = "processing";
  }

  if (status === "completed") {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { status: "failed", error: `the request completed but the response has no video URL: ${shortText(JSON.stringify(data), 300)}` };
    }
    return { status, url };
  }
  if (status === "failed") {
    if (rawStatus?.toLowerCase() === "nsfw") {
      return { status, error: "Higgsfield's content filter rejected the prompt or the start image (nsfw). Rephrase the video prompt or use another image." };
    }
    return { status, error: errorText ?? `request ${id} failed (${rawStatus ?? "no reason given"})` };
  }
  return { status };
}
