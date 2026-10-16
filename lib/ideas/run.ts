/**
 * Orchestration of one idea batch: brand + evidence from the database → prompt → Ideas model → parsed, linted ideas →
 * IdeaBatch row. Used by POST /api/ideas (source "manual") and by the Monday idea bank (source "weekly").
 */
import type { Brand, IdeaBatch, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PipelineError } from "@/lib/pipeline";
import { ideasModels } from "@/lib/providers/config";
import { summarizeGeneration } from "@/lib/prompt/user";
import { platformFamily, priorVariants, selectReferences } from "@/lib/retrieval";
import { BriefSchema } from "@/lib/types";
import { ideasChat } from "./llm";
import { lintIdeas, parseIdeas } from "./parse";
import { IDEAS_STRICT_REMINDER, buildIdeasPrompt, ideaFormatsFor } from "./prompt";
import { IdeasParamsSchema, type Idea, type IdeaBatchDTO, type IdeasParams, type IdeasResponse } from "./types";

/** Output budget: reasoning models count their thinking against it, so it grows with the number of ideas. */
export function ideasMaxTokens(count: number): number {
  return Math.min(9_000, 3_000 + count * 450);
}

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

export function toBatchDTO(row: IdeaBatch, brand: Pick<Brand, "slug" | "name">): IdeaBatchDTO {
  const params = IdeasParamsSchema.safeParse(row.params);
  return {
    id: row.id,
    brandSlug: brand.slug,
    brandName: brand.name,
    source: row.source === "weekly" ? "weekly" : "manual",
    params: params.success ? params.data : (row.params as unknown as IdeasParams),
    ideas: Array.isArray(row.ideas) ? (row.ideas as unknown as Idea[]) : [],
    model: row.model,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function runIdeas(input: IdeasParams, opts: { source?: "manual" | "weekly" } = {}): Promise<IdeasResponse> {
  const startedAt = Date.now();
  const params = IdeasParamsSchema.parse(input);

  const models = ideasModels();
  if (params.model && models.length > 0 && !models.includes(params.model)) {
    throw new PipelineError(`Model "${params.model}" is not offered. Choose one of: ${models.join(", ")}.`, { status: 422 });
  }

  const brand = await prisma.brand.findUnique({ where: { slug: params.brandSlug } });
  if (!brand) throw new PipelineError(`Unknown brand "${params.brandSlug}".`, { status: 422 });
  if (params.pillar && !brand.pillars.includes(params.pillar)) {
    throw new PipelineError("That pillar does not belong to the brand. Pick one from the list or leave it on 'Any pillar'.", { status: 422 });
  }

  // Evidence: the research rows the strategist would see for this platform and pillar (high performers first), plus
  // everything that already exists, so the model can be told what not to repeat and the lint can drop near-copies.
  const brief = BriefSchema.parse({
    brandSlug: brand.slug,
    platform: params.platform,
    postType: ideaFormatsFor(params.platform)[0]?.id ?? "reel_script",
    goal: params.goal === "any" ? "awareness" : params.goal,
    pillar: params.pillar || "custom",
    topic: params.direction,
    referenceStrategy: "avoid_repeats",
  });
  const [{ references, priorApproved }, posts, approved, batches] = await Promise.all([
    selectReferences({ brandId: brand.id, brief, limit: 12 }),
    prisma.referencePost.findMany({ where: { brandId: brand.id }, select: { hook: true, platform: true, date: true } }),
    prisma.generation.findMany({
      where: { brandId: brand.id, status: "approved", provider: { not: "mock" } },
      select: { output: true, outputText: true },
      take: 60,
    }),
    prisma.ideaBatch.findMany({ where: { brandId: brand.id }, orderBy: { createdAt: "desc" }, take: 5, select: { ideas: true } }),
  ]);

  const batchHooks = batches.flatMap((b) => (Array.isArray(b.ideas) ? (b.ideas as unknown as Idea[]) : []).map((i) => clean(i?.hook))).filter(Boolean);
  const approvedHooks = approved.flatMap((g) => priorVariants(g).map((v) => clean(v.hook))).filter(Boolean);
  const postHooks = posts.map((p) => clean(p.hook)).filter(Boolean);
  const family = platformFamily(params.platform);
  const recentPosts = posts
    .filter((p) => clean(p.hook) && platformFamily(p.platform) === family)
    .sort((a, b) => (Date.parse((b.date ?? "").slice(0, 10)) || 0) - (Date.parse((a.date ?? "").slice(0, 10)) || 0))
    .map((p) => clean(p.hook))
    .slice(0, 8);
  const usedHooks = [...batchHooks.slice(0, 10), ...priorApproved.slice(0, 6).map((g) => summarizeGeneration(g).hook), ...recentPosts];
  const existingHooks = [...new Set([...postHooks, ...approvedHooks, ...batchHooks])];

  const { system, user } = buildIdeasPrompt({ brand, params, references, usedHooks, today: new Date().toISOString().slice(0, 10) });
  const maxTokens = ideasMaxTokens(params.count);
  const parseCtx = { platform: params.platform, pillars: brand.pillars };

  // Attempt 1 is free-form; if the reply cannot be read, attempt 2 adds the strict reminder and asks for JSON mode.
  const warnings: string[] = [];
  let usageIn: number | null = null;
  let usageOut: number | null = null;
  let parsed: ReturnType<typeof parseIdeas> | null = null;
  let last: Awaited<ReturnType<typeof ideasChat>> | null = null;
  let attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    last = await ideasChat({
      system,
      user: attempts === 1 ? user : `${user}${IDEAS_STRICT_REMINDER}`,
      model: params.model,
      temperature: attempts === 1 ? 0.9 : 0.6,
      maxTokens,
      json: attempts === 2,
    });
    if (last.usage.input !== undefined) usageIn = (usageIn ?? 0) + last.usage.input;
    if (last.usage.output !== undefined) usageOut = (usageOut ?? 0) + last.usage.output;
    parsed = parseIdeas(last.text, parseCtx);
    if (parsed.ok) break;
    warnings.push(`retried_after_unreadable_reply: ${parsed.error}`);
  }
  attempts = Math.min(attempts, 2);
  if (!parsed?.ok || !last) {
    throw new PipelineError(`The model's answer could not be read as a list of ideas after two attempts: ${parsed && !parsed.ok ? parsed.error : "no answer"}`, {
      status: 502,
      hint: "Try again, or pick the other model in the dropdown. Small models sometimes lose the JSON format.",
      raw: last?.text,
    });
  }
  if (last.truncated) warnings.push("truncated_output: the model hit its token limit; the last ideas may be cut short or missing.");
  if (parsed.repaired.length) warnings.push(`repaired_json: ${parsed.repaired.join(", ")}`);

  const factsText = [
    brand.description,
    brand.audience,
    brand.voice,
    brand.offers,
    brand.guardrails,
    params.direction,
    ...references.flatMap((r) => [r.hook, r.observations, r.contentMechanism, r.views, r.likes, r.comments, r.shares, r.saves]),
  ].join("\n");
  const linted = lintIdeas(parsed.ideas, {
    brandSlug: brand.slug,
    brandRules: { forbiddenTerms: brand.forbiddenTerms, claimTerms: brand.claimTerms, claimSensitive: brand.claimSensitive },
    existingHooks,
    factsText,
  });
  const ideas = linted.ideas.slice(0, params.count);
  if (ideas.length === 0) {
    throw new PipelineError("Every idea the model proposed was a near-copy of a hook that already exists.", {
      status: 502,
      hint: "Run it again, or give a direction (a theme, an offer, an event) to steer it somewhere new.",
    });
  }
  if (ideas.length < params.count) warnings.push(`fewer_ideas: ${ideas.length} of ${params.count} requested (the model returned fewer, or the rest were duplicates).`);

  const durationMs = Date.now() - startedAt;
  const row = await prisma.ideaBatch.create({
    data: {
      brandId: brand.id,
      source: opts.source ?? "manual",
      params: params as unknown as Prisma.InputJsonValue,
      ideas: ideas as unknown as Prisma.InputJsonValue,
      model: last.model,
      durationMs,
    },
  });

  return {
    batch: toBatchDTO(row, brand),
    dropped: linted.dropped,
    attempts,
    usage: { input: usageIn, output: usageOut },
    durationMs,
    warnings,
  };
}
