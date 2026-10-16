/**
 * TikTok connector: Login Kit v2 (web flow) + Display API.
 *
 *   authorize    GET  https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope&redirect_uri&state
 *   code→token   POST https://open.tiktokapis.com/v2/oauth/token/   form: client_key, client_secret, code, grant_type=authorization_code, redirect_uri
 *   refresh      POST https://open.tiktokapis.com/v2/oauth/token/   form: client_key, client_secret, grant_type=refresh_token, refresh_token
 *   account      GET  https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name        (scope user.info.basic)
 *   posts        POST https://open.tiktokapis.com/v2/video/list/?fields=…   JSON body {max_count<=20, cursor}  (scope video.list)
 *
 * Env: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET from the TikTok developer portal (app page, "Client key" and
 * "Client secret"). The secret is only sent in the token POST body, never in a URL and never to the browser.
 *
 * Doc facts this file relies on (checked 2026-09-30, URLs in docs/CONNECTORS.md):
 *  - Access token lives 24 h (expires_in 86400), refresh token 365 days (refresh_expires_in 31536000). The refresh
 *    response carries a refresh_token that "may be different than the one passed in": callers MUST store the
 *    TokenSet that refresh() returns.
 *  - Web flow needs no PKCE (code_verifier is for mobile/desktop only). The redirect URI must be https, static
 *    (no query string or fragment) and registered in the portal.
 *  - Errors: the token endpoint answers {error, error_description, log_id}; the Display API answers
 *    {data, error:{code, message, log_id}} where error.code is "ok" on success.
 *  - /v2/video/list/ returns only PUBLIC videos, newest first; cursor is a UTC millisecond timestamp; has_more tells
 *    whether another page exists. view_count, like_count, comment_count and share_count come with the list, there is
 *    no saves or reach figure (both stay null). title and video_description are documented with a 150-character
 *    maximum, so long TikTok captions may arrive shortened.
 *  - user.info.basic gives display_name, not the @username (that needs user.info.profile), so `handle` holds the
 *    display name.
 */
import {
  ConnectorError,
  DEFAULT_POST_LIMIT,
  HOUR_MS,
  asNumber,
  asRecord,
  asString,
  asStringList,
  buildQuery,
  clampLimit,
  envValue,
  expiryFromSeconds,
  missingEnv,
  notConfiguredError,
  parseJsonBody,
  quoteBigIntegers,
  redactSecrets,
  sendRequest,
  shortText,
  toMillis,
  tryParseJson,
  type Connector,
  type ConnectorEnv,
  type FetchLike,
  type HttpResult,
  type NormalizedPost,
  type TokenSet,
} from "./types";

/** TikTok API generation; it is part of every URL path (…/v2/…), see developers.tiktok.com "TikTok API v2". */
export const TIKTOK_API_VERSION = "v2";

/** user.info.basic (open_id, display_name) and video.list (public videos with counts), as set in the portal. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.list"] as const;

/**
 * Scopes an operator can add on top with TIKTOK_EXTRA_SCOPES (comma separated, unknown names are ignored). Off by default, so the app
 * only holds read access until someone sets the variable. video.upload (draft in the creator's inbox) and video.publish (direct post)
 * are reserved for the planned publishing feature (nothing in the app publishes yet). A scope listed there must also be enabled for
 * the app in the TikTok developer portal (Content Posting API, Direct Post on), otherwise the authorize page refuses the request.
 */
export const TIKTOK_OPTIONAL_SCOPES = ["video.upload", "video.publish"] as const;

/** The scopes to request: the base set plus the optional ones named in TIKTOK_EXTRA_SCOPES. */
function requestedScopes(env: ConnectorEnv): string[] {
  const extra = (envValue(env, "TIKTOK_EXTRA_SCOPES") ?? "").split(/[,\s]+/).filter((s) => (TIKTOK_OPTIONAL_SCOPES as readonly string[]).includes(s));
  return [...new Set<string>([...TIKTOK_SCOPES, ...extra])];
}

const LABEL = "TikTok";
const REQUIRED_ENV = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] as const;

const AUTHORIZE_URL = `https://www.tiktok.com/${TIKTOK_API_VERSION}/auth/authorize/`;
const API_ROOT = `https://open.tiktokapis.com/${TIKTOK_API_VERSION}`;
const TOKEN_URL = `${API_ROOT}/oauth/token/`;
const USER_INFO_URL = `${API_ROOT}/user/info/`;
const VIDEO_LIST_URL = `${API_ROOT}/video/list/`;

