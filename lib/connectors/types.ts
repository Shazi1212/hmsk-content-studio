/**
 * Connector contract for the official platform APIs, plus the few helpers both connectors share.
 *
 *   Instagram  "Instagram API with Instagram Login" (Business Login for Instagram)   ./instagram.ts
 *   TikTok     Login Kit v2 + Display API                                             ./tiktok.ts
 *
 * One OAuth "Connect" click per social account yields a long-lived credential (TokenSet). After that the weekly
 * sync calls refresh() when needsRefresh() says so and fetchPosts() to pull the account's own posts with metrics
 * (NormalizedPost, the same shape for every platform).
 *
 * Server-only: client secrets and tokens must never reach the browser. Connectors read their configuration from
 * process.env at call time (the `env` parameter exists so tests can inject values), reach the platforms with the
 * global `fetch` (injectable as `f`) and report every problem as a ConnectorError. Error messages never contain a
 * token or a secret, so callers may show `error.message` to the owner verbatim.
 */
import { clip } from "@/lib/text";

export type FetchLike = typeof fetch;
export type ConnectorPlatform = "instagram" | "tiktok";
/** Environment lookup used for configuration; tests pass their own object instead of process.env. */
export type ConnectorEnv = Record<string, string | undefined>;

/** Credentials of one connected account, as stored (encrypted) by the app. */
export type TokenSet = {
  accessToken: string;
  refreshToken?: string | null;
  /** When the access token stops working (absolute time); null/undefined = unknown. */
  expiresAt?: Date | null;
  /** Provider account id: Instagram user id, TikTok open_id. */
  externalId: string;
  /** Display handle without "@" when known. */
  handle?: string | null;
  scopes?: string[];
};

/** One published post normalised across platforms. Metrics are null when the platform does not report them for this post. */
export type NormalizedPost = {
  externalId: string;
  url: string; // canonical public permalink
  publishedAt: Date;
  format: string; // human label: "Reel", "Carousel", "Static image", "Video" ...
  caption: string; // full caption / description text ("" when none)
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
};

export type ConnectorErrorInit = {
  /** HTTP status, or 0 when no response was received. */
  status?: number;
  /** Provider error code/type, or "network" | "parse" | "not_configured" | "invalid_request". */
  code?: string;
  /** Defaults to true for network errors, 408, 429 and 5xx. */
  retryable?: boolean;
  /** True when only the account owner can fix it by clicking Connect again (token expired/revoked, scope missing). */
  reconnect?: boolean;
  /** Provider sub-code when there is one (Graph API `error_subcode`). */
  subcode?: string | null;
};

/** status = HTTP status or 0; code = provider error code/type or "network" | "parse"; never contains tokens or secrets. */
export class ConnectorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** Extension: true when the account has to be connected again (see ConnectorErrorInit.reconnect). */
  readonly reconnect: boolean;
  /** Extension: provider sub-code, null when none. */
  readonly subcode: string | null;

  constructor(message: string, init: ConnectorErrorInit = {}) {
    super(message);
    this.name = "ConnectorError";
    this.status = init.status ?? 0;
    this.code = init.code ?? "error";
    this.retryable = init.retryable ?? isRetryableStatus(this.status);
    this.reconnect = init.reconnect ?? false;
    this.subcode = init.subcode ?? null;
  }
}

/** instanceof plus a name check, because dev-server hot reloads can load this module twice. */
export function isConnectorError(err: unknown): err is ConnectorError {
  return (
    err instanceof ConnectorError ||
    (err instanceof Error && err.name === "ConnectorError" && typeof (err as { code?: unknown }).code === "string")
  );
}

