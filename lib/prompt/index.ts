/**
 * Prompt engine entry point: builds the strategist's system + user prompts and parses the reply.
 * Everything here is pure and deterministic (same inputs → same prompts).
 */
import type { Brand, Generation, ReferencePost } from "@prisma/client";
import type { Brief } from "@/lib/types";
import type { PromptImageReference } from "@/lib/reference-kinds";
import { buildSystemPromptText } from "./system";
import { buildUserPrompt } from "./user";

export {
  buildSystemPrompt,
  buildSystemPromptText,
  joinSystemPrompt,
  buildBrandBlock,
  buildReferenceImagesLine,
  buildBriefConstraints,
  buildPlatformRules,
  brandCategoryRules,
  PLATFORM_RULES,
  POST_TYPE_RULES,
} from "./system";
export type { SystemPromptParts, SystemPromptOptions } from "./system";
export { buildUserPrompt, briefJsonLine, summarizeGeneration, performanceBucket, truncateWords, SOURCE_TEXT_LIMIT } from "./user";
export type { UserPromptInput } from "./user";
export {
  OUTPUT_JSON_INSTRUCTIONS,
  renderOutputContract,
  mandatorySectionsLine,
  mandatorySectionsFor,
  mappedPostType,
  lengthNormFor,
  hashtagRangeFor,
  MANDATORY_SECTIONS,
  LENGTH_NORMS,
  HASHTAG_RANGES,
  VALID_CTA_TYPES,
} from "./schema";
export { parseGenerationOutput, lintOutput } from "./parse";
export type { ParseOptions, ParseResult, ParseSuccess, ParseFailure } from "./parse";

export type BuildPromptsInput = {
  brand: Brand;
  brief: Brief;
  references: ReferencePost[];
  priorApproved: Generation[];
  /** ISO date (YYYY-MM-DD). Passed in, never read from the clock, so prompts stay deterministic. */
  today: string;
  /** Kind and label of the brand's default reference images for the image model (default: the built-in ones). */
  imageReferences?: PromptImageReference[];
};

/** Both prompts for one run plus a rough token estimate of each. */
export function buildPrompts(input: BuildPromptsInput): {
  system: string;
  user: string;
  tokens: { system: number; user: number; total: number };
} {
  const system = buildSystemPromptText(input.brand, input.brief, { imageReferences: input.imageReferences });
  const user = buildUserPrompt(input);
  const s = estimateTokens(system);
  const u = estimateTokens(user);
  return { system, user, tokens: { system: s, user: u, total: s + u } };
}

/** Rough token estimate (chars / 4), enough for budget checks and UI hints. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

/** Word count helper used by the budget check for the system prompt (≈ 2,500 words target). */
export function countWords(text: string): number {
  return (text ?? "").split(/\s+/).filter(Boolean).length;
}
