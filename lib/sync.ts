/**
 * Pulls each connected account's own posts and numbers from the official APIs into ReferencePost, so the Research tab and
 * the strategist work with current data instead of a one-off export.
 *
 *  - A post already in the table (matched by its Instagram shortcode / TikTok video id, so the scraped research rows match
 *    too) only gets fresh numbers; its research analysis (pillar, hook type, mechanism, human performance rating) stays.
 *  - A new post becomes a row with source "api-instagram" / "api-tiktok": hook = first caption line, the numbers, and a
 *    performance rating computed against the median of the account's recent posts (Exceptional ≥ 4×, High ≥ 1.75×,
 *    Low ≤ 0.5×, otherwise Typical; Unknown below 6 posts). Analysis fields stay empty.
 *  - Tokens are decrypted only here, refreshed when the connector asks for it, and stored again (TikTok rotates refresh tokens).
 *
 * Run by POST /api/sync (the "Sync now" buttons) and, every Monday, by the scheduler (task "sync-weekly").
 */
import { Prisma, type PlatformConnection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getConnector, isConnectorError, type NormalizedPost, type TokenSet } from "@/lib/connectors";
import { clip } from "@/lib/text";

export type SyncReport = {
  connectionId: string;
  brandSlug: string;
  platform: string;
  handle: string | null;
  ok: boolean;
  fetched: number;
  created: number;
  updated: number;
  warnings: string[];
  error?: string;
  /** True when the owner has to click Connect again. */
  reconnect?: boolean;
  /** True when trying again later may help (network, rate limit, 5xx). */
  retryable?: boolean;
};

const FIRST_SYNC_LIMIT = 120;
const REGULAR_SYNC_LIMIT = 60;
const MIN_POSTS_FOR_RATING = 6;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------------------

