/**
 * Content language safety: a deterministic second look at a generated draft, run after the parser lint.
 * Pure: no network, no database, no clock. Every finding is a warning; nothing here blocks approval.
 *
 * Checks (each can be tuned through LanguageSafetyOptions):
 * - mixed_language: sentences in the other language (German draft with English sentences, or the reverse). Single loan
 *   words ("Meeting", "Workflow") never trigger it; a sentence has to read as the other language as a whole.
 * - banned_phrase: the brand's own banned phrases (Brands tab), case-insensitive, whole words. Empty by default.
 * - ai_phrase: wording that reads as generic machine copy ("game-changer", "in der heutigen schnelllebigen Welt").
 * - hashtag_limit / emoji_limit: more hashtags or emoji in the posted text than the platform's limit.
 *
 * Output: lint-style strings `<code>:<detail> (v<n>)`, shown in the review screen as "Language safety".
 */
import type { GenerationOutput, Variant } from "@/lib/types";
import { hashtagRangeFor } from "@/lib/prompt/schema";

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

/** Phrases that make copy read as generic machine output. Matched case-insensitively as whole words. */
export const DEFAULT_AI_PHRASES: Record<"en" | "de", readonly string[]> = {
  en: [
    "game-changer",
    "game changer",
    "in today's fast-paced world",
    "in today's digital age",
    "in the ever-evolving",
    "ever-evolving landscape",
    "unlock the power",
    "unlock your potential",
    "unleash",
    "harness the power",
    "delve into",
    "let's dive in",
    "dive deep into",
    "take it to the next level",
    "next-level",
    "elevate your",
    "revolutionize",
    "revolutionise",
    "cutting-edge",
    "seamlessly",
    "supercharge",
    "embark on a journey",
    "navigate the complexities",
    "a testament to",
    "rich tapestry",
    "look no further",
    "say goodbye to",
    "whether you're a",
    "it's not just about",
    "the secret sauce",
  ],
  de: [
    "in der heutigen schnelllebigen welt",
    "in der heutigen digitalen welt",
    "in einer welt, in der",
    "tauchen wir ein",
    "lass uns eintauchen",
    "taucht ein in",
    "auf das nächste level",
    "aufs nächste level",
    "gamechanger",
    "game-changer",
    "bahnbrechend",
    "revolutionär",
    "nahtlos",
    "entfessle",
    "entfesseln",
    "volles potenzial",
    "das volle potenzial",
    "potenzial entfalten",
    "begib dich auf eine reise",
    "eine reise durch",
    "sag adieu zu",
    "im handumdrehen",
    "mehrwert bieten",
    "ganzheitlich",
    "maßgeschneidert",
  ],
};

/** Emoji allowed in the posted text (hook + caption + on-screen text) per platform before a warning. */
export const EMOJI_LIMITS: Record<string, number> = {
  instagram: 5,
  facebook: 5,
  tiktok: 5,
  youtube: 3,
  linkedin: 3,
  x: 2,
};
const DEFAULT_EMOJI_LIMIT = 5;

export type LanguageSafetyOptions = {
  /** Output language of the brief. de_en: the main version is German, altVersion English. */
  language: string;
  platform: string;
  postType: string;
  tone?: string;
  /** The brand's banned phrases (Brands tab). */
  bannedPhrases?: readonly string[];
  /** false switches the AI-phrase list off (brand setting). */
  aiPhraseCheck?: boolean;
  /** Replaces the default AI-phrase lists. */
  aiPhrases?: Partial<Record<"en" | "de", readonly string[]>>;
  /** Overrides the platform emoji limit. */
  maxEmoji?: number;
  /** Overrides the platform hashtag maximum (default: the brief's hashtag range from lib/prompt/schema.ts). */
  maxHashtags?: number;
};

// ---------------------------------------------------------------------------------------------------------------
// Language detection (sentence level)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Short function words that are frequent in one language and do not exist (or mean something else) in the other. Words
 * spelled the same in both ("in", "so", "was", "will", "also", "man", "hat") are deliberately left out.
 */
const EN_MARKERS = new Set(
  (
    "the and is are were be been this that these those with what which who why how when where your you you're it's " +
    "of to for from have has had would could should can't don't doesn't isn't we our they their there here just " +
    "about into than then because while every only more most very not my me its it them"
  ).split(" "),
);
const DE_MARKERS = new Set(
  (
    "der die das und ist sind waren sein nicht mit für von auf aus bei zum zur den dem des ein eine einen einem einer " +
    "ich du er wir ihr sie es dein deine euer unser unsere mein meine kein keine auch noch schon nur wie wer warum " +
    "wann wo weil dass oder aber doch mal sehr mehr dir dich uns euch hier dann wenn jetzt immer gibt haben wird werden"
  ).split(" "),
);

export type DetectedLanguage = "en" | "de" | "unknown";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Language of one sentence or line: "unknown" when it is too short or the evidence is thin. Umlauts and ß count as German
 * evidence; a sentence needs at least two marker words and a clear majority.
 */
export function detectLanguage(text: string): DetectedLanguage {
  const ws = words(text);
  if (ws.length < 4) return "unknown";
  let en = 0;
  let de = 0;
  for (const w of ws) {
    if (EN_MARKERS.has(w)) en++;
    if (DE_MARKERS.has(w)) de++;
    if (/[äöüß]/.test(w)) de++;
  }
  if (en >= 2 && en >= de * 2 + 1) return "en";
  if (de >= 2 && de >= en * 2 + 1) return "de";
  return "unknown";
}

