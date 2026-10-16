/**
 * Instagram connector: "Instagram API with Instagram Login" (Instagram Platform, Business Login for Instagram).
 *
 * Works for Instagram professional accounts (Business or Creator); no Facebook Page is involved. While the Meta app
 * is in development mode (no App Review) every account must have a role on the app: add it as "Instagram Tester"
 * and accept the invitation inside Instagram.
 *
 *   authorize    GET  https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state
 *   code→token   POST https://api.instagram.com/oauth/access_token          form: client_id, client_secret, grant_type=authorization_code, redirect_uri, code
 *                                                                           → short-lived token (1 h), code is valid 1 h and single use
 *   long-lived   GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token     → 60 days
 *   refresh      GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token
 *                     (token must be at least 24 h old and not expired; every refresh gives 60 more days)
 *   account      GET  https://graph.instagram.com/v25.0/me?fields=user_id,username
 *   posts        GET  https://graph.instagram.com/v25.0/me/media?fields=…&limit&after      (newest first, stories excluded by the API)
 *   insights     GET  https://graph.instagram.com/v25.0/{media-id}/insights?metric=views,reach,saved,shares,likes
 *
 * Env: INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET, the "Instagram app ID / secret" under App Dashboard → Instagram →
 * API setup with Instagram login (NOT the Meta app id/secret from Settings → Basic). The secret only ever leaves the
 * server in the code-exchange POST body and the long-lived exchange request.
 *
 * Doc facts this file relies on (checked 2026-09-30, URLs in docs/CONNECTORS.md) and quirks it tolerates:
 *  - Scopes: instagram_business_basic (profile + media) and instagram_business_manage_insights (media insights).
 *  - The code-exchange response is documented as {"data":[{access_token,user_id,permissions}]}; a flat body with a
 *    NUMERIC user_id (the shape of the retired Basic Display API) is accepted too, and 17-digit ids are kept as
 *    exact strings because they do not fit a double.
 *  - The IG Media reference marks `caption` and `media_product_type` "Available for Instagram API with Facebook Login
 *    only". They are requested first anyway; on HTTP 400 the field list shrinks, and absent values are tolerated
 *    (caption "", Reels then recognised by their /reel/ permalink).
 *  - Insights: `views` replaced impressions/plays/video_views (deprecated), "Empty data returned instead of 0 when
 *    requested insights unavailable", and album children have no insights. Unsupported metrics fail the whole call
 *    with HTTP 400 / code 100, hence the metric ladder below.
 */
import {
  ConnectorError,
  DAY_MS,
  DEFAULT_POST_LIMIT,
  asNumber,
  asRecord,
  asString,
  asStringList,
  buildQuery,
  clampLimit,
  emitWarning,
  envValue,
  expiryFromSeconds,
  isConnectorError,
  mapWithConcurrency,
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
  type JsonRecord,
  type NormalizedPost,
  type TokenSet,
} from "./types";

/**
 * Graph API version for every graph.instagram.com call that takes one. v25.0 is the version used in all example
 * requests of the Instagram Platform docs (get-started, /me, insights; checked 2026-09-30). Graph API v26.0 was
 * released 2026-07-29 and v25.0 stays available until 2028-07-29 (Graph API changelog), so there is no rush to move.
 * The token endpoints (access_token, refresh_access_token) are unversioned in the docs.
 */
export const INSTAGRAM_GRAPH_VERSION = "v25.0";

/** instagram_business_basic reads profile and media, instagram_business_manage_insights reads media insights. */
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"] as const;

/**
 * Scopes an operator can add on top with INSTAGRAM_EXTRA_SCOPES (comma separated, unknown names are ignored). Off by default, so the
 * app only holds read access until someone sets the variable. instagram_business_content_publish is reserved for the planned
 * publishing feature (nothing in the app publishes yet). A scope listed there must also be added to the Meta app's Instagram use case
 * (Use cases > Customize > Permissions and features), otherwise the authorize page refuses the request.
 */
export const INSTAGRAM_OPTIONAL_SCOPES = ["instagram_business_content_publish"] as const;

