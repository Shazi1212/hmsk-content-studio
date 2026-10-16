import { z } from "zod";

/**
 * Option catalog for the single-page brief form. Every dropdown in the UI is generated from these lists,
 * and every value is interpreted by lib/prompt/* when the prompt is built. Keep ids stable: they are stored
 * in Generation.brief and used for repetition checks.
 */

export type Option = { id: string; label: string; hint?: string; platforms?: string[] };

export const PLATFORMS: Option[] = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X (Twitter)" },
];

export const POST_TYPES: Option[] = [
  { id: "reel_script", label: "Reel / TikTok / Short — video script", hint: "15–60 s: hook, VO, on-screen text, shot list, caption", platforms: ["instagram", "tiktok", "youtube", "facebook"] },
  { id: "talking_head", label: "Talking-head video (founder / creator)", hint: "Teleprompter script + captions + thumbnail line", platforms: ["instagram", "tiktok", "linkedin", "youtube", "facebook"] },
  { id: "carousel", label: "Carousel (slides)", hint: "5–10 slides with headline + body + visual note, plus caption", platforms: ["instagram", "linkedin", "facebook"] },
  { id: "static_post", label: "Static image post", hint: "Headline overlay, image brief, caption", platforms: ["instagram", "linkedin", "facebook", "x"] },
  { id: "story_sequence", label: "Story sequence", hint: "3–6 frames with sticker/interaction ideas", platforms: ["instagram", "facebook"] },
  { id: "linkedin_text", label: "LinkedIn text post", hint: "Hook line, line-by-line body, closing question", platforms: ["linkedin"] },
  { id: "linkedin_document", label: "LinkedIn document carousel (PDF)", hint: "7–10 pages + accompanying post text", platforms: ["linkedin"] },
  { id: "youtube_script", label: "YouTube long-form script", hint: "3–8 min: titles, hook, chapters, B-roll, description", platforms: ["youtube"] },
  { id: "ugc_testimonial_brief", label: "Customer testimonial / UGC brief", hint: "Interview questions, edit structure, disclaimer", platforms: ["instagram", "tiktok", "youtube", "facebook"] },
  { id: "ad_creative", label: "Paid ad creative", hint: "Primary text variants, headline, description, asset brief", platforms: ["instagram", "facebook", "tiktok", "linkedin", "youtube"] },
  { id: "blog_to_social", label: "Repurpose article / URL into posts", hint: "Turns a source text into a platform-native post set", platforms: ["instagram", "linkedin", "tiktok", "x", "facebook"] },
];

export const GOALS: Option[] = [
  { id: "awareness", label: "Awareness / reach" },
  { id: "traffic", label: "Website traffic" },
  { id: "lead", label: "Lead (DM, audit, trial, sign-up)" },
  { id: "purchase", label: "Purchase / subscription" },
  { id: "engagement", label: "Engagement (comments, replies)" },
  { id: "save_share", label: "Saves & shares" },
  { id: "follow", label: "Follows" },
  { id: "trust", label: "Trust / social proof" },
  { id: "retention", label: "Retention / community" },
];

export const HOOK_TYPES: Option[] = [
  { id: "auto", label: "Let the strategist choose" },
  { id: "problem_question", label: "Problem question" },
  { id: "statistic", label: "Statistic / number" },
  { id: "contrarian", label: "Contrarian statement" },
  { id: "story_scene", label: "Story / scene opener" },
  { id: "time_stamped_scene", label: "Time-stamped scene (\"Montag, 9:12 Uhr…\")" },
  { id: "pattern_interrupt", label: "Pattern interrupt" },
  { id: "curiosity", label: "Curiosity gap" },
  { id: "how_to", label: "How-to / utility" },
  { id: "myth_bust", label: "Myth vs. fact" },
  { id: "listicle", label: "Numbered list" },
  { id: "social_proof", label: "Social proof / testimonial" },
  { id: "aphorism", label: "Aphorism / two-line contrast" },
  { id: "pov_relatable", label: "POV / relatable humor" },
];

export const TONES: Option[] = [
  { id: "brand_default", label: "Brand default voice" },
  { id: "sober_factual", label: "Sober, factual, numbers first" },
  { id: "confident_direct", label: "Confident and direct" },
  { id: "warm_reassuring", label: "Warm and reassuring" },
  { id: "motivational", label: "Motivational" },
  { id: "educational_expert", label: "Educational expert" },
  { id: "candid_founder", label: "Candid founder voice" },
  { id: "premium_minimal", label: "Premium, minimal" },
  { id: "playful", label: "Playful" },
];

