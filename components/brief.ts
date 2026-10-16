/**
 * Brief helpers: defaults, platform/post-type coupling, provider availability and normalisation of
 * stored or reopened briefs against the live option catalog.
 */
import { BriefSchema, OPTION_GROUPS, POST_TYPES, PROVIDER_IDS, type Brief, type Option, type TextProviderId } from "@/lib/types";
import type { BrandOption, ProviderStatus } from "./types";

export const CUSTOM_PILLAR = "custom";

export const DEFAULT_BRIEF: Brief = BriefSchema.parse({
  brandSlug: "northwind-coffee",
  platform: "instagram",
  postType: "reel_script",
  goal: "awareness",
  pillar: CUSTOM_PILLAR,
});

export function postTypesFor(platform: string): Option[] {
  return POST_TYPES.filter((p) => !p.platforms || p.platforms.includes(platform));
}

export function optionLabel(group: keyof typeof OPTION_GROUPS, id: string): string {
  return OPTION_GROUPS[group].find((o) => o.id === id)?.label ?? id;
}

/** Preferred order when the stored provider is unavailable: the paid providers first, the keyless mock last. */
const PROVIDER_PREFERENCE: TextProviderId[] = ["anthropic", "openai", "gemini", "local", "mock"];

const VENDOR_NAMES: Partial<Record<TextProviderId, string>> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google" };

