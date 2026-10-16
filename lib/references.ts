/**
 * Brand reference images for the image model: logo, product photos, packaging, people, mood boards. They live in the BrandAsset
 * table (bytes in MediaAsset); users upload them in the app (lib/brand-assets.ts, /api/brands/{slug}/assets).
 *
 * Built-in website references: the first time assets are listed or loaded for a brand, every `referenceImages` URL of
 * data/brands.ts without a BrandAsset row (sourceUrl) is fetched once and stored as a default asset. Deleting such a row only
 * hides it, so it is not imported again. Fetch failures are logged, skipped and retried at most every 5 minutes.
 *
 * Loading for a generation: `loadBrandReferences(slug, { ids })` returns exactly the picked assets; without ids the default
 * ones (isDefault, not hidden) ordered product, packaging, person, logo, mood, other, then position. At most 4 images. Bytes
 * are cached per process by media id (the id is unique and the bytes never change).
 */
import { prisma } from "@/lib/db";
import { readMedia, storeMedia } from "@/lib/media";
import { clip } from "@/lib/text";
import {
  MAX_REFERENCES,
  builtInProductReferenceCount,
  builtInReferences,
  compareDefaultOrder,
  isProductKind,
  type PromptImageReference,
  type ReferenceKind,
} from "@/lib/reference-kinds";

export { REFERENCE_KINDS, MAX_REFERENCES, isProductKind, type ReferenceKind } from "@/lib/reference-kinds";
export type BrandReference = { bytes: Uint8Array; mime: string; label: string; kind: ReferenceKind };

/** Upload and import limit per image. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const ASSET_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AssetMime = (typeof ASSET_MIMES)[number];

const FETCH_TIMEOUT_MS = 10_000;
const RETRY_FAILED_IMPORT_MS = 5 * 60 * 1000;
const CACHE_LIMIT_BYTES = 48 * 1024 * 1024;

/** The image type from the first bytes, or null when the bytes are not a PNG, JPEG or WebP (the declared type is never trusted). */
export function sniffImageMime(bytes: Uint8Array): AssetMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Bytes cache (per process, by media id)
// ---------------------------------------------------------------------------------------------------------

type Bytes = { bytes: Uint8Array; mime: string };
const cache = new Map<string, Bytes>();
let cacheBytes = 0;

/** Drops one media id from the cache (called when an uploaded asset is deleted). */
export function forgetReferenceBytes(mediaId: string): void {
  const hit = cache.get(mediaId);
  if (!hit) return;
  cacheBytes -= hit.bytes.byteLength;
  cache.delete(mediaId);
}

function remember(mediaId: string, value: Bytes): void {
  if (value.bytes.byteLength > CACHE_LIMIT_BYTES) return;
  forgetReferenceBytes(mediaId);
  cache.set(mediaId, value);
  cacheBytes += value.bytes.byteLength;
  for (const key of cache.keys()) {
    if (cacheBytes <= CACHE_LIMIT_BYTES) break;
    forgetReferenceBytes(key); // Map iterates in insertion order: the oldest entry goes first
  }
}

async function bytesOf(mediaId: string): Promise<Bytes | null> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  const media = await readMedia(mediaId);
  if (!media) return null;
  const value = { bytes: media.bytes, mime: media.mime };
  remember(mediaId, value);
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// Built-in website references → BrandAsset
// ---------------------------------------------------------------------------------------------------------

const failedImports = new Map<string, number>();
const importing = new Map<string, Promise<void>>();

async function fetchRemoteImage(url: string): Promise<{ bytes: Uint8Array; mime: AssetMime }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`size ${bytes.byteLength} bytes outside 1..${MAX_ASSET_BYTES}`);
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error(`not a PNG, JPEG or WebP image (content-type ${res.headers.get("content-type") ?? "unknown"})`);
  return { bytes, mime };
}

