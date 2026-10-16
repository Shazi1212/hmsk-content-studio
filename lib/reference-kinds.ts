/**
 * Pure helpers for brand reference images (no I/O, no database): the six kinds, the order in which default references are
 * picked, the built-in website references of data/brands.ts, and the one-line list the text model reads. Shared by
 * lib/references.ts (loading), lib/brand-assets.ts (CRUD), lib/providers/image.ts (instruction) and lib/prompt/system.ts.
 */
import { BRANDS } from "@/data/brands";
import { clip } from "@/lib/text";

export const REFERENCE_KINDS = ["product", "packaging", "logo", "person", "mood", "other"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** At most this many reference images go to the image model in one call. */
export const MAX_REFERENCES = 4;

/** Default selection order: the thing being sold first, then who shows it, then the brand marks, then style. */
const KIND_ORDER: Record<ReferenceKind, number> = { product: 0, packaging: 1, person: 2, logo: 3, mood: 4, other: 5 };

export type OrderableReference = { kind: string; position: number; createdAt: Date };

/** Sort comparator for the default selection: product, packaging, person, logo, mood, other, then position, then age. */
export function compareDefaultOrder(a: OrderableReference, b: OrderableReference): number {
  const ka = KIND_ORDER[a.kind as ReferenceKind] ?? REFERENCE_KINDS.length;
  const kb = KIND_ORDER[b.kind as ReferenceKind] ?? REFERENCE_KINDS.length;
  return ka - kb || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime();
}

export function isProductKind(kind: string): boolean {
  return kind === "product" || kind === "packaging";
}

export type BuiltInReference = { url: string; kind: ReferenceKind; label: string; position: number };

/** The `referenceImages` of data/brands.ts for one brand, with their list index as position. */
export function builtInReferences(slug: string): BuiltInReference[] {
  const brand = BRANDS.find((b) => b.slug === slug);
  return (brand?.referenceImages ?? []).map((r, position) => ({ url: r.url, kind: r.kind, label: r.label, position }));
}

/**
 * Number of default product / packaging photos a brand has in data/brands.ts: the static fallback of the product-photo count
 * when the database cannot be asked (lib/references.ts `productReferenceCounts` is the real, database-aware count).
 */
export function builtInProductReferenceCount(slug: string): number {
  return builtInReferences(slug).filter((r) => isProductKind(r.kind)).length;
}

/** What the text model is told about one attached reference image: its kind and label, never its URL. */
export type PromptImageReference = { kind: string; label: string };

/** The default references as the text model sees them if nothing else is known: the built-ins, in default order, capped. */
export function builtInPromptReferences(slug: string): PromptImageReference[] {
  return builtInReferences(slug)
    .map((r) => ({ ...r, createdAt: new Date(0) }))
    .sort(compareDefaultOrder)
    .slice(0, MAX_REFERENCES)
    .map(({ kind, label }) => ({ kind, label }));
}

/** Labels are user text that ends up in a system prompt: one line, no control characters, bounded. */
export function promptLabel(label: string): string {
  return clip(label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), 200);
}

/** `product: <label>; logo: <label>` or `none`. */
export function formatPromptReferences(refs: PromptImageReference[]): string {
  const items = refs.map((r) => `${r.kind}: ${promptLabel(r.label).replace(/[.;]+$/, "")}`).filter((s) => !s.endsWith(": "));
  return items.length ? items.join("; ") : "none";
}
