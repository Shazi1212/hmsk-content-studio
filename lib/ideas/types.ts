/**
 * Ideas tab: shared contract (request schema, idea shape, batch DTO). Client-safe: no server imports.
 *
 * An idea is a pitch, not a post: a hook that stands alone, the angle that makes it concrete, and the format it would
 * take. "Use in Create" hands one to the normal strategist pipeline, which writes the actual script.
 */
import { z } from "zod";
import { GOALS, PLATFORMS } from "@/lib/types";

const ids = (o: { id: string }[]) => o.map((x) => x.id) as [string, ...string[]];

export const IDEA_COUNT_MIN = 3;
export const IDEA_COUNT_MAX = 12;
export const IDEA_COUNT_DEFAULT = 8;

/** What the Ideas form sends to POST /api/ideas (and what a weekly run builds itself). */
export const IdeasParamsSchema = z.object({
  brandSlug: z.string().min(1),
  platform: z.enum(ids(PLATFORMS)),
  /** A pillar exactly as listed in Brand.pillars, or "" for "any pillar, spread across them". */
  pillar: z.string().max(200).default(""),
  /** A goal id from GOALS, or "any". */
  goal: z.enum([...ids(GOALS), "any"]).default("any"),
  language: z.enum(["de", "en"]).default("de"),
  count: z.number().int().min(IDEA_COUNT_MIN).max(IDEA_COUNT_MAX).default(IDEA_COUNT_DEFAULT),
  /** Free text from the team: a theme, an offer, an event, "something about X". */
  direction: z.string().max(1000).default(""),
  /** One of IDEAS_LLM_MODELS; empty = the configured default. */
  model: z.string().max(120).optional(),
});
export type IdeasParams = z.infer<typeof IdeasParamsSchema>;

export type Idea = {
  /** The first line / first two seconds; must stand alone. */
  hook: string;
  /** One or two sentences: what the post shows or says, and what makes it concrete. */
  angle: string;
  /** A POST_TYPES id valid for the platform, or "" when the model named none that fits. */
  format: string;
  /** One of the brand's pillars (snapped to the closest), or "". */
  pillar: string;
  /** A HOOK_TYPES id, or "". */
  hookType: string;
  /** The reference mechanism or audience insight the idea builds on. */
  why: string;
  /** Lint codes: `health_claim_term:…` and `forbidden_string:…` are compliance findings; `similar_to_existing:…` marks a near-repeat. */
  flags: string[];
};

export type IdeaBatchDTO = {
  id: string;
  brandSlug: string;
  brandName: string;
  source: "manual" | "weekly";
  params: IdeasParams;
  ideas: Idea[];
  model: string | null;
  durationMs: number | null;
  createdAt: string;
};

/** What POST /api/ideas returns once the model is done (after the keep-alive whitespace). */
export type IdeasResponse = {
  batch: IdeaBatchDTO;
  /** Ideas the model produced but the server dropped as duplicates or near-copies of existing hooks. */
  dropped: number;
  /** Model attempts used (2 = the first reply could not be read). */
  attempts: number;
  usage: { input: number | null; output: number | null };
  durationMs: number;
  warnings: string[];
};

export type IdeasStatus = {
  configured: boolean;
  /** Default model id, when one is configured. */
  model?: string;
  /** Models the dropdown offers (IDEAS_LLM_MODELS, or just the default). */
  models: string[];
  /** The weekly idea bank runs on Mondays while this is true. */
  weekly: boolean;
  /** Set by ?probe=1: did the model server answer, and with which model ids. */
  probe?: { reachable: boolean; detail: string; serverModels: string[]; ms: number };
  note?: string;
};

/** Compliance findings (the same codes the generation lint uses for its approval gate). */
export const CRITICAL_IDEA_FLAG = /^(health_claim_term|forbidden_string)\b/;
