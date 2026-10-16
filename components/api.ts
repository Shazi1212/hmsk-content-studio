/**
 * Thin fetch wrapper for the app's own API routes. Errors carry the server's {error, hint} so the UI
 * can show actionable messages such as "Set GEMINI_API_KEY in the environment (.env)".
 */
import type { Brief } from "@/lib/types";
import type { IdeaBatchDTO, IdeasParams, IdeasResponse, IdeasStatus } from "@/lib/ideas/types";
import type {
  BrandInput,
  BrandRecord,
  AspectRatio,
  AssetKind,
  AssetPatch,
  BrandAsset,
  VideoAspectRatio,
  ConnectionsResponse,
  DraftGeneration,
  GenerateResponse,
  GenerationStatus,
  HistoryItem,
  MediaResult,
  OptionsResponse,
  ReferenceRow,
  SyncReportRow,
  VideoJobStatus,
  Voice,
} from "./types";

export class ApiError extends Error {
  status: number;
  hint?: string;
  raw?: string;
  constructor(message: string, status: number, hint?: string, raw?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
    this.raw = raw;
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Error) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return new ApiError(
      offline ? "You appear to be offline." : e.message || "Request failed.",
      0,
      offline ? "Reconnect and try again." : undefined,
    );
  }
  return new ApiError("Request failed.", 0);
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText || "Request failed"}`;
  let hint: string | undefined;
  let raw: string | undefined;
  const contentType = res.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === "string" && body.error) message = body.error;
      else if (typeof body.message === "string" && body.message) message = body.message;
      if (typeof body.hint === "string" && body.hint) hint = body.hint;
      if (typeof body.raw === "string" && body.raw) raw = body.raw;
      if (!hint && body.issues) hint = JSON.stringify(body.issues).slice(0, 600);
      if (!hint && body.details) hint = typeof body.details === "string" ? body.details : JSON.stringify(body.details).slice(0, 600);
    } else {
      const text = (await res.text()).trim();
      if (text) message = text.slice(0, 400);
    }
  } catch {
    /* body was not readable; keep the status message */
  }
  if (res.status === 401) {
    message = "Your session has expired.";
    hint = "Sign in again to continue.";
  }
  // A proxy in front of the app (nginx on the host) answers 502/504 with an HTML page when the server takes too long.
  if ((res.status === 502 || res.status === 503 || res.status === 504) && !contentType.includes("application/json")) {
    message = `The server took too long to answer (${res.status}).`;
    hint = "The generation may have run too long for the host. Try again with 1 variant, a shorter length or a faster model.";
  }
  return new ApiError(message, res.status, hint, raw);
}

function redirectToLogin() {
  // Full navigation on purpose: the session cookie is gone, so client state must not survive.
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.replace("/login");
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch (e) {
    throw toApiError(e);
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 401) redirectToLogin();
    throw err;
  }
  return res;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("The server returned a response that is not JSON.", res.status, text.slice(0, 300));
  }
}

async function requestMedia(path: string, init?: RequestInit): Promise<MediaResult> {
  const res = await request(path, init);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // A 200 with JSON where bytes were expected: surface the message rather than a broken player.
    const body = (await res.json()) as Record<string, unknown>;
    throw new ApiError(
      typeof body.error === "string" ? body.error : "Expected media bytes but received JSON.",
      res.status,
      typeof body.hint === "string" ? body.hint : undefined,
    );
  }
  const hosted = res.headers.get("x-asset-url");
  const refsHeader = res.headers.get("x-references");
  const refs = refsHeader !== null && refsHeader.trim() !== "" ? Number(refsHeader) : NaN;
  const productHeader = res.headers.get("x-reference-products");
  const productRefs = productHeader !== null && productHeader.trim() !== "" ? Number(productHeader) : NaN;
  return {
    blob: await res.blob(),
    url: hosted && /^https?:\/\//i.test(hosted) ? hosted : null,
    provider: res.headers.get("x-provider"),
    references: Number.isFinite(refs) ? refs : null,
    productReferences: Number.isFinite(productRefs) ? productRefs : null,
  };
}

function isBrandAsset(value: unknown): value is BrandAsset {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.url === "string" && typeof v.label === "string";
}

/** A single asset, bare or wrapped as {asset}. */
function asAsset(value: unknown): BrandAsset {
  const inner = value && typeof value === "object" && "asset" in value ? (value as { asset: unknown }).asset : value;
  if (!isBrandAsset(inner)) throw new ApiError("The server returned an unexpected response for this photo.", 502, "Reload the page and check Brand assets.");
  return inner;
}

const assetsPath = (brandSlug: string, id?: string) => `/api/brands/${encodeURIComponent(brandSlug)}/assets${id ? `/${encodeURIComponent(id)}` : ""}`;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Servers may wrap lists; accept either a bare array or {items|generations|voices|data: []}. */
export function asList<T>(value: unknown, keys: string[] = ["items", "generations", "voices", "data", "results"]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of keys) if (Array.isArray(obj[k])) return obj[k] as T[];
  }
  return [];
}

export const api = {
  options: () => requestJson<OptionsResponse>("/api/options"),

  /** The researched posts behind the strategist (all brands, or one); filtering happens client-side. */
  references: async (brandSlug?: string) => {
    const data = await requestJson<unknown>(`/api/references${brandSlug ? `?brandSlug=${encodeURIComponent(brandSlug)}` : ""}`);
    return asList<ReferenceRow>(data, ["references"]);
  },

  // /api/generate streams a keep-alive and then one JSON document; a failure arrives in that document as {error, status}.
  generate: async (brief: Brief) => {
    const data = await requestJson<GenerateResponse | (Partial<GenerateResponse> & { error: string; hint?: string; raw?: string; status?: number })>(
      "/api/generate",
      json(brief),
    );
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && !("draft" in data)) {
      throw new ApiError(data.error, typeof data.status === "number" ? data.status : 502, data.hint, data.raw);
    }
    return data as GenerateResponse;
  },

  /** Official platform connections (Data sources panel): the accounts, what is configured, and sync. */
  connections: () => requestJson<ConnectionsResponse>("/api/connections"),
  disconnect: (id: string) => requestJson<unknown>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // /api/sync streams a keep-alive and then one JSON document; a failure arrives in it as {error, status}.
  sync: async (connectionId?: string) => {
    const data = await requestJson<{ reports: SyncReportRow[] } | { error: string; hint?: string; status?: number }>("/api/sync", json(connectionId ? { connectionId } : {}));
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && !("reports" in data)) {
      throw new ApiError(data.error, typeof data.status === "number" ? data.status : 502, data.hint);
    }
    return (data as { reports: SyncReportRow[] }).reports ?? [];
  },

  /** Ideas tab. POST streams a keep-alive and then one JSON document; a failure arrives in it as {error, status}. */
  ideas: {
    generate: async (params: IdeasParams) => {
      const data = await requestJson<IdeasResponse | { error: string; hint?: string; raw?: string; status?: number }>("/api/ideas", json(params));
      if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && !("batch" in data)) {
        throw new ApiError(data.error, typeof data.status === "number" ? data.status : 502, data.hint, data.raw);
      }
      return data as IdeasResponse;
    },
    list: async (params: { brandSlug?: string; source?: "manual" | "weekly"; limit?: number }) => {
      const q = new URLSearchParams();
      if (params.brandSlug) q.set("brandSlug", params.brandSlug);
      if (params.source) q.set("source", params.source);
      if (params.limit) q.set("limit", String(params.limit));
      const qs = q.toString();
      return asList<IdeaBatchDTO>(await requestJson<unknown>(`/api/ideas${qs ? `?${qs}` : ""}`), ["batches"]);
    },
    remove: (id: string) => requestJson<unknown>(`/api/ideas/${encodeURIComponent(id)}`, { method: "DELETE" }),
    status: (probe = false) => requestJson<IdeasStatus>(`/api/ideas/status${probe ? "?probe=1" : ""}`),
  },

  saveGeneration: (draft: DraftGeneration, status: "draft" | "approved", notes?: string) =>
    requestJson<HistoryItem>("/api/generations", json({ draft, status, notes: notes || undefined })),

  listGenerations: async (params: { brandSlug?: string; status?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.brandSlug) q.set("brandSlug", params.brandSlug);
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    const data = await requestJson<unknown>(`/api/generations${qs ? `?${qs}` : ""}`);
    return asList<HistoryItem>(data);
  },

  patchGeneration: (
    id: string,
    patch: { status?: GenerationStatus; notes?: string; audioUrl?: string; videoUrl?: string; imageUrl?: string; imageUrls?: string[]; imageProvider?: string },
  ) =>
    requestJson<HistoryItem>(`/api/generations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),

  deleteGeneration: (id: string) =>
    requestJson<unknown>(`/api/generations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  audio: (text: string, voiceId?: string) =>
    requestMedia("/api/audio", json({ text, voiceId: voiceId || undefined })),

  voices: async () => {
    const data = await requestJson<unknown>("/api/audio/voices");
    return asList<Voice>(data).filter((v) => v && typeof v.voiceId === "string");
  },

  createVideo: (p: { prompt: string; imageUrl?: string; durationSeconds?: number; aspectRatio?: VideoAspectRatio }) =>
    requestJson<{ jobId: string }>("/api/video", json(p)),

  videoStatus: (jobId: string) => requestJson<VideoJobStatus>(`/api/video/${encodeURIComponent(jobId)}`),

  /**
   * Key visuals, slides and video start frames. Reference photos: omit both `referenceIds` and `references` to use the brand's default
   * assets; pass `referenceIds` to send exactly those assets; pass `references: false` to send none.
   */
  image: (prompt: string, aspectRatio?: AspectRatio, opts?: { brandSlug?: string; references?: boolean; referenceIds?: string[] }) =>
    requestMedia("/api/image", json({ prompt, aspectRatio, brandSlug: opts?.brandSlug, references: opts?.references, referenceIds: opts?.referenceIds })),

  /** Brand assets tab: the reference photos of a brand (logo, product, packaging, people, mood). */
  assets: {
    list: async (brandSlug: string) => {
      const data = await requestJson<unknown>(assetsPath(brandSlug));
      return asList<unknown>(data, ["assets"]).filter(isBrandAsset);
    },
    /** Multipart upload; the file should already be downscaled (the host's proxy may reject large bodies). */
    upload: async (brandSlug: string, p: { file: Blob; filename: string; kind: AssetKind; label: string; isDefault: boolean }) => {
      const form = new FormData();
      form.append("file", p.file, p.filename);
      form.append("kind", p.kind);
      form.append("label", p.label);
      form.append("isDefault", p.isDefault ? "true" : "false");
      try {
        return asAsset(await requestJson<unknown>(assetsPath(brandSlug), { method: "POST", body: form }));
      } catch (e) {
        // The proxy in front of the app answers an oversized body with an HTML 413 page.
        if (e instanceof ApiError && e.status === 413) throw new ApiError("File too large for the server, try a smaller image", 413);
        throw e;
      }
    },
    update: async (brandSlug: string, id: string, patch: AssetPatch) =>
      asAsset(
        await requestJson<unknown>(assetsPath(brandSlug, id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    remove: (brandSlug: string, id: string) => requestJson<{ ok: boolean }>(assetsPath(brandSlug, id), { method: "DELETE" }),
  },

  brands: {
    list: async () => (await requestJson<{ brands: BrandRecord[] }>("/api/brands")).brands,
    create: (input: BrandInput) => requestJson<BrandRecord>("/api/brands", json(input)),
    update: (slug: string, input: BrandInput) =>
      requestJson<BrandRecord>(`/api/brands/${encodeURIComponent(slug)}`, { ...json(input), method: "PUT" }),
    remove: (slug: string) => requestJson<{ ok: boolean }>(`/api/brands/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  },

  logout: () => requestJson<unknown>("/api/logout", { method: "POST" }),
};
