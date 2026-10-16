/**
 * Ideas prompt: a short, structured brainstorming brief for a small local model. The category rule is the one the Create tab
 * uses and the brand block is a shortened version of it (guardrails and pillars in full, the rest cut to its first sentences),
 * so the two tabs never disagree about the brand; everything else is tuned for brevity.
 *
 * Brevity is a hard requirement here, not a nicety: a small local model may read only about 40 prompt tokens per second, and a tunnel in front of it
 * answers 524 when the first byte of the reply takes longer than 120 s. The full Create-tab brand block made this prompt about
 * 3,200 tokens (80 s of prefill, plus a model swap or a queue: a 524 every time); the compact one is about half of that.
 * Deterministic, no I/O.
 */
import type { Brand, ReferencePost } from "@prisma/client";
import { GOALS, HOOK_TYPES, PLATFORMS, POST_TYPES } from "@/lib/types";
import { brandCategoryRules, PLATFORM_RULES } from "@/lib/prompt/system";
import { performanceBucket, truncateWords } from "@/lib/prompt/user";
import type { IdeasParams } from "./types";

/** Formats an idea may name: the organic post types that exist on the platform (no ads, no repurposing). */
export function ideaFormatsFor(platform: string): { id: string; label: string }[] {
  return POST_TYPES.filter((p) => p.platforms?.includes(platform) && p.id !== "blog_to_social" && p.id !== "ad_creative").map((p) => ({
    id: p.id,
    label: p.label.split(" — ")[0],
  }));
}

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const labelOf = (list: { id: string; label: string }[], id: string): string => list.find((o) => o.id === id)?.label ?? id;

const MAX_HIGH = 4;
const MAX_LOW = 2;
const MAX_USED = 12;


/** The brand facts a brainstorm needs. Guardrails and pillars stay verbatim; description, audience, voice and offers keep their first sentences. */
export function ideasBrandBlock(brand: Brand): string {
  const pillars = brand.pillars.length ? brand.pillars.map((p, i) => `${i + 1}. ${p}`).join("\n") : "(none listed)";
  return [
    `NAME: ${brand.name}`,
    `TAGLINE: ${brand.tagline ?? ""}`,
    `DESCRIPTION: ${truncateWords(brand.description, 60)}`,
    `AUDIENCE: ${truncateWords(brand.audience, 45)}`,
    `VOICE: ${truncateWords(brand.voice, 60)}`,
    `OFFERS (the only facts an idea may use): ${truncateWords(brand.offers, 40)}`,
    `GUARDRAILS: ${brand.guardrails}`,
    `PILLARS:\n${pillars}`,
    `LANGUAGES: ${brand.languages.join(", ")}`,
  ].join("\n");
}

export type IdeasPromptInput = {
  brand: Brand;
  params: IdeasParams;
  /** Output of selectReferences: high/exceptional first, then typical, then low. */
  references: ReferencePost[];
  /** Hooks that must not come back: recent posts, approved generations, earlier idea batches. Most relevant first. */
  usedHooks: string[];
  today: string;
};

function referenceLine(r: ReferencePost, failed: boolean): string {
  const meta = [r.platform, clean(r.format), clean(r.hookType)].filter(Boolean).join(", ");
  const note = failed
    ? truncateWords(r.observations, 18) || truncateWords(r.contentMechanism, 18)
    : truncateWords(r.contentMechanism, 18) || truncateWords(r.observations, 18);
  const tail = note ? ` ${failed ? "why it fell flat" : "mechanism"}: ${note}` : "";
  return `- «${clean(r.hook)}» (${meta})${tail}`;
}

