/** Shared helpers of the brand reference photos: the kinds, their order and labels, sizes. */
import type { AssetKind, BrandAsset } from "./types";
import type { SelectOption } from "./ui/Field";

/** At most this many photos go to the image model in one call (the server enforces it too). */
export const MAX_SENT_REFERENCES = 4;

export const ASSET_KINDS: { id: AssetKind; label: string }[] = [
  { id: "product", label: "Product photo" },
  { id: "packaging", label: "Packaging" },
  { id: "logo", label: "Logo" },
  { id: "person", label: "Person" },
  { id: "mood", label: "Mood / style" },
  { id: "other", label: "Other" },
];

export const ASSET_KIND_OPTIONS: SelectOption[] = ASSET_KINDS.map((k) => ({ id: k.id, label: k.label }));

export const kindLabel = (kind: string): string => ASSET_KINDS.find((k) => k.id === kind)?.label ?? kind;

/** The server picks default photos in this order: the thing being sold first, then who shows it, then the brand marks, then style. */
const KIND_ORDER: Record<AssetKind, number> = { product: 0, packaging: 1, person: 2, logo: 3, mood: 4, other: 5 };

export function compareAssets(a: BrandAsset, b: BrandAsset): number {
  const ka = KIND_ORDER[a.kind] ?? ASSET_KINDS.length;
  const kb = KIND_ORDER[b.kind] ?? ASSET_KINDS.length;
  return ka - kb || a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

export const sortAssets = (list: BrandAsset[]): BrandAsset[] => [...list].sort(compareAssets);

/** Product and packaging photos are what lets a video start from the real product. */
export const isProductAsset = (a: BrandAsset): boolean => a.kind === "product" || a.kind === "packaging";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
