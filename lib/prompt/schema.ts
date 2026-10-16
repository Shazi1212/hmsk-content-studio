/**
 * Output contract for the strategist: a human-readable rendering of GenerationOutputSchema (lib/types.ts),
 * the per-post-type mandatory sections (PROMPT-SPEC C.1), the length norms (C.2) and the hashtag ranges.
 * Pure data + pure functions; deterministic; no I/O.
 */
import { POST_TYPES, VARIANT_COUNTS } from "@/lib/types";

/** Variant fields that must be non-empty for every post type. */
export const ALWAYS_MANDATORY: readonly string[] = ["title", "hook", "hookType", "cta", "ctaType"];

/**
 * Additional mandatory (non-empty) variant fields per post type (PROMPT-SPEC C.1).
 * blog_to_social borrows the set of the native format mapped from the platform (see mappedPostType()).
 */
export const MANDATORY_SECTIONS: Record<string, readonly string[]> = {
  reel_script: ["script", "onScreenText", "shots", "caption", "hashtags", "visualDirection", "audioDirection", "voiceoverText", "videoPrompt"],
  talking_head: ["script", "onScreenText", "shots", "caption", "hashtags", "thumbnailText", "visualDirection", "audioDirection", "voiceoverText"],
  carousel: ["shots", "onScreenText", "caption", "hashtags", "visualDirection", "imagePrompt"],
  static_post: ["onScreenText", "caption", "hashtags", "visualDirection", "imagePrompt"],
  story_sequence: ["shots", "onScreenText", "visualDirection", "audioDirection"],
  linkedin_text: ["script", "caption", "hashtags"],
  linkedin_document: ["shots", "onScreenText", "caption", "hashtags", "visualDirection", "imagePrompt"],
  youtube_script: ["title", "script", "shots", "caption", "hashtags", "thumbnailText", "audioDirection", "voiceoverText"],
  ugc_testimonial_brief: ["script", "shots", "caption", "hashtags", "visualDirection", "audioDirection"],
  ad_creative: ["script", "caption", "thumbnailText", "onScreenText", "visualDirection"],
  // x thread repurposed from an article: the thread lives in script, one post per line.
  x_thread: ["script", "hashtags"],
};

/** Short notes appended to the mandatory list in the constraints line (C.1 "Notes" column). */
export const MANDATORY_NOTES: Record<string, string> = {
  reel_script: "thumbnailText recommended; shots carry a duration each and sum to the length band; first shot at most 2 s",
  talking_head: "shots = 3 to 5 framing beats; founder's face visible",
  carousel: "shots = slides; last slide = recap plus CTA",
  static_post: "hook = headline overlay; onScreenText = 1 to 2 lines",
  story_sequence: "shots = 3 to 6 frames with audio = sticker idea; caption and hashtags stay empty",
  linkedin_text: "cta = closing question; hashtags 3 to 6; no link in the body",
  linkedin_document: "shots = 7 to 12 pages; imagePrompt = cover",
  youtube_script: "title = 3 options pipe-separated; chapters every 60 to 90 s",
  ugc_testimonial_brief: "risks must contain 'real customer required, do not script claims'",
  ad_creative: "imagePrompt or videoPrompt in addition; hashtags empty; cta = button label",
  x_thread: "thread of 3 to 6 posts in script, one post per line; 0 to 1 hashtag",
};

/** Native format a blog_to_social brief is written in, by platform (PROMPT-SPEC conflict 7). */
export function mappedPostType(postType: string, platform: string): string {
  if (postType !== "blog_to_social") return postType;
  switch (platform) {
    case "linkedin":
      return "linkedin_text";
    case "instagram":
    case "facebook":
      return "carousel";
    case "tiktok":
    case "youtube":
      return "reel_script";
    case "x":
      return "x_thread";
    default:
      return "carousel";
  }
}

/** Full ordered list of mandatory non-empty variant fields for a brief (always + per post type). */
export function mandatorySectionsFor(postType: string, platform: string): string[] {
  const effective = mappedPostType(postType, platform);
  const extra = MANDATORY_SECTIONS[effective] ?? [];
  const out: string[] = [];
  for (const f of [...ALWAYS_MANDATORY, ...extra]) if (!out.includes(f)) out.push(f);
  return out;
}

/** Length norms per band and post type (PROMPT-SPEC C.2). */
export const LENGTH_NORMS: Record<string, { short: string; medium: string; long: string }> = {
  reel_script: {
    short: "15 to 25 s, caption at most 80 words (at most 4 lines)",
    medium: "25 to 45 s, caption 80 to 150 words",
    long: "45 to 60 s, caption 150 to 300 words",
  },
  talking_head: { short: "20 to 30 s", medium: "30 to 60 s", long: "60 to 90 s" },
  carousel: { short: "5 to 6 slides", medium: "7 to 8 slides", long: "9 to 10 slides" },
  static_post: { short: "caption at most 80 words", medium: "caption 80 to 150 words", long: "caption 150 to 300 words" },
  story_sequence: { short: "3 frames", medium: "4 to 5 frames", long: "6 frames" },
  linkedin_text: { short: "at most 120 words", medium: "150 to 250 words", long: "300 to 500 words" },
  linkedin_document: { short: "7 pages", medium: "8 to 10 pages", long: "10 to 12 pages" },
  youtube_script: { short: "3 to 4 min", medium: "5 to 6 min", long: "6 to 8 min" },
  ugc_testimonial_brief: {
    short: "6 questions, 20 to 30 s edit",
    medium: "8 questions, 30 to 45 s edit",
    long: "10 questions, 45 to 60 s edit",
  },
  ad_creative: {
    short: "fixed: SHORT at most 125, MEDIUM at most 300, LONG at most 600 characters",
    medium: "fixed: SHORT at most 125, MEDIUM at most 300, LONG at most 600 characters",
    long: "fixed: SHORT at most 125, MEDIUM at most 300, LONG at most 600 characters",
  },
  x_thread: { short: "1 post", medium: "3 to 4 posts", long: "5 to 6 posts" },
};