export const LANGUAGES: Option[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
  { id: "de_en", label: "Deutsch + English version" },
];

export const REGISTERS: Option[] = [
  { id: "brand_default", label: "Brand default (du / Sie)" },
  { id: "du", label: "du (informal)" },
  { id: "sie", label: "Sie (formal)" },
];

export const LENGTHS: Option[] = [
  { id: "short", label: "Short" },
  { id: "medium", label: "Medium" },
  { id: "long", label: "Long" },
];

export const EMOTIONAL_DRIVERS: Option[] = [
  { id: "auto", label: "Let the strategist choose" },
  { id: "curiosity", label: "Curiosity" },
  { id: "trust", label: "Trust" },
  { id: "relief", label: "Relief" },
  { id: "desire", label: "Desire" },
  { id: "aspiration", label: "Aspiration" },
  { id: "discipline", label: "Discipline" },
  { id: "identification", label: "Identification (\"that's me\")" },
  { id: "utility", label: "Utility" },
  { id: "humor", label: "Humor" },
  { id: "loss_aversion", label: "Loss aversion" },
  { id: "inspiration", label: "Inspiration" },
];

export const VISUAL_STYLES: Option[] = [
  { id: "brand_default", label: "Brand default visual system" },
  { id: "product_studio", label: "Product studio shot" },
  { id: "ugc_handheld", label: "UGC / handheld" },
  { id: "talking_head", label: "Talking head" },
  { id: "text_overlay_graphic", label: "Text-overlay graphic video" },
  { id: "infographic_card", label: "Infographic card" },
  { id: "typographic_card", label: "Typographic quote card" },
  { id: "screen_recording_ui", label: "Screen recording / product UI" },
  { id: "stock_lifestyle", label: "Stock lifestyle photo" },
  { id: "ai_generated", label: "AI-generated imagery" },
];

export const REFERENCE_STRATEGIES: Option[] = [
  { id: "avoid_repeats", label: "Reference history, avoid repeating past posts (default)" },
  { id: "model_high_performers", label: "Model the brand's high performers" },
  { id: "fresh_angle", label: "Fresh angle: avoid pillars/hooks used recently" },
  { id: "none", label: "No historical references" },
];