/** The scopes to request: the base set plus the optional ones named in INSTAGRAM_EXTRA_SCOPES. */
function requestedScopes(env: ConnectorEnv): string[] {
  const extra = (envValue(env, "INSTAGRAM_EXTRA_SCOPES") ?? "").split(/[,\s]+/).filter((s) => (INSTAGRAM_OPTIONAL_SCOPES as readonly string[]).includes(s));
  return [...new Set<string>([...INSTAGRAM_SCOPES, ...extra])];
}
const INSIGHTS_SCOPE = "instagram_business_manage_insights";

const LABEL = "Instagram";
const REQUIRED_ENV = ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"] as const;

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_ROOT = "https://graph.instagram.com";
const GRAPH_URL = `${GRAPH_ROOT}/${INSTAGRAM_GRAPH_VERSION}`;
const LONG_LIVED_URL = `${GRAPH_ROOT}/access_token`;
const REFRESH_URL = `${GRAPH_ROOT}/refresh_access_token`;

/** Long-lived tokens last 60 days; used only when the response omits expires_in. */
const LONG_LIVED_FALLBACK_SECONDS = 60 * 86_400;
/**
 * Refresh window. The docs allow a refresh any time after the token is 24 h old; the contract says "expiring within
 * ~10 days". 14 days, so a weekly scheduler gets a second chance if one run fails. (Remaining <= 14 days already
 * implies the token is older than 24 h, because a fresh or refreshed token has 60 days left.)
 */
const REFRESH_WINDOW_MS = 14 * DAY_MS;

const MAX_PAGE_SIZE = 50;
const INSIGHT_CONCURRENCY = 3;

/**
 * Media fields, richest first. On HTTP 400 on the first page the next, smaller set is tried (see the header about
 * `caption` and `media_product_type`).
 */
const MEDIA_FIELD_SETS: readonly string[] = [
  "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
  "id,caption,media_type,permalink,timestamp,like_count,comments_count",
  "id,media_type,permalink,timestamp,like_count,comments_count",
];

type InsightMetric = "views" | "reach" | "saved" | "shares" | "likes";

/**
 * Insight metric sets, richest first. Per the Insights reference all of them are valid for feed posts and Reels
 * (impressions, plays and video_views are deprecated and never requested). If a media type rejects one metric the
 * whole call fails with HTTP 400, so the next smaller set is tried; the last set is the safe minimum.
 */
const INSIGHT_SETS: readonly (readonly InsightMetric[])[] = [
  ["views", "reach", "saved", "shares", "likes"],
  ["views", "reach", "saved", "shares"],
  ["reach", "saved", "shares"],
];

/** Graph error subcodes for which a smaller metric set cannot help: 2108006 "Media posted before business account conversion", 33 object not loadable. */
const NO_SMALLER_SET_SUBCODES = new Set(["2108006", "33"]);

/** Graph error codes that mean "slow down": 4 app, 17 user, 32 page, 341 app limit, 613 custom, 800xx business use case. */
function isRateLimitCode(numeric: number): boolean {
  return [4, 17, 32, 341, 613].includes(numeric) || (numeric >= 80000 && numeric < 80100);
}

function isRateLimitError(err: ConnectorError): boolean {
  return err.status === 429 || isRateLimitCode(Number(err.code));
}

/** After this many posts in a row without any insights the remaining insight calls are skipped (they would only fail too). */
const MAX_CONSECUTIVE_FAILURES = 5;

// ---------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------

function numberString(value: unknown): string | undefined {
  const n = asNumber(value);
  return n === undefined ? undefined : String(n);
}

/**
 * Maps a failed response to a ConnectorError. Two body shapes exist: Graph errors
 * {"error":{message,type,code,error_subcode}} and the older api.instagram.com shape
 * {"error_type":"OAuthException","code":400,"error_message":"…"} (code exchange).
 */