async function importOne(brandId: string, ref: { url: string; kind: ReferenceKind; label: string; position: number }): Promise<void> {
  const failedAt = failedImports.get(`${brandId}|${ref.url}`);
  if (failedAt && Date.now() - failedAt < RETRY_FAILED_IMPORT_MS) return;
  let mediaId: string | null = null;
  try {
    const { bytes, mime } = await fetchRemoteImage(ref.url);
    const stored = await storeMedia({ kind: "image", mime, bytes });
    mediaId = stored.id;
    await prisma.brandAsset.create({
      data: {
        brandId,
        mediaId: stored.id,
        kind: ref.kind,
        label: clip(ref.label, 200),
        isDefault: true,
        position: ref.position,
        sourceUrl: ref.url,
        mime: stored.mime,
        size: stored.size,
      },
    });
    failedImports.delete(`${brandId}|${ref.url}`);
  } catch (err) {
    // A parallel import (another process) won the unique (brandId, sourceUrl) race: its row is the one, drop our copy of the bytes.
    if (mediaId) await prisma.mediaAsset.deleteMany({ where: { id: mediaId } }).catch(() => undefined);
    if ((err as { code?: string }).code !== "P2002") {
      failedImports.set(`${brandId}|${ref.url}`, Date.now());
      console.warn(`[references] could not import ${ref.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Imports the built-in website references of data/brands.ts that have no BrandAsset row yet (hidden rows count as present).
 * Never throws; concurrent calls for one brand share one run.
 */
export function importBuiltInAssets(brand: { id: string; slug: string }): Promise<void> {
  const builtIns = builtInReferences(brand.slug);
  if (builtIns.length === 0) return Promise.resolve();
  const running = importing.get(brand.id);
  if (running) return running;
  const run = (async () => {
    try {
      const present = await prisma.brandAsset.findMany({ where: { brandId: brand.id, sourceUrl: { in: builtIns.map((r) => r.url) } }, select: { sourceUrl: true } });
      const have = new Set(present.map((r) => r.sourceUrl));
      await Promise.all(builtIns.filter((r) => !have.has(r.url)).map((r) => importOne(brand.id, r)));
    } catch (err) {
      console.warn(`[references] ${brand.slug}: built-in import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })().finally(() => importing.delete(brand.id));
  importing.set(brand.id, run);
  return run;
}

// ---------------------------------------------------------------------------------------------------------
// Loading for a generation
// ---------------------------------------------------------------------------------------------------------

/**
 * Up to 4 reference images of a brand with their bytes. With `ids`: exactly those assets (not hidden, belonging to the brand,
 * in the order given; unknown ids are skipped; an empty list means none). Without: the default assets (isDefault, not hidden)
 * ordered product, packaging, person, logo, mood, other, then position. Never throws: failures are logged and skipped.
 */
export async function loadBrandReferences(slug: string, opts: { ids?: string[] } = {}): Promise<BrandReference[]> {
  try {
    const brand = await prisma.brand.findUnique({ where: { slug }, select: { id: true, slug: true } });
    if (!brand) return [];
    await importBuiltInAssets(brand);

    const select = { id: true, mediaId: true, kind: true, label: true, position: true, createdAt: true } as const;
    let rows;
    if (opts.ids) {
      const wanted = [...new Set(opts.ids)];
      const found = wanted.length ? await prisma.brandAsset.findMany({ where: { brandId: brand.id, hidden: false, id: { in: wanted } }, select }) : [];
      const byId = new Map(found.map((r) => [r.id, r]));
      rows = wanted.flatMap((id) => byId.get(id) ?? []);
    } else {
      rows = (await prisma.brandAsset.findMany({ where: { brandId: brand.id, hidden: false, isDefault: true }, select })).sort(compareDefaultOrder);
    }

    // Load in batches so an asset whose bytes are gone does not cost a slot while others are left.
    const out: BrandReference[] = [];
    for (let i = 0; i < rows.length && out.length < MAX_REFERENCES; ) {
      const batch = rows.slice(i, i + (MAX_REFERENCES - out.length));
      i += batch.length;
      const loaded = await Promise.all(
        batch.map(async (r) => {
          try {
            const got = await bytesOf(r.mediaId);
            if (!got) console.warn(`[references] ${slug}: the bytes of asset ${r.id} are missing; skipping it`);
            return got ? ({ ...got, label: r.label, kind: r.kind as ReferenceKind } satisfies BrandReference) : null;
          } catch (err) {
            console.warn(`[references] ${slug}: asset ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      out.push(...loaded.filter((r): r is BrandReference => r !== null));
    }
    return out;
  } catch (err) {
    console.warn(`[references] ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Cheap, fetch-free views: the options route and the prompt builder
// ---------------------------------------------------------------------------------------------------------

type AssetFacts = { kind: string; label: string; position: number; createdAt: Date; isDefault: boolean; hidden: boolean; sourceUrl: string | null };

/** Default, visible assets of one brand plus built-in references that are not imported yet (no fetching). */
function defaultFacts(slug: string, rows: AssetFacts[]): AssetFacts[] {
  const imported = new Set(rows.flatMap((r) => (r.sourceUrl ? [r.sourceUrl] : [])));
  const pending = builtInReferences(slug)
    .filter((r) => !imported.has(r.url))
    .map((r): AssetFacts => ({ kind: r.kind, label: r.label, position: r.position, createdAt: new Date(0), isDefault: true, hidden: false, sourceUrl: r.url }));
  return [...rows.filter((r) => r.isDefault && !r.hidden), ...pending].sort(compareDefaultOrder);
}

/**
 * How many default, visible product / packaging images each brand has, counting built-in website references that are not
 * imported yet. Reads the database only, never fetches. Falls back to the static built-in count if the database fails.
 */
export async function productReferenceCounts(slugs: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    const rows = await prisma.brandAsset.findMany({
      where: { brand: { slug: { in: slugs } } },
      select: { kind: true, label: true, position: true, createdAt: true, isDefault: true, hidden: true, sourceUrl: true, brand: { select: { slug: true } } },
    });
    for (const slug of slugs) {
      counts[slug] = defaultFacts(slug, rows.filter((r) => r.brand.slug === slug)).filter((r) => isProductKind(r.kind)).length;
    }
  } catch (err) {
    console.warn(`[references] product counts from the database failed; using data/brands.ts: ${err instanceof Error ? err.message : String(err)}`);
    for (const slug of slugs) counts[slug] = builtInProductReferenceCount(slug);
  }
  return counts;
}

/**
 * Kind and label of the reference images /api/image will attach by default (the first 4 in default order), for the text
 * prompt. No fetching; built-in references that are not imported yet are included. Throws on database failure (the pipeline
 * catches and falls back to the built-ins).
 */
export async function describeDefaultReferences(slug: string): Promise<PromptImageReference[]> {
  const rows = await prisma.brandAsset.findMany({
    where: { brand: { slug } },
    select: { kind: true, label: true, position: true, createdAt: true, isDefault: true, hidden: true, sourceUrl: true },
  });
  return defaultFacts(slug, rows)
    .slice(0, MAX_REFERENCES)
    .map(({ kind, label }) => ({ kind, label }));
}