/** Used only when the token response omits the lifetimes (documented: 24 h access token). */
const ACCESS_TOKEN_FALLBACK_SECONDS = 86_400;
/** Refresh when the access token is expired or has less than this left. */
const REFRESH_WINDOW_MS = HOUR_MS;

/** Documented maximum of max_count. */
const MAX_PAGE_SIZE = 20;
const MAX_PAGES_SLACK = 2;

const VIDEO_FIELDS = "id,title,video_description,share_url,create_time,view_count,like_count,comment_count,share_count,duration";

/** Error codes after which only the account owner connecting again helps. */
const RECONNECT_CODES = new Set([
  "invalid_grant", // authorization code or refresh token expired, revoked or already used
  "access_denied",
  "unauthorized_client",
  "scope_not_authorized", // user did not grant a required scope
  "scope_permission_missed",
]);

/** Error codes that are worth retrying later. */
const RETRYABLE_CODES = new Set(["rate_limit_exceeded", "internal_error", "server_error", "temporarily_unavailable"]);

// ---------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------

/**
 * Maps a failed (or "ok"-less) response to a ConnectorError. Display API bodies carry {error:{code,message,log_id}},
 * the OAuth token endpoint {error,error_description,log_id}.
 */
function tiktokFailure(
  res: Pick<HttpResult, "status" | "text">,
  label: string,
  secrets: readonly (string | undefined)[],
): ConnectorError {
  const root = asRecord(tryParseJson(res.text));
  const nested = asRecord(root?.error);
  let code: string | undefined;
  let message: string | undefined;
  let logId: string | undefined;
  if (nested) {
    code = asString(nested.code);
    message = asString(nested.message);
    logId = asString(nested.log_id);
  } else if (root) {
    code = asString(root.error);
    message = asString(root.error_description) ?? asString(root.message);
    logId = asString(root.log_id);
  }

  const reconnect = code !== undefined && RECONNECT_CODES.has(code);
  const retryable = !reconnect && ((code !== undefined && RETRYABLE_CODES.has(code)) || res.status === 408 || res.status === 429 || res.status >= 500);

  const detail = message ? redactSecrets(shortText(message), secrets) : shortText(redactSecrets(res.text, secrets), 160);
  const codeText = code ? `, ${code}` : "";
  const logText = logId ? ` [log_id ${logId}]` : "";
  return new ConnectorError(`${label} failed (HTTP ${res.status}${codeText}): ${detail || "no details"}${logText}`, {
    status: res.status,
    code: code ?? `http_${res.status}`,
    retryable,
    reconnect,
  });
}

/**
 * Parses a response that must be a success: non-2xx, an OAuth {error:"…"} body and a Display API error.code other
 * than "ok" all become ConnectorErrors (TikTok can answer 200 with an error body).
 */
function tiktokJson(
  res: HttpResult,
  label: string,
  secrets: readonly (string | undefined)[],
  opts: { prepare?: (text: string) => string; tokenBody?: boolean } = {},
): unknown {
  if (!res.ok) throw tiktokFailure(res, label, secrets);
  const json = parseJsonBody(opts.prepare ? opts.prepare(res.text) : res.text, label, res.status, {
    secrets,
    showBody: opts.tokenBody !== true,
  });
  const root = asRecord(json);
  const nested = asRecord(root?.error);
  const apiError = nested !== null && asString(nested.code) !== undefined && asString(nested.code) !== "ok";
  const oauthError = root !== null && typeof root.error === "string" && root.error !== "";
  if (apiError || oauthError) throw tiktokFailure(res, label, secrets);
  return json;
}

function credentials(env: ConnectorEnv): { clientKey: string; clientSecret: string } {
  const clientKey = envValue(env, "TIKTOK_CLIENT_KEY");
  const clientSecret = envValue(env, "TIKTOK_CLIENT_SECRET");
  if (!clientKey || !clientSecret) throw notConfiguredError(LABEL, missingEnv(REQUIRED_ENV, env));
  return { clientKey, clientSecret };
}

// ---------------------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------------------

function authorizeUrl(p: { redirectUri: string; state: string; forceReauth?: boolean }, env: ConnectorEnv): string {
  // Both values are required up front: a missing secret would only surface after the owner has already approved.
  const { clientKey } = credentials(env);
  if (!p.redirectUri.trim()) {
    throw new ConnectorError(`${LABEL} authorize: redirectUri is empty`, { code: "invalid_request", retryable: false });
  }
  if (!p.state.trim()) {
    throw new ConnectorError(`${LABEL} authorize: state is empty (it protects the callback against forged requests)`, {
      code: "invalid_request",
      retryable: false,
    });
  }
  const params: Record<string, string> = {
    client_key: clientKey,
    response_type: "code",
    scope: requestedScopes(env).join(","),
    redirect_uri: p.redirectUri,
    state: p.state,
  };
  // disable_auto_auth=1 makes TikTok show the authorization page instead of silently reusing an earlier approval.
  if (p.forceReauth) params.disable_auto_auth = "1";
  return `${AUTHORIZE_URL}?${buildQuery(params, ["scope"])}`;
}

