/**
 * Media hosting inside the app: a generated key visual or voice-over is stored in the database (MediaAsset) and served
 * publicly at /api/media/{id}.
 *
 * Why: both come back to the browser as bytes. Without a public URL they cannot be saved with the Generation
 * (imageUrl / imageUrls / audioUrl), and the key visual cannot be the start frame of an image-to-video job: Higgsfield fetches that
 * image from its own servers, without a session. The random 144-bit id is the capability (the URL is not listable).
 *
 * Hosting never blocks a generation: any failure is logged and the caller returns the bytes without a URL.
 * Rows that no Generation and no BrandAsset (brand reference image, lib/references.ts) points to are purged after 30 days,
 * opportunistically on later uploads.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { appOrigin } from "@/lib/connect";

export const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
export type MediaKind = "image" | "audio";

/** Explicit allowlist: the bytes are served to anyone with the URL, so nothing script-capable (SVG, HTML) is ever hosted. */
const ALLOWED_MIME: Record<MediaKind, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  audio: ["audio/mpeg"],
};
const MAX_BYTES = 12 * 1024 * 1024;
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_PROBABILITY = 0.1;

export type HostedMedia = { mime: string; size: number; bytes: Uint8Array };

/**
 * Stores the bytes in MediaAsset and returns the new row's id. Throws when the type is not hostable or the size is outside
 * 1..12 MB. hostMedia wraps it for generated media; brand reference images (lib/brand-assets.ts, lib/references.ts) call it directly.
 */
export async function storeMedia(p: { kind: MediaKind; mime: string; bytes: Uint8Array }): Promise<{ id: string; mime: string; size: number }> {
  const mime = p.mime.split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!ALLOWED_MIME[p.kind].includes(mime)) throw new Error(`type ${p.mime} is not hostable`);
  if (p.bytes.byteLength === 0 || p.bytes.byteLength > MAX_BYTES) throw new Error(`size ${p.bytes.byteLength} bytes is outside 1..${MAX_BYTES}`);
  const id = randomBytes(18).toString("base64url");
  const data = new Uint8Array(p.bytes.byteLength); // a plain ArrayBuffer copy: Prisma's Bytes type rejects shared buffers
  data.set(p.bytes);
  await prisma.mediaAsset.create({ data: { id, kind: p.kind, mime, bytes: data, size: data.byteLength } });
  if (Math.random() < PURGE_PROBABILITY) void purgeStaleMedia().catch(() => undefined);
  return { id, mime, size: data.byteLength };
}

/** The absolute public URL of a hosted asset (same origin logic as hostMedia). */
export function mediaUrl(req: Request, id: string): string {
  return `${appOrigin(req)}/api/media/${id}`;
}

/** Stores the bytes and returns their absolute public URL, or null (after a log line) when hosting is not possible. */
export async function hostMedia(context: string, req: Request, p: { kind: MediaKind; mime: string; bytes: Uint8Array }): Promise<string | null> {
  try {
    const { id } = await storeMedia(p);
    return mediaUrl(req, id);
  } catch (err) {
    console.warn(`[${context}] hosting the media failed; returning bytes only: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function readMedia(id: string): Promise<HostedMedia | null> {
  if (!MEDIA_ID_PATTERN.test(id)) return null;
  const row = await prisma.mediaAsset.findUnique({ where: { id }, select: { mime: true, size: true, bytes: true } });
  return row ? { mime: row.mime, size: row.size, bytes: row.bytes } : null;
}

/**
 * Deletes assets older than 30 days that no saved generation and no brand reference image (BrandAsset.mediaId) references.
 * Returns how many rows were removed.
 */
export async function purgeStaleMedia(): Promise<number> {
  const cutoff = new Date(Date.now() - PURGE_AFTER_MS);
  return prisma.$executeRaw`
    DELETE FROM "MediaAsset" m
    WHERE m."createdAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "Generation" g
        WHERE strpos(coalesce(g."imageUrl", ''), m."id") > 0 OR strpos(coalesce(g."imageUrls", ''), m."id") > 0 OR strpos(coalesce(g."audioUrl", ''), m."id") > 0
      )
      AND NOT EXISTS (SELECT 1 FROM "BrandAsset" b WHERE b."mediaId" = m."id")`;
}