export interface Connector {
  readonly platform: ConnectorPlatform;
  readonly label: string; // "Instagram", "TikTok"
  /** Names of the env vars this connector needs (for "not configured" hints). */
  readonly requiredEnv: readonly string[];
  isConfigured(env?: Record<string, string | undefined>): boolean;
  /**
   * Extension: `forceReauth` makes the platform show its login/consent screen even when the browser is already
   * signed in (use it when connecting a second account from the same browser).
   */
  authorizeUrl(
    p: { redirectUri: string; state: string; forceReauth?: boolean },
    env?: Record<string, string | undefined>,
  ): string;
  exchangeCode(
    p: { code: string; redirectUri: string },
    f?: FetchLike,
    env?: Record<string, string | undefined>,
  ): Promise<TokenSet>;
  /** Extends or renews the token; returns the new TokenSet (keep externalId/handle). Persist the result: TikTok rotates refresh tokens. */
  refresh(t: TokenSet, f?: FetchLike, env?: Record<string, string | undefined>): Promise<TokenSet>;
  /** True when the token should be refreshed now (Instagram: older than 24 h and expiring soon; TikTok: expired or expiring within 1 hour). */
  needsRefresh(t: TokenSet, now?: Date): boolean;
  /**
   * Newest-first posts of the authenticated account, at most `limit` (default 50), optionally only those published
   * at/after `since`. Handles pagination and per-post insight calls; one failing insight call must not fail the whole
   * sync (those metrics stay null). Extension: `onWarning` receives one summary line when metrics were skipped
   * (default: console.warn), so a silent gap in the data can be surfaced in the UI.
   */
  fetchPosts(
    t: TokenSet,
    opts?: { since?: Date; limit?: number; onWarning?: (message: string) => void },
    f?: FetchLike,
  ): Promise<NormalizedPost[]>;
}

// ---------------------------------------------------------------------------------------------------------
// Shared helpers (used by ./instagram.ts and ./tiktok.ts)
// ---------------------------------------------------------------------------------------------------------

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const DEFAULT_TIMEOUT_MS = 20_000;
/** Posts returned when the caller does not pass a limit. */
export const DEFAULT_POST_LIMIT = 50;
const MAX_POST_LIMIT = 500;

export type JsonRecord = Record<string, unknown>;
type SecretList = readonly (string | null | undefined)[];