/** Dropdown order; the first configured entry is the default (Anthropic Claude Haiku 4.5, then OpenAI GPT-6 Luna). */
export const TEXT_PROVIDERS: Option[] = [
  { id: "anthropic", label: "Anthropic Claude" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Google Gemini" },
  { id: "local", label: "Local / OpenAI-compatible (LM Studio, Ollama, OpenRouter)" },
  { id: "mock", label: "Mock strategist (no API, for testing the pipeline)" },
];

export const AUDIO_OPTIONS: Option[] = [
  { id: "none", label: "No audio" },
  { id: "elevenlabs_voiceover", label: "Voice-over (ElevenLabs)" },
];

export const VIDEO_OPTIONS: Option[] = [
  { id: "none", label: "No video" },
  { id: "higgsfield_text2video", label: "Video from text prompt (Higgsfield)" },
  {
    id: "higgsfield_image2video",
    label: "Video from image (Higgsfield)",
    hint: "Needs a public image URL: the generated key visual is hosted by the app and used automatically, or paste the https URL of an image you host yourself.",
  },
];

export const IMAGE_OPTIONS: Option[] = [
  { id: "none", label: "No image" },
  { id: "gemini_image", label: "Key visual (image model)" }, // id kept: saved briefs reference it
];

export const VARIANT_COUNTS: Option[] = [
  { id: "1", label: "1 variant" },
  { id: "2", label: "2 variants" },
  { id: "3", label: "3 variants" },
];

export const OPTION_GROUPS = {
  platforms: PLATFORMS,
  postTypes: POST_TYPES,
  goals: GOALS,
  hookTypes: HOOK_TYPES,
  tones: TONES,
  languages: LANGUAGES,
  registers: REGISTERS,
  lengths: LENGTHS,
  emotionalDrivers: EMOTIONAL_DRIVERS,
  visualStyles: VISUAL_STYLES,
  referenceStrategies: REFERENCE_STRATEGIES,
  textProviders: TEXT_PROVIDERS,
  audioOptions: AUDIO_OPTIONS,
  videoOptions: VIDEO_OPTIONS,
  imageOptions: IMAGE_OPTIONS,
  variantCounts: VARIANT_COUNTS,
};

const ids = (o: Option[]) => o.map((x) => x.id) as [string, ...string[]];

/** Everything the user selects on the page. Sent to POST /api/generate and stored in Generation.brief. */
export const BriefSchema = z.object({
  brandSlug: z.string().min(1),
  platform: z.enum(ids(PLATFORMS)),
  postType: z.enum(ids(POST_TYPES)),
  goal: z.enum(ids(GOALS)),
  pillar: z.string().min(1), // brand pillar id/label from Brand.pillars, or "custom"
  topic: z.string().max(2000).default(""), // free text: subject, angle, campaign, offer
  hookType: z.enum(ids(HOOK_TYPES)).default("auto"),
  tone: z.enum(ids(TONES)).default("brand_default"),
  language: z.enum(ids(LANGUAGES)).default("en"),
  register: z.enum(ids(REGISTERS)).default("brand_default"),
  length: z.enum(ids(LENGTHS)).default("medium"),
  emotionalDriver: z.enum(ids(EMOTIONAL_DRIVERS)).default("auto"),
  visualStyle: z.enum(ids(VISUAL_STYLES)).default("brand_default"),
  audience: z.string().max(500).default(""), // persona id/label from brand or free text
  ctaOverride: z.string().max(300).default(""), // exact CTA/link to use if any
  mustInclude: z.string().max(1500).default(""),
  mustAvoid: z.string().max(1500).default(""),
  sourceText: z.string().max(20000).default(""), // for blog_to_social: pasted article text or URL
  referenceStrategy: z.enum(ids(REFERENCE_STRATEGIES)).default("avoid_repeats"),
  textProvider: z.enum(ids(TEXT_PROVIDERS)).default("anthropic"),
  variants: z.enum(ids(VARIANT_COUNTS)).default("1"),
  audio: z.enum(ids(AUDIO_OPTIONS)).default("none"),
  voiceId: z.string().max(100).default(""),
  video: z.enum(ids(VIDEO_OPTIONS)).default("none"),
  image: z.enum(ids(IMAGE_OPTIONS)).default("none"),
});
export type Brief = z.infer<typeof BriefSchema>;

/** Structured result the strategist must return (one object per variant). Sections not relevant to a post type stay empty. */
export const VariantSchema = z.object({
  title: z.string().describe("Internal working title"),
  hook: z.string().describe("First line / first 2 seconds; must stand alone"),
  hookType: z.string().default(""),
  script: z.string().default("").describe("Voice-over or spoken script, or the full body text for text posts"),
  onScreenText: z.array(z.string()).default([]).describe("Text overlays in order of appearance"),
  shots: z
    .array(
      z.object({
        order: z.number(),
        duration: z.string().default(""),
        visual: z.string(),
        text: z.string().default(""),
        audio: z.string().default(""),
      }),
    )
    .default([])
    .describe("Shot list (video) or slide list (carousel/document)"),
  caption: z.string().default("").describe("Platform caption / post text, final and ready to paste"),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default(""),
  ctaType: z.string().default(""),
  visualDirection: z.string().default("").describe("Colors, type, framing, product placement, people"),
  audioDirection: z.string().default("").describe("Music mood, VO style, pacing"),
  thumbnailText: z.string().default(""),
  imagePrompt: z.string().default("").describe("Prompt for the key visual (image model), in English"),
  videoPrompt: z.string().default("").describe("Prompt for the video model, in English, with camera + motion"),
  voiceoverText: z.string().default("").describe("Clean text for TTS (no emojis, no brackets)"),
  altVersion: z.string().default("").describe("Second-language version when de_en is selected"),
});

export const GenerationOutputSchema = z.object({
  strategy: z.object({
    angle: z.string(),
    whyItFits: z.string().describe("Why this angle fits the brand, goal and audience"),
    referencesUsed: z.array(z.string()).default([]).describe("Which past posts informed it and how"),
    repetitionCheck: z.string().default("").describe("What was deliberately avoided to not repeat past posts"),
    emotionalDriver: z.string().default(""),
  }),
  variants: z.array(VariantSchema).min(1),
  selfReview: z.object({
    score: z.number().min(1).max(10),
    strengths: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    complianceCheck: z.string().default("").describe("Claims verified against brand facts/guardrails"),
  }),
});
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;
export type Variant = z.infer<typeof VariantSchema>;

export const PROVIDER_IDS = ["local", "gemini", "anthropic", "openai", "mock"] as const;
export type TextProviderId = (typeof PROVIDER_IDS)[number];