/** Sentences and lines of a text (line breaks and sentence ends split; hashtag-only lines dropped). */
export function segments(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\d"„«])/u)
    .map((s) => s.trim())
    .filter((s) => s && !/^(#\S+\s*)+$/.test(s));
}

// ---------------------------------------------------------------------------------------------------------------
// Counting helpers
// ---------------------------------------------------------------------------------------------------------------

// Emoji as people see them: a flag (two regional indicators), or a pictograph shown as emoji, with an optional skin tone and
// ZWJ-joined parts counted once. Text-style symbols such as © or ™ (no emoji variation selector) and digits do not count.
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}]{2}|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\uFE0F?[\u{1F3FB}-\u{1F3FF}]?(?:\u200D\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?)*/gu;

export function countEmoji(text: string): number {
  return text.match(EMOJI_RE)?.length ?? 0;
}

/** Hashtags of a variant: the hashtag list plus inline #tags in the caption, deduplicated case-insensitively. */
export function variantHashtags(v: Pick<Variant, "hashtags" | "caption">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const inline = v.caption.match(/(?<![\p{L}\p{N}&/])#[\p{L}\p{N}_]+/gu) ?? [];
  for (const raw of [...v.hashtags, ...inline]) {
    const tag = raw.replace(/^#+/, "").trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive match; whitespace inside the phrase matches any whitespace run. */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = phrase.trim();
  if (!p) return false;
  const body = escapeRegExp(p.replace(/[’`]/g, "'")).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu").test(text.replace(/[’`]/g, "'"));
}

const clipQuote = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------------------------------------------

/** Fields a reader sees, in the brief's main language. Model prompts (imagePrompt, videoPrompt) are English by design. */
const READER_FIELDS = ["hook", "script", "caption", "cta", "thumbnailText", "voiceoverText"] as const;

function readerText(v: Variant): Array<[string, string]> {
  return [
    ...READER_FIELDS.map((f) => [f, v[f]] as [string, string]),
    ["onScreenText", v.onScreenText.join("\n")],
    ["shots", v.shots.map((s) => s.text).filter(Boolean).join("\n")],
  ];
}

function mixedLanguage(field: string, text: string, expected: "en" | "de", tag: string): string | null {
  const segs = segments(text);
  const wrong = segs.filter((s) => {
    const d = detectLanguage(s);
    return d !== "unknown" && d !== expected;
  });
  if (!wrong.length) return null;
  const other = expected === "de" ? "English" : "German";
  const main = expected === "de" ? "German" : "English";
  return `mixed_language:${field} has ${wrong.length} ${other} sentence${wrong.length > 1 ? "s" : ""} in ${expected === "en" ? "an" : "a"} ${main} draft: "${clipQuote(wrong[0])}" (${tag})`;
}

export function checkLanguageSafety(output: GenerationOutput, opts: LanguageSafetyOptions): string[] {
  const warnings: string[] = [];
  const main: "en" | "de" | null = opts.language === "en" ? "en" : opts.language === "de" || opts.language === "de_en" ? "de" : null;
  const banned = (opts.bannedPhrases ?? []).map((p) => p.trim()).filter(Boolean);
  const aiLists = {
    en: opts.aiPhrases?.en ?? DEFAULT_AI_PHRASES.en,
    de: opts.aiPhrases?.de ?? DEFAULT_AI_PHRASES.de,
  };
  const aiPhrases = opts.aiPhraseCheck === false ? [] : opts.language === "en" ? aiLists.en : opts.language === "de" ? aiLists.de : [...aiLists.de, ...aiLists.en];
  const maxHashtags = opts.maxHashtags ?? hashtagRangeFor(opts.platform, opts.postType, opts.tone).max;
  const maxEmoji = opts.maxEmoji ?? EMOJI_LIMITS[opts.platform] ?? DEFAULT_EMOJI_LIMIT;

  output.variants.forEach((v, idx) => {
    const tag = `v${idx + 1}`;
    const fields = readerText(v);

    if (main) {
      for (const [field, text] of fields) {
        const w = text.trim() ? mixedLanguage(field, text, main, tag) : null;
        if (w) warnings.push(w);
      }
      if (opts.language === "de_en" && v.altVersion.trim()) {
        const w = mixedLanguage("altVersion", v.altVersion, "en", tag);
        if (w) warnings.push(w);
      }
    }

    const all = [...fields.map(([, t]) => t), v.title, v.altVersion].join("\n");
    for (const phrase of banned) if (containsPhrase(all, phrase)) warnings.push(`banned_phrase:"${phrase}" (${tag})`);
    for (const phrase of aiPhrases) if (containsPhrase(all, phrase)) warnings.push(`ai_phrase:"${phrase}" (${tag})`);

    const tags = variantHashtags(v);
    if (tags.length > maxHashtags) warnings.push(`hashtag_limit:${tags.length} hashtags, ${opts.platform} limit ${maxHashtags} (${tag})`);

    const posted = [v.hook, v.caption, ...v.onScreenText].join("\n");
    const emoji = countEmoji(posted);
    if (emoji > maxEmoji) warnings.push(`emoji_limit:${emoji} emoji, ${opts.platform} limit ${maxEmoji} (${tag})`);
  });

  return [...new Set(warnings)];
}