type TokenGrant = {
  accessToken: string;
  refreshToken: string | null;
  openId: string | null;
  expiresAt: Date;
  scopes: string[];
};

/** POST /v2/oauth/token/ (form-encoded, as documented) for either grant type. */
async function requestToken(
  fields: Record<string, string>,
  label: string,
  secrets: readonly (string | undefined)[],
  f: FetchLike,
): Promise<TokenGrant> {
  const res = await sendRequest(
    f,
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cache-control": "no-cache",
        accept: "application/json",
      },
      body: new URLSearchParams(fields).toString(),
    },
    { label, secrets },
  );
  const rec = asRecord(tiktokJson(res, label, secrets, { tokenBody: true }));
  const accessToken = rec ? asString(rec.access_token) : undefined;
  if (!rec || !accessToken) {
    throw new ConnectorError(`${label}: the response has no access_token`, { status: res.status, code: "parse", retryable: false });
  }
  return {
    accessToken,
    refreshToken: asString(rec.refresh_token) ?? null,
    openId: asString(rec.open_id) ?? null,
    expiresAt: expiryFromSeconds(asNumber(rec.expires_in), ACCESS_TOKEN_FALLBACK_SECONDS),
    scopes: asStringList(rec.scope),
  };
}

/** GET /v2/user/info/: open_id and display name of the token's user. */
async function fetchUser(accessToken: string, f: FetchLike): Promise<{ openId: string | null; displayName: string | null }> {
  const label = `${LABEL} account lookup`;
  const secrets = [accessToken];
  const res = await sendRequest(
    f,
    `${USER_INFO_URL}?${buildQuery({ fields: "open_id,display_name" }, ["fields"])}`,
    { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    { label, secrets },
  );
  const root = asRecord(tiktokJson(res, label, secrets));
  const user = asRecord(asRecord(root?.data)?.user);
  return {
    openId: (user && asString(user.open_id)) || null,
    displayName: (user && asString(user.display_name)?.trim().replace(/^@/, "")) || null,
  };
}

async function exchangeCode(p: { code: string; redirectUri: string }, f: FetchLike, env: ConnectorEnv): Promise<TokenSet> {
  const { clientKey, clientSecret } = credentials(env);
  // The code arrives URL-encoded in the callback; callers pass it decoded (URLSearchParams.get does that) and it is
  // encoded exactly once when the form body is built.
  const code = p.code.trim();
  if (!code) throw new ConnectorError(`${LABEL} code exchange: code is empty`, { code: "invalid_request", retryable: false });

  const grant = await requestToken(
    {
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: p.redirectUri,
    },
    `${LABEL} code exchange`,
    [clientSecret, code],
    f,
  );

  let displayName: string | null = null;
  let openIdFromUser: string | null = null;
  try {
    const user = await fetchUser(grant.accessToken, f);
    displayName = user.displayName;
    openIdFromUser = user.openId;
  } catch (err) {
    // The display name is nice to have; open_id from the token response is what matters.
    if (!(err instanceof ConnectorError) || grant.openId === null) throw err;
  }
  const externalId = grant.openId ?? openIdFromUser;
  if (!externalId) {
    throw new ConnectorError(`${LABEL} code exchange: the response carried no open_id`, { code: "parse", retryable: false });
  }
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    externalId,
    handle: displayName,
    scopes: grant.scopes.length > 0 ? grant.scopes : requestedScopes(env),
  };
}

async function refresh(t: TokenSet, f: FetchLike, env: ConnectorEnv): Promise<TokenSet> {
  const { clientKey, clientSecret } = credentials(env);
  if (!t.refreshToken) {
    throw new ConnectorError(`${LABEL} token refresh: this account has no refresh token, connect it again`, {
      code: "no_refresh_token",
      reconnect: true,
      retryable: false,
    });
  }
  const grant = await requestToken(
    { client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: t.refreshToken },
    `${LABEL} token refresh`,
    [clientSecret, t.refreshToken, t.accessToken],
    f,
  );
  return {
    ...t,
    accessToken: grant.accessToken,
    // TikTok may hand out a new refresh token with every refresh; the old one can stop working.
    refreshToken: grant.refreshToken ?? t.refreshToken,
    expiresAt: grant.expiresAt,
    scopes: grant.scopes.length > 0 ? grant.scopes : t.scopes,
  };
}

