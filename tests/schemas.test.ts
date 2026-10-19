import { describe, expect, it } from "vitest";
import { BrandInputSchema, firstIssue, slugify } from "@/lib/brands";
import { IdeasParamsSchema } from "@/lib/ideas/types";
import { hashtagRangeFor, lengthNormFor, mandatorySectionsFor, mappedPostType, renderOutputContract } from "@/lib/prompt";
import { BriefSchema, GenerationOutputSchema } from "@/lib/types";
import { DraftGenerationSchema } from "@/lib/pipeline";
import { brief, output } from "./fixtures";

describe("BriefSchema", () => {
  it("fills defaults", () => {
    const b = BriefSchema.parse({ brandSlug: "x", platform: "tiktok", postType: "reel_script", goal: "lead", pillar: "custom" });
    expect(b).toMatchObject({ hookType: "auto", language: "en", variants: "1", textProvider: "anthropic", referenceStrategy: "avoid_repeats" });
  });

  it("rejects unknown enum values and over-long free text", () => {
    expect(BriefSchema.safeParse({ ...brief(), platform: "myspace" }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief(), topic: "x".repeat(2001) }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief(), pillar: "" }).success).toBe(false);
  });
});

describe("GenerationOutputSchema", () => {
  it("accepts the fixture and requires at least one variant", () => {
    expect(GenerationOutputSchema.safeParse(output()).success).toBe(true);
    expect(GenerationOutputSchema.safeParse(output([])).success).toBe(false);
  });

  it("rejects a score outside 1..10", () => {
    const o = output();
    expect(GenerationOutputSchema.safeParse({ ...o, selfReview: { ...o.selfReview, score: 11 } }).success).toBe(false);
  });
});

describe("BrandInputSchema", () => {
  it("trims, dedupes lists and applies defaults", () => {
    const b = BrandInputSchema.parse({ name: "  Demo  ", forbiddenTerms: ["a", "a", " b "] });
    expect(b.name).toBe("Demo");
    expect(b.forbiddenTerms).toEqual(["a", "b"]);
    expect(b.languages).toEqual(["en"]);
    expect(b.complianceReview).toBe(true);
  });

  it("validates slug, languages and platforms with readable issues", () => {
    const bad = BrandInputSchema.safeParse({ name: "Demo", slug: "Not A Slug!" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(firstIssue(bad.error)).toMatch(/^slug: /);
    expect(BrandInputSchema.safeParse({ name: "Demo", languages: ["fr"] }).success).toBe(false);
    expect(BrandInputSchema.safeParse({ name: "Demo", platforms: ["linkedin-showcase"] }).success).toBe(true);
    expect(BrandInputSchema.safeParse({ name: "Demo", platforms: ["myspace"] }).success).toBe(false);
  });

  it("slugify folds accents and ß", () => {
    expect(slugify("Café Straße & Co.")).toBe("cafe-strasse-co");
    expect(slugify("!!!")).toBe("brand");
  });
});

describe("DraftGenerationSchema", () => {
  it("accepts a minimal draft and only http(s) image URLs", () => {
    const base = { brandId: "b", platform: "instagram", postType: "reel_script", brief: brief(), provider: "mock", output: output() };
    expect(DraftGenerationSchema.safeParse(base).success).toBe(true);
    expect(DraftGenerationSchema.safeParse({ ...base, imageUrls: ["javascript:alert(1)"] }).success).toBe(false);
    expect(DraftGenerationSchema.safeParse({ ...base, status: "published" }).success).toBe(false);
  });
});

describe("IdeasParamsSchema", () => {
  it("bounds the idea count", () => {
    expect(IdeasParamsSchema.parse({ brandSlug: "x", platform: "instagram" }).count).toBe(8);
    expect(IdeasParamsSchema.safeParse({ brandSlug: "x", platform: "instagram", count: 50 }).success).toBe(false);
  });
});

describe("output contract helpers", () => {
  it("maps blog_to_social to the platform's native format", () => {
    expect(mappedPostType("blog_to_social", "linkedin")).toBe("linkedin_text");
    expect(mappedPostType("blog_to_social", "tiktok")).toBe("reel_script");
    expect(mappedPostType("blog_to_social", "x")).toBe("x_thread");
    expect(mappedPostType("carousel", "linkedin")).toBe("carousel");
  });

  it("lists mandatory sections without duplicates", () => {
    const s = mandatorySectionsFor("youtube_script", "youtube");
    expect(s.slice(0, 5)).toEqual(["title", "hook", "hookType", "cta", "ctaType"]);
    expect(new Set(s).size).toBe(s.length);
  });

  it("hashtag ranges per platform, ads and premium tone", () => {
    expect(hashtagRangeFor("instagram", "reel_script")).toEqual({ min: 5, max: 8 });
    expect(hashtagRangeFor("instagram", "ad_creative")).toEqual({ min: 0, max: 0 });
    expect(hashtagRangeFor("instagram", "carousel", "premium_minimal")).toEqual({ min: 3, max: 3 });
    expect(hashtagRangeFor("unknown", "carousel")).toEqual({ min: 0, max: 8 });
  });

  it("length norms and rendered contract", () => {
    expect(lengthNormFor("carousel", "instagram", "short")).toBe("5 to 6 slides");
    expect(lengthNormFor("blog_to_social", "linkedin", "bogus")).toMatch(/^mapped format \(linkedin_text\)/);
    const c = renderOutputContract({ postType: "carousel", platform: "instagram", variants: "3" });
    expect(c).not.toMatch(/\{\{/);
    expect(c).toMatch(/Return exactly 3 variants\.$/);
    expect(renderOutputContract({ postType: "carousel", platform: "instagram", variants: 9 })).toMatch(/Return exactly 1 variants/);
  });
});