/** Stable id of a post inside its platform: Instagram shortcode, TikTok video id; falls back to the normalised URL. */
export function postKey(platform: string, url: string): string {
  const u = url.trim();
  if (platform.startsWith("instagram")) {
    const m = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(u);
    if (m) return m[1];
  } else if (platform.startsWith("tiktok")) {
    const m = /\/(?:video|photo)\/(\d+)/.exec(u);
    if (m) return m[1];
  }
  return u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** First caption line that is not a hashtag row, at most 220 characters. */
export function hookFrom(caption: string): string {
  const lines = caption
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines.find((l) => !/^(#\S+\s*)+$/.test(l)) ?? lines[0] ?? "";
  return first.length > 220 ? `${clip(first, 219).trimEnd()}…` : first;
}

/** The figure posts are rated on: views when most posts report them, otherwise total interactions. */
export function ratingMetric(posts: NormalizedPost[]): (p: NormalizedPost) => number | null {
  const withViews = posts.filter((p) => p.views !== null).length;
  if (posts.length > 0 && withViews / posts.length >= 0.6) return (p) => p.views;
  return (p) => (p.likes === null && p.comments === null && p.saves === null && p.shares === null ? null : (p.likes ?? 0) + (p.comments ?? 0) + (p.saves ?? 0) + (p.shares ?? 0));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Label in the vocabulary of the research rows (see performanceBucket in lib/retrieval.ts). */
export function ratingFor(value: number | null, med: number, sample: number): { level: string; evidence: string } {
  if (value === null || med <= 0 || sample < MIN_POSTS_FOR_RATING) return { level: "Unknown", evidence: "Too few comparable posts (or no figures) to rate this post." };
  const r = value / med;
  const level = r >= 4 ? "Exceptional" : r >= 1.75 ? "High" : r <= 0.5 ? "Low" : "Typical";
  return { level, evidence: `Official API figures: ${Math.round(value).toLocaleString("en-US")} vs. median ${Math.round(med).toLocaleString("en-US")} of the latest ${sample} posts (${r.toFixed(1)}×).` };
}

const num = (n: number | null): string | null => (n === null ? null : String(Math.round(n)));
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

type Json = Prisma.InputJsonValue;
const postJson = (p: NormalizedPost): Json => ({ ...p, publishedAt: p.publishedAt.toISOString() }) as unknown as Json;

function mergeRaw(old: Prisma.JsonValue | null, p: NormalizedPost): Json {
  const base = old && typeof old === "object" && !Array.isArray(old) ? (old as Record<string, Json>) : {};
  return { ...base, api: postJson(p), apiSyncedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------------------------------------

function tokenSetOf(conn: PlatformConnection): TokenSet {
  return {
    accessToken: decryptSecret(conn.accessToken),
    refreshToken: conn.refreshToken ? decryptSecret(conn.refreshToken) : null,
    expiresAt: conn.expiresAt,
    externalId: conn.externalId,
    handle: conn.handle,
    scopes: conn.scopes,
  };
}

export async function syncConnection(id: string): Promise<SyncReport> {
  const conn = await prisma.platformConnection.findUnique({ where: { id }, include: { brand: { select: { slug: true } } } });
  if (!conn) throw new Error("Connection not found.");
  const report: SyncReport = { connectionId: conn.id, brandSlug: conn.brand.slug, platform: conn.platform, handle: conn.handle, ok: false, fetched: 0, created: 0, updated: 0, warnings: [] };
  const fail = async (message: string, flags: { reconnect?: boolean; retryable?: boolean } = {}): Promise<SyncReport> => {
    await prisma.platformConnection.update({ where: { id }, data: { status: flags.reconnect ? "needs_reconnect" : "error", lastError: clip(message, 1500) } });
    return { ...report, ok: false, error: message, ...flags };
  };

  const connector = getConnector(conn.platform);
  if (!connector) return fail(`No connector for platform "${conn.platform}".`);

  let tokens: TokenSet;
  try {
    tokens = tokenSetOf(conn);
  } catch {
    return fail("The stored access token cannot be read (the app's secret changed). Connect the account again.", { reconnect: true });
  }

  try {
    if (connector.needsRefresh(tokens)) {
      tokens = await connector.refresh(tokens);
      await prisma.platformConnection.update({
        where: { id },
        data: {
          accessToken: encryptSecret(tokens.accessToken),
          refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          expiresAt: tokens.expiresAt ?? null,
          scopes: tokens.scopes?.length ? tokens.scopes : conn.scopes,
        },
      });
    }

    const posts = await connector.fetchPosts(tokens, { limit: conn.lastSyncAt ? REGULAR_SYNC_LIMIT : FIRST_SYNC_LIMIT, onWarning: (m) => report.warnings.push(m) });
    report.fetched = posts.length;

    const metric = ratingMetric(posts);
    const med = median(posts.map(metric).filter((v): v is number => v !== null));
    const existing = await prisma.referencePost.findMany({ where: { brandId: conn.brandId, platform: conn.platform }, select: { id: true, postUrl: true, source: true, raw: true } });
    const byKey = new Map(existing.map((e) => [postKey(conn.platform, e.postUrl), e]));

    for (const p of posts) {
      const metrics = { views: num(p.views), likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), saves: num(p.saves) };
      const defined = Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== null));
      const rating = ratingFor(metric(p), med, posts.length);
      const match = byKey.get(postKey(conn.platform, p.url));
      if (match) {
        // Research rows keep their analysis and human rating; rows the sync created earlier are re-rated with the new numbers.
        const own = match.source.startsWith("api-");
        await prisma.referencePost.update({
          where: { id: match.id },
          data: { ...defined, raw: mergeRaw(match.raw, p), ...(own ? { performanceLevel: rating.level, performanceEvidence: rating.evidence, format: p.format } : {}) },
        });
        report.updated++;
        continue;
      }
      const hook = hookFrom(p.caption);
      try {
        await prisma.referencePost.create({
          data: {
            brandId: conn.brandId,
            platform: conn.platform,
            postUrl: p.url,
            date: isoDate(p.publishedAt),
            format: p.format,
            hook: hook || null,
            mainMessage: p.caption ? clip(p.caption, 300) : null,
            ...metrics,
            performanceLevel: rating.level,
            performanceEvidence: rating.evidence,
            source: `api-${conn.platform}`,
            searchText: clip(`${hook}\n${p.caption}`.toLowerCase(), 4000),
            raw: { api: postJson(p), apiSyncedAt: new Date().toISOString() },
          },
        });
        report.created++;
      } catch (err) {
        // A row with the same url + hook already exists under a different key form: nothing to add.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      }
    }

    await prisma.platformConnection.update({
      where: { id },
      data: { status: "ok", lastSyncAt: new Date(), lastSyncCount: posts.length, lastError: report.warnings.length ? clip(report.warnings.join(" | "), 1500) : null },
    });
    return { ...report, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isConnectorError(err)) return fail(message, { reconnect: err.reconnect, retryable: err.retryable && !err.reconnect });
    return fail(message, { retryable: false });
  }
}

/** Syncs every connection that can still work (not the ones waiting for a reconnect), one after another. */
export async function syncAll(filter: { connectionId?: string; brandSlug?: string; platform?: string } = {}): Promise<SyncReport[]> {
  const connections = await prisma.platformConnection.findMany({
    where: {
      ...(filter.connectionId ? { id: filter.connectionId } : { status: { in: ["ok", "error"] } }),
      ...(filter.brandSlug ? { brand: { slug: filter.brandSlug } } : {}),
      ...(filter.platform ? { platform: filter.platform } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const reports: SyncReport[] = [];
  for (const c of connections) reports.push(await syncConnection(c.id));
  return reports;
}