/** 0 (no response), 408, 429 and 5xx are worth retrying later; everything else needs a human or a code change. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** Trimmed env value, or undefined when unset/blank. */
export function envValue(env: ConnectorEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/** Names from `names` that are unset or blank in `env`. */
export function missingEnv(names: readonly string[], env: ConnectorEnv = process.env): string[] {
  return names.filter((name) => envValue(env, name) === undefined);
}

/** Same wording as the provider adapters' "not configured" message; callers may show it to the owner. */
export function notConfiguredError(label: string, names: readonly string[]): ConnectorError {
  return new ConnectorError(
    `${label} is not configured. Set ${names.join(" and ")} in the app's environment variables (.env file or the container environment).`,
    { status: 0, code: "not_configured", retryable: false },
  );
}

/** Collapses whitespace and truncates to `max` characters. */
export function shortText(text: string, max = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${clip(collapsed, max)}…` : collapsed;
}

/**
 * Removes the given secret values and anything that looks like a token or a credential parameter from `text`.
 * Every message that embeds provider output goes through this before it becomes an Error message.
 */
export function redactSecrets(text: string, secrets: SecretList = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(
    /([?&](?:access_token|refresh_token|client_secret|client_key|code|token|fb_exchange_token)=)[^&\s"'<>]+/gi,
    "$1[redacted]",
  );
  out = out.replace(/("(?:access_token|refresh_token|client_secret|token)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");
  out = out.replace(/\b(?:IG[A-Za-z0-9_-]{2}|EAA)[A-Za-z0-9_-]{30,}/g, "[redacted]");
  out = out.replace(/\b(?:act|rft)\.[A-Za-z0-9._-]{20,}/g, "[redacted]");
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? err.cause.message : err.message;
  return String(err);
}

export type HttpResult = { status: number; ok: boolean; text: string; headers: Headers };

/**
 * `fetch` with a timeout. Network failures, timeouts and unreadable bodies become ConnectorError(status 0, code
 * "network", retryable). HTTP error statuses are NOT thrown here: the caller maps them with its provider's error
 * format.
 */
export async function sendRequest(
  f: FetchLike,
  url: string,
  init: RequestInit,
  opts: { label: string; timeoutMs?: number; secrets?: SecretList },
): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-store: Next.js must never serve a cached answer for a token or a metrics call.
    const res = await f(url, { cache: "no-store", ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const seconds = timeoutMs >= 1000 ? String(Math.round(timeoutMs / 1000)) : (timeoutMs / 1000).toFixed(1);
      throw new ConnectorError(`${opts.label}: timed out after ${seconds} s`, {
        status: 0,
        code: "network",
        retryable: true,
      });
    }
    throw new ConnectorError(`${opts.label}: network error: ${redactSecrets(describeError(err), opts.secrets)}`, {
      status: 0,
      code: "network",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON.parse that throws ConnectorError(code "parse") instead of SyntaxError. The error message shows a short,
 * redacted excerpt of the body unless `showBody` is false (use that for token endpoints: a broken body there could
 * still contain a fresh token).
 */
export function parseJsonBody(
  text: string,
  label: string,
  status = 200,
  opts: { secrets?: SecretList; showBody?: boolean } = {},
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const excerpt = opts.showBody === false ? "" : redactSecrets(shortText(text, 80), opts.secrets);
    throw new ConnectorError(`${label}: the response was not valid JSON (${excerpt || "body not shown"})`, {
      status,
      code: "parse",
      retryable: false,
    });
  }
}

/** Best-effort parse for error bodies: undefined when the body is not JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** Non-blank string, else undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Finite number (numeric strings accepted), else undefined. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** "a,b" or ["a","b"] to ["a","b"]. */
export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Ids such as Instagram's 17-digit user ids exceed 2^53 (about 9.0e15), the largest integer a double holds exactly,
 * so a numeric id in a JSON body would be silently rounded by JSON.parse. Quotes such numbers under the given keys
 * before parsing; ids that already arrive as strings are untouched.
 */
export function quoteBigIntegers(text: string, keys: readonly string[]): string {
  const pattern = new RegExp(`("(?:${keys.join("|")})"\\s*:\\s*)(\\d{16,})(?=\\s*[,}\\]])`, "g");
  return text.replace(pattern, '$1"$2"');
}

/**
 * Query string from key/value pairs. Values are percent-encoded; commas stay literal in the listed keys (scope,
 * fields, metric) because the platforms' docs write those lists with plain commas, which is valid in a query string.
 */
export function buildQuery(params: Record<string, string>, literalCommaKeys: readonly string[] = []): string {
  return Object.entries(params)
    .map(([key, value]) => {
      const encoded = literalCommaKeys.includes(key)
        ? value.split(",").map(encodeURIComponent).join(",")
        : encodeURIComponent(value);
      return `${encodeURIComponent(key)}=${encoded}`;
    })
    .join("&");
}

/** Milliseconds since epoch of a Date (or date-like value); null when missing or invalid. */
export function toMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Absolute expiry for a token that lives `seconds` from now (fallback when the provider omitted it). */
export function expiryFromSeconds(seconds: number | undefined, fallbackSeconds: number, nowMs = Date.now()): Date {
  const s = seconds !== undefined && seconds > 0 ? seconds : fallbackSeconds;
  return new Date(nowMs + s * 1000);
}

/** Caller's `limit` clamped to 1..500, default 50. */
export function clampLimit(limit: number | undefined, fallback = DEFAULT_POST_LIMIT, max = MAX_POST_LIMIT): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

/** Runs `worker` over `items` with at most `limit` calls in flight; results keep the order of `items`. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Sends a warning to the caller's hook, or to the server log when there is none. */
export function emitWarning(hook: ((message: string) => void) | undefined, message: string): void {
  if (hook) hook(message);
  else console.warn(message);
}
