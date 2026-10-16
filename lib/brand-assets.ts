/**
 * Brand assets: the data layer behind /api/brands/{slug}/assets (list, upload, edit, delete) and the response shape the UI reads.
 * The images are reference images for the image model (lib/references.ts loads them); the bytes live in MediaAsset and are
 * served at /api/media/{mediaId}.
 *
 * Deleting an imported website reference only hides it (so lib/references.ts does not import it again); deleting an uploaded
 * one removes the row and its MediaAsset.
 */
import type { BrandAsset } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { mediaUrl, storeMedia } from "@/lib/media";
import {
  ASSET_MIMES,
  MAX_ASSET_BYTES,
  REFERENCE_KINDS,
  forgetReferenceBytes,
  importBuiltInAssets,
  sniffImageMime,
  type AssetMime,
} from "@/lib/references";

/** Visible (not hidden) assets per brand: a guard against filling the database with 8 MB images. */
export const MAX_ASSETS_PER_BRAND = 50;
export { ASSET_MIMES, MAX_ASSET_BYTES, REFERENCE_KINDS };

export type AssetDto = {
  id: string;
  kind: string;
  label: string;
  isDefault: boolean;
  position: number;
  url: string;
  mime: string;
  size: number;
  source: "upload" | "website";
  createdAt: string;
};

export function toAssetDto(req: Request, row: BrandAsset): AssetDto {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    isDefault: row.isDefault,
    position: row.position,
    url: mediaUrl(req, row.mediaId),
    mime: row.mime,
    size: row.size,
    source: row.sourceUrl ? "website" : "upload",
    createdAt: row.createdAt.toISOString(),
  };
}

export class AssetInputError extends Error {
  readonly issues: string[];
  readonly status: number;
  constructor(issues: string[], status = 422) {
    super(issues.join("; "));
    this.name = "AssetInputError";
    this.issues = issues;
    this.status = status;
  }
}

export async function findBrandBySlug(slug: string): Promise<{ id: string; slug: string } | null> {
  return prisma.brand.findUnique({ where: { slug }, select: { id: true, slug: true } });
}

