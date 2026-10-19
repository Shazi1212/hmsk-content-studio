/**
 * Brand settings (Brands tab): validation and the shape the API returns. Brands live in the database; data/brands.ts only seeds
 * the demo brand on first start.
 */
import type { Brand } from "@prisma/client";
import { z } from "zod";
import { PLATFORMS } from "@/lib/types";

const PLATFORM_IDS = new Set(PLATFORMS.map((p) => p.id));
export const BRAND_LANGUAGES = ["de", "en"] as const;

const list = (max: number, itemMax: number) =>
  z
    .array(z.string().trim().min(1).max(itemMax))
    .max(max)
    .transform((xs) => [...new Set(xs)]);

const text = (max: number) => z.string().trim().max(max);

export const BrandInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: lowercase letters, digits and single hyphens")
    .max(60)
    .optional(),
  tagline: text(300).default(""),
  websiteUrl: text(300).default(""),
  description: text(8000).default(""),
  audience: text(8000).default(""),
  voice: text(8000).default(""),
  visual: text(8000).default(""),
  offers: text(8000).default(""),
  guardrails: text(8000).default(""),
  categoryRules: text(4000).default(""),
  languages: list(2, 8)
    .default(["en"])
    .refine((xs) => xs.every((x) => (BRAND_LANGUAGES as readonly string[]).includes(x)), "Languages: de and/or en"),
  platforms: list(12, 40)
    .default(["instagram"])
    .refine((xs) => xs.every((x) => PLATFORM_IDS.has(x.split("-")[0])), "Unknown platform"),
  pillars: list(20, 200).default([]),
  forbiddenTerms: list(100, 120).default([]),
  claimTerms: list(100, 120).default([]),
  claimSensitive: z.boolean().default(false),
  complianceReview: z.boolean().default(true),
  bannedPhrases: list(100, 120).default([]),
  aiPhraseCheck: z.boolean().default(true),
});
export type BrandInput = z.infer<typeof BrandInputSchema>;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "brand"
  );
}

/** The data Prisma writes for a validated input (slug handled by the caller). */
export function brandData(input: BrandInput) {
  const { slug: _slug, tagline, websiteUrl, ...rest } = input;
  void _slug;
  return { ...rest, tagline: tagline || null, websiteUrl: websiteUrl || null };
}

export type BrandDto = Omit<Brand, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };

export function toBrandDto(b: Brand): BrandDto {
  return { ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString() };
}

/** First validation issue as one readable line. */
export function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid brand.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