/** Length norm line for a brief; blog_to_social resolves to the mapped format's row. */
export function lengthNormFor(postType: string, platform: string, band: string): string {
  const effective = mappedPostType(postType, platform);
  const row = LENGTH_NORMS[effective];
  const key = band === "short" || band === "medium" || band === "long" ? band : "medium";
  const norm = row ? row[key] : "platform default";
  return postType === "blog_to_social" ? `mapped format (${effective}): ${norm}` : norm;
}

/** Hashtag count ranges per platform (PROMPT-SPEC conflict 9). Ads always 0; premium_minimal tone caps at 3. */
export const HASHTAG_RANGES: Record<string, { min: number; max: number }> = {
  instagram: { min: 5, max: 8 },
  facebook: { min: 5, max: 8 },
  tiktok: { min: 3, max: 5 },
  linkedin: { min: 3, max: 6 },
  youtube: { min: 3, max: 5 },
  x: { min: 0, max: 1 },
};

export function hashtagRangeFor(platform: string, postType: string, tone?: string): { min: number; max: number } {
  if (postType === "ad_creative") return { min: 0, max: 0 };
  if (postType === "story_sequence") return { min: 0, max: 0 };
  const base = HASHTAG_RANGES[platform] ?? { min: 0, max: 8 };
  if (tone === "premium_minimal") return { min: Math.min(base.min, 3), max: Math.min(base.max, 3) };
  return base;
}

export const VALID_CTA_TYPES: readonly string[] = ["follow", "share", "link", "lead", "buy", "comment", "save", "proof", "community"];

/**
 * Human-readable JSON contract (PROMPT-SPEC A.4). Contains two placeholders, {{MANDATORY_SECTIONS_LINE}} and
 * {{VARIANT_COUNT}}, which renderOutputContract() fills for the selected brief. Wording kept verbatim from the spec.
 */
export const OUTPUT_JSON_INSTRUCTIONS: string = `OUTPUT: one JSON object, shape:
{"strategy":{"angle":str,"whyItFits":str,"referencesUsed":[str],"repetitionCheck":str,"emotionalDriver":str},
 "variants":[{"title":str,"hook":str,"hookType":str,"script":str,"onScreenText":[str],
   "shots":[{"order":int,"duration":str,"visual":str,"text":str,"audio":str}],
   "caption":str,"hashtags":[str],"cta":str,"ctaType":str,"visualDirection":str,"audioDirection":str,
   "thumbnailText":str,"imagePrompt":str,"videoPrompt":str,"voiceoverText":str,"altVersion":str}],
 "selfReview":{"score":1-10,"strengths":[str],"risks":[str],"complianceCheck":str}}
Field meaning: title = working title naming the angle; hook = first line / first 2 s, stands alone; hookType = one of
the hook ids; script = spoken script or full body text; onScreenText = overlays in order; shots = shot list (video)
or slide/page/frame list; caption = final paste-ready post text; hashtags without '#' duplicates, lowercase where the
brand does so; cta = the one next step; ctaType = one of follow, share, link, lead, buy, comment, save, proof,
community; visualDirection / audioDirection = executable production notes; thumbnailText = at most 4 words;
imagePrompt / videoPrompt = English model prompts (videoPrompt = one clip of 3 to 15 s); voiceoverText = TTS-clean prose; altVersion = only for de_en.
Mandatory per post type: {{MANDATORY_SECTIONS_LINE}}. Return exactly {{VARIANT_COUNT}} variants.`;

/** Renders the mandatory-sections line for a brief: "<postType label>: field, field, ... (notes)". */
export function mandatorySectionsLine(postType: string, platform: string): string {
  const label = POST_TYPES.find((p) => p.id === postType)?.label ?? postType;
  const effective = mappedPostType(postType, platform);
  const fields = mandatorySectionsFor(postType, platform).join(", ");
  const note = MANDATORY_NOTES[effective];
  const mapped = postType === "blog_to_social" ? ` (native format for ${platform}: ${effective})` : "";
  return `${label}${mapped}: ${fields}${note ? ` (${note})` : ""}`;
}

/** OUTPUT_JSON_INSTRUCTIONS with both placeholders filled for the selected brief. */
export function renderOutputContract(p: { postType: string; platform: string; variants: string | number }): string {
  const n = String(p.variants);
  const count = VARIANT_COUNTS.some((v) => v.id === n) ? n : "1";
  return OUTPUT_JSON_INSTRUCTIONS.replace("{{MANDATORY_SECTIONS_LINE}}", mandatorySectionsLine(p.postType, p.platform)).replace(
    "{{VARIANT_COUNT}}",
    count,
  );
}