function needsRefresh(t: TokenSet, now: Date): boolean {
  const expires = toMillis(t.expiresAt);
  if (expires === null) return true; // access tokens only live 24 h, so an unknown expiry is refreshed to be safe
  return expires - now.getTime() <= REFRESH_WINDOW_MS;
}

// ---------------------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------------------

/** share_url carries tracking parameters (utm_*); the permalink is the same address without query and fragment. */
function canonicalUrl(shareUrl: string | undefined, id: string): string {
  if (shareUrl) {
    try {
      const url = new URL(shareUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // fall through to the embed address
    }
  }
  return `https://www.tiktok.com/embed/v2/${id}`;
}

function readVideo(raw: unknown): NormalizedPost | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const created = asNumber(rec.create_time);
  if (!id || created === undefined || created <= 0) return null;
  const description = typeof rec.video_description === "string" ? rec.video_description.trim() : "";
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  return {
    externalId: id,
    url: canonicalUrl(asString(rec.share_url), id),
    publishedAt: new Date(created * 1000), // create_time is a UTC Unix timestamp in seconds
    format: "Video",
    caption: description.length >= title.length ? description : title,
    views: asNumber(rec.view_count) ?? null,
    likes: asNumber(rec.like_count) ?? null,
    comments: asNumber(rec.comment_count) ?? null,
    shares: asNumber(rec.share_count) ?? null,
    saves: null, // not reported by the Display API
    reach: null, // not reported by the Display API
  };
}

async function fetchPosts(t: TokenSet, opts: { since?: Date; limit?: number }, f: FetchLike): Promise<NormalizedPost[]> {
  if (!t.accessToken) {
    throw new ConnectorError(`${LABEL} posts: the account has no access token`, { code: "invalid_request", reconnect: true, retryable: false });
  }
  const label = `${LABEL} video list`;
  const secrets = [t.accessToken];
  const limit = clampLimit(opts.limit, DEFAULT_POST_LIMIT);
  const sinceMs = toMillis(opts.since);
  const maxPages = Math.ceil(limit / MAX_PAGE_SIZE) + MAX_PAGES_SLACK;

  const posts: NormalizedPost[] = [];
  const seen = new Set<string>();
  let cursor: number | undefined;
  let done = false;

  for (let page = 0; page < maxPages && !done; page += 1) {
    const body: Record<string, number> = { max_count: Math.min(MAX_PAGE_SIZE, limit - posts.length) };
    if (cursor !== undefined) body.cursor = cursor;
    const res = await sendRequest(
      f,
      `${VIDEO_LIST_URL}?${buildQuery({ fields: VIDEO_FIELDS }, ["fields"])}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${t.accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      { label, secrets },
    );
    const root = asRecord(tiktokJson(res, label, secrets, { prepare: (text) => quoteBigIntegers(text, ["id"]) }));
    const data = asRecord(root?.data);
    const videos = data && Array.isArray(data.videos) ? data.videos : [];

    for (const raw of videos) {
      const post = readVideo(raw);
      if (!post || seen.has(post.externalId)) continue;
      seen.add(post.externalId);
      if (sinceMs !== null && post.publishedAt.getTime() < sinceMs) {
        done = true; // newest first: everything after this video is older still
        break;
      }
      posts.push(post);
      if (posts.length >= limit) {
        done = true;
        break;
      }
    }

    const nextCursor = data ? asNumber(data.cursor) : undefined;
    if (data?.has_more !== true || nextCursor === undefined || nextCursor === cursor) done = true;
    else cursor = nextCursor;
  }

  return posts.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

// ---------------------------------------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------------------------------------

export const tiktokConnector: Connector = {
  platform: "tiktok",
  label: LABEL,
  requiredEnv: REQUIRED_ENV,
  isConfigured(env = process.env) {
    return missingEnv(REQUIRED_ENV, env).length === 0;
  },
  authorizeUrl(p, env = process.env) {
    return authorizeUrl(p, env);
  },
  exchangeCode(p, f = fetch, env = process.env) {
    return exchangeCode(p, f, env);
  },
  refresh(t, f = fetch, env = process.env) {
    return refresh(t, f, env);
  },
  needsRefresh(t, now = new Date()) {
    return needsRefresh(t, now);
  },
  fetchPosts(t, opts = {}, f = fetch) {
    return fetchPosts(t, opts, f);
  },
};