/** Imports missing built-in website references first, then lists the visible assets ordered by position, then age. */
export async function listAssets(req: Request, brand: { id: string; slug: string }): Promise<AssetDto[]> {
  await importBuiltInAssets(brand);
  const rows = await prisma.brandAsset.findMany({ where: { brandId: brand.id, hidden: false }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return rows.map((r) => toAssetDto(req, r));
}

// ---------------------------------------------------------------------------------------------------------
// Create (multipart upload)
// ---------------------------------------------------------------------------------------------------------

/** A text field of a multipart form: undefined when absent or empty, "[file]" when a file was sent where text is expected. */
function field(form: FormData, key: string): string | undefined {
  const raw = form.get(key);
  if (raw === null) return undefined;
  if (typeof raw !== "string") return "[file]";
  return raw.trim() === "" ? undefined : raw;
}

/** The label ends up in prompts: one line. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ");

const CreateFieldsSchema = z.object({
  kind: z.enum(REFERENCE_KINDS, { error: `kind must be one of: ${REFERENCE_KINDS.join(", ")}` }).default("other"),
  label: z
    .string({ error: "label is required (1 to 200 characters)" })
    .trim()
    .min(1, "label is required (1 to 200 characters)")
    .max(200, "label must be 200 characters or fewer")
    .transform(oneLine),
  isDefault: z
    .enum(["true", "false"], { error: 'isDefault must be "true" or "false"' })
    .default("true")
    .transform((v) => v === "true"),
});

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Validates the upload form (file, kind, label, isDefault), stores the bytes and creates the asset. Throws AssetInputError (422)
 * with a message per problem. The image type comes from the file's bytes, not from the browser's declared type.
 */
export async function createAssetFromForm(brand: { id: string }, form: FormData): Promise<BrandAsset> {
  const issues: string[] = [];
  const fields = CreateFieldsSchema.safeParse({ kind: field(form, "kind"), label: field(form, "label"), isDefault: field(form, "isDefault") });
  if (!fields.success) issues.push(...fields.error.issues.map((i) => i.message));

  let bytes: Uint8Array | null = null;
  let mime: AssetMime | null = null;
  const file = form.get("file");
  if (!(file instanceof File)) {
    issues.push('file is required: send a PNG, JPEG or WebP image in the form field "file".');
  } else if (file.size === 0) {
    issues.push("file is empty.");
  } else if (file.size > MAX_ASSET_BYTES) {
    issues.push(`file is ${mb(file.size)}, over the ${mb(MAX_ASSET_BYTES)} limit. Use a smaller image.`);
  } else {
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = sniffImageMime(bytes);
    if (!mime) issues.push(`file must be a PNG, JPEG or WebP image; the content of this file (sent as ${file.type || "an unknown type"}) is not one. GIF, HEIC and SVG are not supported.`);
  }
  if (issues.length || !fields.success || !bytes || !mime) throw new AssetInputError(issues.length ? issues : ["Invalid upload."]);

  const visible = await prisma.brandAsset.count({ where: { brandId: brand.id, hidden: false } });
  if (visible >= MAX_ASSETS_PER_BRAND) {
    throw new AssetInputError([`A brand can have at most ${MAX_ASSETS_PER_BRAND} reference images. Delete some first.`]);
  }
  const last = await prisma.brandAsset.aggregate({ where: { brandId: brand.id }, _max: { position: true } });

  const stored = await storeMedia({ kind: "image", mime, bytes });
  try {
    return await prisma.brandAsset.create({
      data: {
        brandId: brand.id,
        mediaId: stored.id,
        kind: fields.data.kind,
        label: fields.data.label,
        isDefault: fields.data.isDefault,
        position: (last._max.position ?? -1) + 1,
        mime: stored.mime,
        size: stored.size,
      },
    });
  } catch (err) {
    await prisma.mediaAsset.deleteMany({ where: { id: stored.id } }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------------------------------------

export const UpdateAssetSchema = z
  .object({
    kind: z.enum(REFERENCE_KINDS, { error: `kind must be one of: ${REFERENCE_KINDS.join(", ")}` }).optional(),
    label: z.string().trim().min(1, "label must not be empty").max(200, "label must be 200 characters or fewer").transform(oneLine).optional(),
    isDefault: z.boolean({ error: "isDefault must be true or false" }).optional(),
    position: z.number({ error: "position must be a whole number from 0 to 100000" }).int("position must be a whole number from 0 to 100000").min(0, "position must be a whole number from 0 to 100000").max(100_000, "position must be a whole number from 0 to 100000").optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: "Provide at least one of kind, label, isDefault, position." });

/** The asset of this brand (visible rows only), or null: another brand's or a hidden asset is "not found". */
export async function findVisibleAsset(brandId: string, id: string): Promise<BrandAsset | null> {
  return prisma.brandAsset.findFirst({ where: { id, brandId, hidden: false } });
}

export async function updateAsset(asset: BrandAsset, patch: z.infer<typeof UpdateAssetSchema>): Promise<BrandAsset> {
  return prisma.brandAsset.update({
    where: { id: asset.id },
    data: {
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    },
  });
}

/** Imported website references are hidden (and stay out of the lists and out of re-imports); uploads are deleted with their bytes. */
export async function deleteAsset(asset: BrandAsset): Promise<void> {
  if (asset.sourceUrl) {
    await prisma.brandAsset.update({ where: { id: asset.id }, data: { hidden: true } });
    return;
  }
  await prisma.$transaction([prisma.brandAsset.delete({ where: { id: asset.id } }), prisma.mediaAsset.deleteMany({ where: { id: asset.mediaId } })]);
  forgetReferenceBytes(asset.mediaId);
}
