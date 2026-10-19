/** Test fixtures built from the fictional demo brand. No database: plain objects shaped like Prisma rows. */
import type { Brand, Generation, ReferencePost } from "@prisma/client";
import { BRANDS } from "@/data/brands";
import { BriefSchema, type Brief, type GenerationOutput, type Variant } from "@/lib/types";

const seed = BRANDS[0];
const EPOCH = new Date("2026-01-01T00:00:00Z");

export function demoBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: "brand_demo",
    slug: seed.slug,
    name: seed.name,
    tagline: seed.tagline,
    description: seed.description,
    websiteUrl: seed.websiteUrl,
    languages: seed.languages,
    platforms: seed.platforms,
    pillars: seed.pillars,
    audience: seed.audience,
    voice: seed.voice,
    visual: seed.visual,
    offers: seed.offers,
    guardrails: seed.guardrails,
    categoryRules: seed.categoryRules ?? "",
    forbiddenTerms: seed.forbiddenTerms ?? [],
    claimTerms: seed.claimTerms ?? [],
    claimSensitive: seed.claimSensitive ?? false,
    complianceReview: seed.complianceReview ?? true,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function brief(overrides: Partial<Brief> = {}): Brief {
  return BriefSchema.parse({
    brandSlug: seed.slug,
    platform: "instagram",
    postType: "reel_script",
    goal: "awareness",
    pillar: seed.pillars[0],
    hookType: "problem_question",
    textProvider: "mock",
    ...overrides,
  });
}

export function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    title: "Roast day",
    hook: "Why does fresh coffee taste flat after two weeks?",
    hookType: "problem_question",
    script: "We roast on Tuesdays. Here is what happens to the beans after that.",
    onScreenText: ["Roast date matters"],
    shots: [{ order: 1, duration: "3 s", visual: "Beans cooling in the tray", text: "", audio: "" }],
    caption: "Roast date matters more than the label. Order this week's roast.",
    hashtags: ["coffee", "homebrew", "roastery", "filtercoffee", "beans"],
    cta: "Order this week's roast",
    ctaType: "buy",
    visualDirection: "Warm natural light",
    audioDirection: "Calm acoustic bed",
    thumbnailText: "Roast date",
    imagePrompt: "Coffee beans on a wooden counter",
    videoPrompt: "Slow push-in on cooling beans",
    voiceoverText: "We roast on Tuesdays.",
    altVersion: "",
    ...overrides,
  };
}

export function output(variants: Variant[] = [variant()], overrides: Partial<GenerationOutput> = {}): GenerationOutput {
  return {
    strategy: { angle: "Freshness", whyItFits: "Home brewers care", referencesUsed: [], repetitionCheck: "", emotionalDriver: "utility" },
    variants,
    selfReview: { score: 7, strengths: [], risks: [], complianceCheck: "" },
    ...overrides,
  };
}

export function generation(out: GenerationOutput, overrides: Partial<Generation> = {}): Generation {
  return {
    id: "gen_0001",
    brandId: "brand_demo",
    platform: "instagram",
    postType: "reel_script",
    status: "approved",
    brief: brief() as unknown as Generation["brief"],
    systemPrompt: "",
    userPrompt: "",
    provider: "anthropic",
    model: null,
    output: out as unknown as Generation["output"],
    outputText: "",
    referenceIds: [],
    priorGenIds: [],
    audioUrl: null,
    audioProvider: null,
    videoUrl: null,
    videoProvider: null,
    imageUrl: null,
    imageUrls: null,
    imageProvider: null,
    score: 7,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    notes: null,
    approvedAt: EPOCH,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

export function reference(overrides: Partial<ReferencePost> = {}): ReferencePost {
  const nulls = Object.fromEntries(
    [
      "date", "format", "pillar", "topic", "product", "hook", "hookType", "mainMessage", "visualConcept", "visualStyle", "colors",
      "typography", "people", "productPlacement", "captionStyle", "captionStructure", "cta", "ctaType", "views", "likes", "comments",
      "shares", "saves", "engagementIndicators", "performanceLevel", "performanceEvidence", "audienceReaction", "trendReference",
      "storytelling", "emotionalDriver", "contentMechanism", "replicability", "observations", "confidence", "sourceEvidence", "raw",
    ].map((k) => [k, null]),
  );
  return {
    ...nulls,
    id: "ref_0001",
    brandId: "brand_demo",
    platform: "instagram",
    postUrl: "https://example.com/p/1",
    source: "seed",
    searchText: "",
    createdAt: EPOCH,
    ...overrides,
  } as ReferencePost;
}