function instagramFailure(
  res: Pick<HttpResult, "status" | "text">,
  label: string,
  secrets: readonly (string | undefined)[],
  opts: { codeExchange?: boolean } = {},
): ConnectorError {
  const root = asRecord(tryParseJson(res.text));
  const graph = asRecord(root?.error);

  let message: string | undefined;
  let code: string | undefined;
  let subcode: string | undefined;
  let type: string | undefined;
  let legacyCode: string | undefined;
  if (graph) {
    message = asString(graph.message) ?? asString(graph.error_user_msg);
    code = numberString(graph.code);
    subcode = numberString(graph.error_subcode);
    type = asString(graph.type);
  } else if (root) {
    // api.instagram.com shape: its "code" just repeats the HTTP status, so the error type is the better identifier.
    message = asString(root.error_message) ?? asString(root.error_description) ?? asString(root.message);
    type = asString(root.error_type) ?? asString(root.error);
    legacyCode = numberString(root.code);
  }

  const numeric = code === undefined ? Number.NaN : Number(code);
  const expiredOrInvalidToken = numeric === 190 || res.status === 401;
  const missingPermission = numeric === 10 || (numeric >= 200 && numeric <= 299);
  // A rejected/expired authorization code means the owner has to click Connect again.
  const badAuthorizationCode = opts.codeExchange === true && type === "OAuthException";
  const rateLimited = res.status === 429 || isRateLimitCode(numeric);
  const temporary = numeric === 1 || numeric === 2;

  const reconnect = expiredOrInvalidToken || missingPermission || badAuthorizationCode;
  const retryable = !reconnect && (rateLimited || temporary || res.status === 408 || res.status >= 500);

  const detail = message ? redactSecrets(shortText(message), secrets) : shortText(redactSecrets(res.text, secrets), 160);
  const codeText = code ? `, code ${code}${subcode ? `/${subcode}` : ""}` : "";
  return new ConnectorError(`${label} failed (HTTP ${res.status}${codeText}): ${detail || "no details"}`, {
    status: res.status,
    code: code ?? type ?? legacyCode ?? `http_${res.status}`,
    subcode: subcode ?? null,
    retryable,
    reconnect,
  });
}

/** Parses a successful Graph response; a 2xx body that carries {"error":…} is still a failure. */
function graphJson(
  res: HttpResult,
  label: string,
  secrets: readonly (string | undefined)[],
  opts: { codeExchange?: boolean; prepare?: (text: string) => string; tokenBody?: boolean } = {},
): unknown {
  if (!res.ok) throw instagramFailure(res, label, secrets, opts);
  const json = parseJsonBody(opts.prepare ? opts.prepare(res.text) : res.text, label, res.status, {
    secrets,
    showBody: opts.tokenBody !== true,
  });
  const root = asRecord(json);
  if (root && asRecord(root.error) && root.data === undefined) throw instagramFailure(res, label, secrets, opts);
  return json;
}

// ---------------------------------------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------------------------------------

/** Instagram user ids have 17 digits: quote numeric ones before parsing so JSON.parse cannot round them. */
function quoteBigIds(text: string): string {
  return quoteBigIntegers(text, ["user_id", "id"]);
}