/** Friendly model name for the provider dropdown: claude-haiku-4-5 → "Claude Haiku 4.5", gpt-6-luna → "GPT-6 Luna". */
export function modelLabel(id: string | undefined): string {
  if (!id) return "";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) return `Claude ${cap(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = id.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${cap(gpt[2])}` : ""}`;
  const gemini = id.match(/^gemini-(\d+(?:\.\d+)?)-([a-z]+)$/);
  if (gemini) return `Gemini ${gemini[1]} ${cap(gemini[2])}`;
  return id;
}

/** Dropdown label of a configured text provider: "Claude Haiku 4.5 (Anthropic)"; other providers keep "<label> — <model>". */
export function providerLabel(provider: TextProviderId, baseLabel: string, model: string | undefined): string {
  if (!model) return baseLabel;
  const vendor = VENDOR_NAMES[provider];
  return vendor ? `${modelLabel(model)} (${vendor})` : `${baseLabel} — ${model}`;
}

export function firstConfiguredProvider(providers: ProviderStatus | null | undefined): TextProviderId | null {
  if (!providers) return null;
  for (const id of PROVIDER_PREFERENCE) if (providers.text[id]?.configured) return id;
  return null;
}

export function isProviderId(v: string): v is TextProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(v);
}

/** Platforms with research data for the brand (DB values may carry sub-family suffixes such as linkedin-showcase). */
export function brandPlatformIds(brand: BrandOption | undefined): string[] {
  if (!brand) return OPTION_GROUPS.platforms.map((p) => p.id);
  const ids = new Set<string>();
  for (const raw of brand.platforms) {
    const base = raw.split("-")[0];
    if (OPTION_GROUPS.platforms.some((p) => p.id === base)) ids.add(base);
  }
  return ids.size ? OPTION_GROUPS.platforms.map((p) => p.id).filter((id) => ids.has(id)) : OPTION_GROUPS.platforms.map((p) => p.id);
}

/**
 * Make a brief consistent with the catalog and the selected brand:
 * valid post type for the platform, pillar that exists (or custom), text provider that is configured.
 * The platform itself is never coerced: any catalog platform is allowed for any brand (retrieval backfills
 * references from the brand's other channels). Never throws; falls back to defaults field by field.
 */
export function normalizeBrief(input: Partial<Brief>, brands: BrandOption[], providers: ProviderStatus | null): Brief {
  const cleaned = stripInvalidEnums(input);
  const parsed = BriefSchema.safeParse({ ...DEFAULT_BRIEF, ...cleaned });
  const b: Brief = parsed.success ? parsed.data : { ...DEFAULT_BRIEF };

  if (brands.length && !brands.some((x) => x.slug === b.brandSlug)) b.brandSlug = brands[0].slug;
  const brand = brands.find((x) => x.slug === b.brandSlug);

  const types = postTypesFor(b.platform);
  if (!types.some((t) => t.id === b.postType)) b.postType = types[0]?.id ?? DEFAULT_BRIEF.postType;

  // No pillar chosen yet: start from the brand's first researched pillar instead of "custom".
  if (brand?.pillars.length && b.pillar === CUSTOM_PILLAR && !cleaned.pillar) b.pillar = brand.pillars[0];
  // No language chosen yet: start in the brand's first language.
  if (brand?.languages.length && !cleaned.language) b.language = brand.languages[0] === "de" ? "de" : "en";

  if (providers && !(isProviderId(b.textProvider) && providers.text[b.textProvider]?.configured)) {
    const fallback = firstConfiguredProvider(providers);
    if (fallback) b.textProvider = fallback;
  }
  if (providers && !providers.audio.elevenlabs.configured) b.audio = "none";
  if (providers && !providers.video.higgsfield.configured) b.video = "none";
  if (providers && !providers.image.configured) b.image = "none";
  return b;
}

/**
 * Voice used when none is picked and ELEVENLABS_VOICE_ID is not set: the best-fitting listed voice in the brief's language
 * (German for "de" and "de_en", whose main version is German). Personal clones and notes are skipped, calm, clear, trustworthy
 * voices rank first and ad, energetic or kids' voices last (brand content is usually calm rather than salesy). Shown selected in the
 * dropdowns, so it is never a hidden default.
 */
export function pickDefaultVoice(voices: { voiceId: string; name: string }[], language: string): string {
  const tag = language === "en" ? "(en)" : "(de)";
  const personal = /personal|note|clone/i;
  const fits = /trust|calm|clear|professional|natural|narrat|steady|warm/i;
  const loud = /\bads?\b|energetic|commercial|young|fierce|dominant|kids?|children|quirky|playful|husky/i;
  const score = (name: string) => (fits.test(name) ? 2 : 0) - (loud.test(name) ? 3 : 0);
  const usable = voices.filter((v) => !personal.test(v.name));
  const pool = usable.filter((v) => v.name.endsWith(tag));
  const best = (list: typeof voices) => list.reduce<(typeof voices)[number] | undefined>((a, v) => (a === undefined || score(v.name) > score(a.name) ? v : a), undefined);
  return (best(pool) ?? best(usable) ?? voices[0])?.voiceId ?? "";
}

/** Drop enum fields whose value is not in the catalog so zod falls back to defaults instead of rejecting everything. */
function stripInvalidEnums(input: Partial<Brief>): Partial<Brief> {
  const out: Record<string, unknown> = { ...input };
  const enumFields: Array<[keyof Brief, keyof typeof OPTION_GROUPS]> = [
    ["platform", "platforms"],
    ["postType", "postTypes"],
    ["goal", "goals"],
    ["hookType", "hookTypes"],
    ["tone", "tones"],
    ["language", "languages"],
    ["register", "registers"],
    ["length", "lengths"],
    ["emotionalDriver", "emotionalDrivers"],
    ["visualStyle", "visualStyles"],
    ["referenceStrategy", "referenceStrategies"],
    ["textProvider", "textProviders"],
    ["variants", "variantCounts"],
    ["audio", "audioOptions"],
    ["video", "videoOptions"],
    ["image", "imageOptions"],
  ];
  for (const [field, group] of enumFields) {
    const v = out[field];
    if (typeof v !== "string" || !OPTION_GROUPS[group].some((o) => o.id === v)) delete out[field];
  }
  const textLimits: Array<[keyof Brief, number]> = [
    ["topic", 2000],
    ["audience", 500],
    ["ctaOverride", 300],
    ["mustInclude", 1500],
    ["mustAvoid", 1500],
    ["sourceText", 20000],
    ["voiceId", 100],
    ["pillar", 200],
  ];
  for (const [field, max] of textLimits) {
    const v = out[field];
    if (typeof v !== "string") delete out[field];
    else if (v.length > max) out[field] = v.slice(0, max);
  }
  if (typeof out.pillar !== "string" || !out.pillar.trim()) delete out.pillar;
  if (typeof out.brandSlug !== "string" || !out.brandSlug.trim()) delete out.brandSlug;
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out as Partial<Brief>;
}

/** Sensible default frame for generated media given the post type / platform. */
export function defaultAspectRatio(brief: Pick<Brief, "platform" | "postType">): "9:16" | "4:5" | "1:1" | "16:9" {
  if (["reel_script", "story_sequence", "talking_head", "ugc_testimonial_brief"].includes(brief.postType)) {
    return brief.platform === "youtube" && brief.postType === "talking_head" ? "16:9" : "9:16";
  }
  if (brief.postType === "youtube_script") return "16:9";
  if (brief.platform === "linkedin" || brief.platform === "x") return brief.postType === "linkedin_document" ? "1:1" : "16:9";
  // Instagram and Facebook feed carousels and single images are 1080x1350 (the platform rules in the system prompt say so).
  if ((brief.platform === "instagram" || brief.platform === "facebook") && (brief.postType === "carousel" || brief.postType === "static_post")) return "4:5";
  return "1:1";
}