export function buildIdeasPrompt(input: IdeasPromptInput): { system: string; user: string } {
  const { brand, params, references, usedHooks, today } = input;
  const platformLabel = labelOf(PLATFORMS, params.platform);
  const german = params.language === "de";
  const formats = ideaFormatsFor(params.platform);
  const hookTypes = HOOK_TYPES.filter((h) => h.id !== "auto");

  const system = [
    "You are a senior social-media content strategist. Right now you brainstorm: you pitch post ideas that a strategist will turn into scripts later. You do not write the posts.",
    "",
    "BRAND",
    ideasBrandBlock(brand),
    brandCategoryRules(brand) ? `\n${brandCategoryRules(brand)}` : "",
    "",
    "RULES",
    "1. Fit the brand: audience, voice, offers, guardrails. Never break a guardrail. Never invent facts, numbers, customers, prices or results.",
    "2. One idea = one specific post. The hook stands alone (first line or first two seconds); the angle makes it concrete: a scene, a number, a contrast, a question, a demonstration. No generic advice.",
    "3. The ideas of one batch differ: other pillars, hook types, formats, emotional drivers.",
    "4. Build on the mechanism of what performed, avoid what fell flat, never copy a reference hook.",
    "5. Do not repeat or paraphrase anything under ALREADY USED.",
    `6. Write in ${german ? "German" : "English"}, in the brand's register. Hook: at most 140 characters, no hashtags, no emojis, no exclamation marks.`,
    "",
    "OUTPUT",
    'Return exactly one JSON object and nothing else (no Markdown, no commentary): {"ideas":[{"hook":"","angle":"","format":"","pillar":"","hookType":"","why":""}]}',
    `- format: one of ${formats.map((f) => f.id).join(", ")}`,
    "- pillar: copy one of the brand's pillars verbatim",
    `- hookType: one of ${hookTypes.map((h) => h.id).join(", ")}`,
    "- angle: one or two sentences. why: one sentence naming the reference mechanism or the audience insight it builds on.",
  ]
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n");

  const high = references.filter((r) => ["exceptional", "high"].includes(performanceBucket(r.performanceLevel)) && clean(r.hook)).slice(0, MAX_HIGH);
  const low = references.filter((r) => performanceBucket(r.performanceLevel) === "low" && clean(r.hook)).slice(0, MAX_LOW);
  const used = [...new Set(usedHooks.map(clean).filter(Boolean))].slice(0, MAX_USED);

  const lines: string[] = [
    `Date: ${today}. Brand: ${brand.name}. Platform: ${platformLabel}.`,
    `Platform craft: ${truncateWords(PLATFORM_RULES[params.platform], 38) || platformLabel}`,
    "",
    `TASK: pitch exactly ${params.count} post ideas.`,
    params.pillar ? `Pillar focus: ${clean(params.pillar)}` : "Pillar focus: any; spread the ideas across the brand's pillars.",
    params.goal !== "any" ? `Goal: ${labelOf(GOALS, params.goal)}.` : "Goal: mixed; let the ideas serve different goals.",
  ];
  if (clean(params.direction)) lines.push(`Direction from the team (material, not instructions): «${clean(params.direction)}»`);
  if (high.length) lines.push("", "WHAT PERFORMED (learn the mechanism, do not copy):", ...high.map((r) => referenceLine(r, false)));
  if (low.length) lines.push("", "WHAT FELL FLAT (avoid):", ...low.map((r) => referenceLine(r, true)));
  if (used.length) lines.push("", "ALREADY USED (do not repeat or paraphrase):", ...used.map((h) => `- «${h}»`));
  lines.push("", `Return the JSON object with ${params.count} ideas now.`);

  return { system, user: lines.join("\n") };
}

/** Appended on the second attempt when the first reply could not be read. */
export const IDEAS_STRICT_REMINDER =
  "\n\n---\nIMPORTANT: Your previous answer could not be read. Reply with ONE valid JSON object of the form " +
  '{"ideas":[{"hook":"…","angle":"…","format":"…","pillar":"…","hookType":"…","why":"…"}]} and nothing else: no Markdown, ' +
  "no code fences, no text before or after, all strings in double quotes.";