function idString(value: unknown): string | null {
  if (typeof value === "string") return /^\d{5,}$/.test(value.trim()) ? value.trim() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** {"data":[{…}]} (as documented), {"data":{…}} or a flat object: the object that carries the fields. */
function unwrap(json: unknown): JsonRecord | null {
  const root = asRecord(json);
  if (!root) return null;
  const data = root.data;
  if (Array.isArray(data)) return asRecord(data[0]);
  return asRecord(data) ?? root;
}

/** Graph timestamps look like 2026-05-01T12:34:56+0000 (offset without colon), which not every JS engine parses. */
function parseGraphTime(value: string | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function credentials(env: ConnectorEnv): { appId: string; appSecret: string } {
  const appId = envValue(env, "INSTAGRAM_APP_ID");
  const appSecret = envValue(env, "INSTAGRAM_APP_SECRET");
  if (!appId || !appSecret) throw notConfiguredError(LABEL, missingEnv(REQUIRED_ENV, env));
  return { appId, appSecret };
}

/** GET URL with the comma lists (scope, fields, metric) written the way the docs show them. */
function graphUrl(path: string, params: Record<string, string>): string {
  return `${path}?${buildQuery(params, ["scope", "fields", "metric"])}`;
}

// ---------------------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------------------

function authorizeUrl(
  p: { redirectUri: string; state: string; forceReauth?: boolean },
  env: ConnectorEnv,
): string {
  const { appId } = credentials(env);
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
    client_id: appId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: requestedScopes(env).join(","),
    state: p.state,
  };
  if (p.forceReauth) params.force_reauth = "true";
  return graphUrl(AUTHORIZE_URL, params);
}

type ShortLived = { accessToken: string; userId: string | null; permissions: string[] };

async function exchangeForShortLivedToken(
  p: { code: string; redirectUri: string },
  appId: string,
  appSecret: string,
  f: FetchLike,
): Promise<ShortLived> {
  // The redirect URL ends in "#_", which is not part of the code (docs: "strip it out").
  const code = p.code.trim().replace(/#_$/, "");
  if (!code) throw new ConnectorError(`${LABEL} code exchange: code is empty`, { code: "invalid_request", retryable: false });

  // The docs show the request as multipart form data (curl -F); mirror it exactly.
  const form = new FormData();
  form.set("client_id", appId);
  form.set("client_secret", appSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", p.redirectUri);
  form.set("code", code);

  const label = `${LABEL} code exchange`;
  const secrets = [appSecret, code];
  const res = await sendRequest(f, CODE_EXCHANGE_URL, { method: "POST", headers: { accept: "application/json" }, body: form }, { label, secrets });
  let json: unknown;
  try {
    json = graphJson(res, label, secrets, { codeExchange: true, prepare: quoteBigIds, tokenBody: true });
  } catch (err) {
    // "Error validating verification code ... redirect_uri" is Instagram's answer both to a different redirect address and to a wrong
    // secret. The two secrets of a Meta app look alike, and the one under Settings > Basic (the Meta app secret) is refused here.
    if (isConnectorError(err) && /verification code|redirect_uri/i.test(err.message)) {
      throw new ConnectorError(
        `Instagram refused the code. Usual cause: INSTAGRAM_APP_SECRET is not the "Instagram app secret" (Meta dashboard, Instagram, API setup with Instagram login, next to the Instagram app ID ${appId}); the app secret under Settings, Basic is refused. Redirect sent: ${p.redirectUri}. Instagram said: ${err.message}`,
        { status: err.status, code: err.code, retryable: false },
      );
    }
    throw err;
  }
  const fields = unwrap(json);
  const accessToken = fields ? asString(fields.access_token) : undefined;
  if (!fields || !accessToken) {
    throw new ConnectorError(`${label}: the response has no access_token`, { status: res.status, code: "parse", retryable: false });
  }
  return { accessToken, userId: idString(fields.user_id), permissions: asStringList(fields.permissions) };
}

async function exchangeForLongLivedToken(
  shortToken: string,
  appSecret: string,
  f: FetchLike,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const label = `${LABEL} long-lived token exchange`;
  const secrets = [appSecret, shortToken];
  const url = graphUrl(LONG_LIVED_URL, { grant_type: "ig_exchange_token", client_secret: appSecret, access_token: shortToken });
  const res = await sendRequest(f, url, { method: "GET", headers: { accept: "application/json" } }, { label, secrets });
  const fields = asRecord(graphJson(res, label, secrets, { tokenBody: true }));
  const accessToken = fields ? asString(fields.access_token) : undefined;
  if (!fields || !accessToken) {
    throw new ConnectorError(`${label}: the response has no access_token`, { status: res.status, code: "parse", retryable: false });
  }
  return { accessToken, expiresAt: expiryFromSeconds(asNumber(fields.expires_in), LONG_LIVED_FALLBACK_SECONDS) };
}

/** GET /me?fields=user_id,username: the account id (exact string) and the handle. */
async function fetchAccount(token: string, f: FetchLike): Promise<{ userId: string | null; username: string | null }> {
  const label = `${LABEL} account lookup`;
  const secrets = [token];
  const url = graphUrl(`${GRAPH_URL}/me`, { fields: "user_id,username", access_token: token });
  const res = await sendRequest(f, url, { method: "GET", headers: { accept: "application/json" } }, { label, secrets });
  const fields = unwrap(graphJson(res, label, secrets, { prepare: quoteBigIds }));
  return {
    userId: idString(fields?.user_id) ?? idString(fields?.id),
    username: (fields && asString(fields.username)?.replace(/^@/, "")) || null,
  };
}

async function exchangeCode(
  p: { code: string; redirectUri: string },
  f: FetchLike,
  env: ConnectorEnv,
): Promise<TokenSet> {
  const { appId, appSecret } = credentials(env);
  const short = await exchangeForShortLivedToken(p, appId, appSecret, f);
  const long = await exchangeForLongLivedToken(short.accessToken, appSecret, f);

  let account: { userId: string | null; username: string | null } = { userId: null, username: null };
  try {
    account = await fetchAccount(long.accessToken, f);
  } catch (err) {
    // The handle is nice to have. Without a safe account id from the code exchange either, there is nothing to store.
    if (!(err instanceof ConnectorError) || short.userId === null) throw err;
  }
  const externalId = account.userId ?? short.userId;
  if (!externalId) {
    throw new ConnectorError(`${LABEL} code exchange: the response carried no usable account id`, { code: "parse", retryable: false });
  }
  return {
    accessToken: long.accessToken,
    refreshToken: null, // Instagram has no refresh token: the long-lived token itself is renewed
    expiresAt: long.expiresAt,
    externalId,
    handle: account.username,
    scopes: short.permissions.length > 0 ? short.permissions : requestedScopes(env),
  };
}

async function refresh(t: TokenSet, f: FetchLike): Promise<TokenSet> {
  const label = `${LABEL} token refresh`;
  const secrets = [t.accessToken];
  const url = graphUrl(REFRESH_URL, { grant_type: "ig_refresh_token", access_token: t.accessToken });
  const res = await sendRequest(f, url, { method: "GET", headers: { accept: "application/json" } }, { label, secrets });
  const fields = asRecord(graphJson(res, label, secrets, { tokenBody: true }));
  const accessToken = fields ? asString(fields.access_token) : undefined;
  if (!fields || !accessToken) {
    throw new ConnectorError(`${label}: the response has no access_token`, { status: res.status, code: "parse", retryable: false });
  }
  return {
    ...t,
    accessToken,
    expiresAt: expiryFromSeconds(asNumber(fields.expires_in), LONG_LIVED_FALLBACK_SECONDS),
  };
}

function needsRefresh(t: TokenSet, now: Date): boolean {
  const expires = toMillis(t.expiresAt);
  if (expires === null) return false; // unknown expiry: a refresh of a token younger than 24 h would only fail
  return expires - now.getTime() <= REFRESH_WINDOW_MS;
}

// ---------------------------------------------------------------------------------------------------------
// Posts and insights
// ---------------------------------------------------------------------------------------------------------

type MediaItem = {
  id: string;
  caption: string;
  mediaType: string;
  productType: string | null;
  permalink: string;
  publishedAt: Date;
  likeCount: number | null;
  commentsCount: number | null;
};

type InsightValues = Partial<Record<InsightMetric, number>>;

function readMediaItem(raw: unknown): MediaItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const permalink = asString(rec.permalink);
  const publishedAt = parseGraphTime(asString(rec.timestamp));
  if (!id || !permalink || !publishedAt) return null;
  return {
    id,
    caption: typeof rec.caption === "string" ? rec.caption : "",
    mediaType: (asString(rec.media_type) ?? "").toUpperCase(),
    productType: asString(rec.media_product_type)?.toUpperCase() ?? null,
    permalink,
    publishedAt,
    likeCount: asNumber(rec.like_count) ?? null,
    commentsCount: asNumber(rec.comments_count) ?? null,
  };
}

/** REELS -> "Reel", CAROUSEL_ALBUM -> "Carousel", IMAGE -> "Static image", other VIDEO -> "Video". */
function formatLabel(item: MediaItem): string {
  if (item.productType === "REELS" || item.mediaType === "REELS") return "Reel";
  if (item.mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (item.mediaType === "IMAGE") return "Static image";
  if (item.mediaType === "VIDEO") {
    // Without media_product_type (Facebook-Login-only field per the docs) a Reel is still recognisable by its URL.
    return item.productType === null && /\/reels?\//i.test(item.permalink) ? "Reel" : "Video";
  }
  return "Post";
}

/** The `after` cursor inside a paging.next URL (used only when paging.cursors is missing); the URL itself is never requested. */
function afterFromNextUrl(next: string): string | undefined {
  try {
    return new URL(next).searchParams.get("after") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Newest-first media of the token's account: at most `limit`, none older than `since`, stories skipped. */
async function listMedia(t: TokenSet, limit: number, since: Date | undefined, f: FetchLike): Promise<MediaItem[]> {
  const label = `${LABEL} media list`;
  const secrets = [t.accessToken];
  const sinceMs = toMillis(since);
  const pageSize = Math.min(limit, MAX_PAGE_SIZE);
  const maxPages = Math.ceil(limit / pageSize) + 2;

  const items: MediaItem[] = [];
  const seen = new Set<string>();
  let fieldLevel = 0;
  let after: string | undefined;
  let done = false;

  for (let page = 0; page < maxPages && !done; page += 1) {
    let json: unknown;
    for (;;) {
      const params: Record<string, string> = {
        fields: MEDIA_FIELD_SETS[fieldLevel],
        limit: String(pageSize),
        access_token: t.accessToken,
      };
      if (after) params.after = after;
      const res = await sendRequest(f, graphUrl(`${GRAPH_URL}/me/media`, params), { method: "GET", headers: { accept: "application/json" } }, { label, secrets });
      try {
        json = graphJson(res, label, secrets);
        break;
      } catch (err) {
        const fieldProblem =
          page === 0 && err instanceof ConnectorError && err.status === 400 && !err.reconnect && !err.retryable;
        if (!fieldProblem || fieldLevel >= MEDIA_FIELD_SETS.length - 1) throw err;
        fieldLevel += 1; // a field is not available to this token type: retry the first page with fewer fields
      }
    }

    const root = asRecord(json);
    if (!root || !Array.isArray(root.data)) {
      throw new ConnectorError(`${label}: the response has no data list`, { status: 200, code: "parse", retryable: false });
    }
    for (const raw of root.data) {
      const item = readMediaItem(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.productType === "STORY") continue;
      if (sinceMs !== null && item.publishedAt.getTime() < sinceMs) {
        done = true; // newest first: everything after this post is older still
        break;
      }
      items.push(item);
      if (items.length >= limit) {
        done = true;
        break;
      }
    }

    const paging = asRecord(root.paging);
    const nextUrl = asString(paging?.next);
    const nextAfter = asString(asRecord(paging?.cursors)?.after) ?? (nextUrl ? afterFromNextUrl(nextUrl) : undefined);
    if (!nextUrl || !nextAfter || nextAfter === after) done = true;
    else after = nextAfter;
  }
  return items;
}

function readInsights(json: unknown): InsightValues {
  const out: InsightValues = {};
  const root = asRecord(json);
  const data = root && Array.isArray(root.data) ? root.data : [];
  for (const entry of data) {
    const rec = asRecord(entry);
    const name = rec ? asString(rec.name) : undefined;
    if (!rec || !name) continue;
    const first = Array.isArray(rec.values) ? asRecord(rec.values[0]) : null;
    const value = asNumber(first?.value) ?? asNumber(asRecord(rec.total_value)?.value);
    if (value === undefined || value < 0) continue;
    if (name === "views" || name === "reach" || name === "saved" || name === "shares" || name === "likes") out[name] = value;
  }
  return out;
}

type InsightRun = {
  /** Metric-set level that worked last, per media kind (REELS, VIDEO, IMAGE, CAROUSEL_ALBUM). */
  levelByKind: Map<string, number>;
  /** Set when further insight calls would only fail; the remaining posts are skipped. */
  stopReason: string | null;
  /** Posts in a row that ended without insights; reset by every success. */
  consecutiveFailures: number;
  skipped: number;
  firstError: string | null;
};

/**
 * One insights call for one post, walking down the metric ladder on HTTP 400. Provider problems never throw: the
 * post simply keeps empty metrics. Calls stop early when they cannot succeed (rate limit, rejected token or
 * permission, repeated network/server errors) so 50 posts do not become 50 doomed requests.
 */
async function fetchInsights(item: MediaItem, t: TokenSet, f: FetchLike, run: InsightRun): Promise<InsightValues | null> {
  if (run.stopReason !== null) {
    run.skipped += 1;
    return null;
  }
  const label = `${LABEL} insights`;
  const secrets = [t.accessToken];
  const kind = item.productType === "REELS" ? "REELS" : item.mediaType;
  let level = run.levelByKind.get(kind) ?? 0;
  let lastError: ConnectorError | null = null;

  while (level < INSIGHT_SETS.length) {
    const url = graphUrl(`${GRAPH_URL}/${encodeURIComponent(item.id)}/insights`, {
      metric: INSIGHT_SETS[level].join(","),
      access_token: t.accessToken,
    });
    try {
      const res = await sendRequest(f, url, { method: "GET", headers: { accept: "application/json" } }, { label, secrets });
      const values = readInsights(graphJson(res, label, secrets));
      run.levelByKind.set(kind, level); // later posts of the same kind start at the set that worked
      run.consecutiveFailures = 0;
      return values;
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err;
      lastError = err;
      if (isRateLimitError(err)) {
        run.stopReason = "rate limit hit";
        break;
      }
      if (err.reconnect) {
        run.stopReason = "Instagram rejected the access token or the insights permission";
        break;
      }
      if (err.retryable) break; // network or server trouble: this post keeps empty metrics
      // HTTP 400 is how an unsupported metric shows up: try the next smaller set, unless the post itself is the problem.
      if (err.status !== 400 || NO_SMALLER_SET_SUBCODES.has(err.subcode ?? "")) break;
      level += 1;
    }
  }
  run.skipped += 1;
  run.consecutiveFailures += 1;
  if (run.stopReason === null && run.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    run.stopReason = `${MAX_CONSECUTIVE_FAILURES} posts in a row returned no insights`;
  }
  if (lastError && run.firstError === null) run.firstError = lastError.message;
  return null;
}

function toNormalized(item: MediaItem, insights: InsightValues | null): NormalizedPost {
  return {
    externalId: item.id,
    url: item.permalink,
    publishedAt: item.publishedAt,
    format: formatLabel(item),
    caption: item.caption,
    views: insights?.views ?? null,
    likes: item.likeCount ?? insights?.likes ?? null,
    comments: item.commentsCount,
    shares: insights?.shares ?? null,
    saves: insights?.saved ?? null,
    reach: insights?.reach ?? null,
  };
}

async function fetchPosts(
  t: TokenSet,
  opts: { since?: Date; limit?: number; onWarning?: (message: string) => void },
  f: FetchLike,
): Promise<NormalizedPost[]> {
  if (!t.accessToken) throw new ConnectorError(`${LABEL} posts: the account has no access token`, { code: "invalid_request", reconnect: true, retryable: false });
  const limit = clampLimit(opts.limit, DEFAULT_POST_LIMIT);
  const items = await listMedia(t, limit, opts.since, f);

  // The stored scopes tell when the owner switched the insights permission off on the consent screen: say so once
  // instead of sending calls that can only be rejected. Unknown or unrecognised scope lists are given the benefit of the doubt.
  const scopes = t.scopes ?? [];
  if (scopes.some((s) => s.startsWith("instagram_business_")) && !scopes.includes(INSIGHTS_SCOPE)) {
    emitWarning(
      opts.onWarning,
      `${LABEL}: the insights permission was not granted for this account, so views, reach, saves and shares stay empty. Connect the account again and allow every permission.`,
    );
    return items.map((item) => toNormalized(item, null)).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  const run: InsightRun = { levelByKind: new Map(), stopReason: null, consecutiveFailures: 0, skipped: 0, firstError: null };
  const insights = await mapWithConcurrency(items, INSIGHT_CONCURRENCY, (item) => fetchInsights(item, t, f, run));

  if (run.skipped > 0) {
    emitWarning(
      opts.onWarning,
      `${LABEL}: insights (views, reach, saves, shares) are missing for ${run.skipped} of ${items.length} posts` +
        `${run.stopReason ? `; the remaining calls were skipped (${run.stopReason})` : ""}. First problem: ${run.firstError ?? "unknown"}`,
    );
  }

  return items
    .map((item, index) => toNormalized(item, insights[index]))
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

// ---------------------------------------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------------------------------------

export const instagramConnector: Connector = {
  platform: "instagram",
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
  refresh(t, f = fetch) {
    return refresh(t, f);
  },
  needsRefresh(t, now = new Date()) {
    return needsRefresh(t, now);
  },
  fetchPosts(t, opts = {}, f = fetch) {
    return fetchPosts(t, opts, f);
  },
};
