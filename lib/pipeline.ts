/**
 * Orchestration: brief → brand + references → prompts → text provider → validated GenerationOutput → draft.
 * runGeneration() never writes to the database; POST /api/generations persists a draft when the user approves.
 */
import type { Generation, ReferencePost } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  generateText,
  suggestedMaxTokens,
  type TextResponse,
  type TextUsage,
} from "@/lib/providers";
import { buildSystemPrompt, buildUserPrompt, joinSystemPrompt, parseGenerationOutput, type ParseOptions, type ParseSuccess } from "@/lib/prompt";
import { priorVariants, repetitionReport, selectReferences } from "@/lib/retrieval";
import { describeDefaultReferences } from "@/lib/references";
import { checkLanguageSafety } from "@/lib/language-safety";
import { FIXABLE_FINDINGS, complianceEnabled, reviewCompliance, type ComplianceReview } from "@/lib/compliance";
import {
  BriefSchema,
  GenerationOutputSchema,
  PROVIDER_IDS,
  type Brief,
  type GenerationOutput,
  type TextProviderId,
  type Variant,
} from "@/lib/types";
import { AuthConfigError, ENV_HINT } from "@/lib/auth";

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** A Generation row minus id/timestamps, with typed brief/output. Not saved until POST /api/generations. */
export type DraftGeneration = Omit<Generation, "id" | "createdAt" | "updatedAt" | "brief" | "output" | "imageUrls"> & {
  imageUrls: string[]; // hosted key-visual URLs in slide order; stored as a JSON string in Generation.imageUrls
  brief: Brief;
  output: GenerationOutput;
};

/** zod schema used by POST /api/generations to validate a draft coming back from the client. */
export const DraftGenerationSchema = z.object({
  brandId: z.string().min(1),
  platform: z.string().min(1),
  postType: z.string().min(1),
  status: z.enum(["draft", "approved", "rejected"]).default("draft"),
  brief: BriefSchema,
  systemPrompt: z.string().default(""),
  userPrompt: z.string().default(""),
  provider: z.string().min(1),
  model: z.string().max(200).nullable().default(null),
  output: GenerationOutputSchema,
  outputText: z.string().default(""),
  referenceIds: z.array(z.string()).default([]),
  priorGenIds: z.array(z.string()).default([]),
  audioUrl: z.string().max(4000).nullable().default(null),
  audioProvider: z.string().max(100).nullable().default(null),
  videoUrl: z.string().max(4000).nullable().default(null),
  videoProvider: z.string().max(100).nullable().default(null),
  imageUrl: z.string().max(4000).nullable().default(null),
  imageUrls: z.array(z.url({ protocol: /^https?$/ }).max(4000)).max(20).default([]),
  imageProvider: z.string().max(100).nullable().default(null),
  score: z.number().int().min(1).max(10).nullable().default(null),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  cacheReadTokens: z.number().int().nonnegative().nullable().default(null),
  notes: z.string().max(5000).nullable().default(null),
  approvedAt: z.coerce.date().nullable().default(null),
});
export type DraftGenerationInput = z.infer<typeof DraftGenerationSchema>;

/** Token usage of one run, summed over the first attempt and any retry; null where the provider reported nothing. */
export type RunUsage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };

export type RunGenerationResult = {
  draft: DraftGeneration;
  usage: RunUsage;
  /** Wall-clock time of the whole run (retrieval, provider calls, retry), in milliseconds. */
  durationMs: number;
  references: ReferencePost[];
  priorApproved: Generation[];
  repetition: { warnings: string[]; maxSimilarity: number };
  retrievalNotes: string[];
  /** Parser lint (PROMPT-SPEC E.8): compliance and format findings, non-blocking. Codes such as `health_claim_term:…`. */
  lint: string[];
  /** Language safety warnings (lib/language-safety.ts), non-blocking: mixed language, banned / AI-sounding phrases, hashtag and emoji limits. */
  safety: string[];
  /** JSON repairs the parser had to apply (e.g. `closed_truncated_json`, `trailing_commas`). */
  repaired: string[];
  /** Pipeline-level notices: retries and truncated output. */
  warnings: string[];
  raw?: string;
};

export class PipelineError extends Error {
  readonly status: number;
  readonly hint?: string;
  readonly raw?: string;
  constructor(message: string, opts: { status?: number; hint?: string; raw?: string } = {}) {
    super(message);
    this.name = "PipelineError";
    this.status = opts.status ?? 500;
    this.hint = opts.hint;
    this.raw = opts.raw;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output flattening (Markdown) — stored as Generation.outputText and offered as the Markdown download
// ---------------------------------------------------------------------------------------------------------------

function line(label: string, value: string | undefined | null): string {
  const v = (value ?? "").trim();
  return v ? `**${label}:** ${v}\n\n` : "";
}

function block(label: string, value: string | undefined | null): string {
  const v = (value ?? "").trim();
  return v ? `### ${label}\n\n${v}\n\n` : "";
}

function list(label: string, items: string[] | undefined): string {
  const arr = (items ?? []).map((s) => s.trim()).filter(Boolean);
  return arr.length ? `### ${label}\n\n${arr.map((s) => `- ${s}`).join("\n")}\n\n` : "";
}

function flattenVariant(v: Variant, index: number, total: number): string {
  let md = total > 1 ? `## Variant ${index + 1}: ${v.title || "Untitled"}\n\n` : `## ${v.title || "Variant"}\n\n`;
  md += line("Hook", v.hook);
  md += line("Hook type", v.hookType);
  md += block("Script", v.script);
  md += list("On-screen text", v.onScreenText);
  if (v.shots.length) {
    md += `### Shots / slides\n\n| # | Duration | Visual | Text | Audio |\n|---|---|---|---|---|\n`;
    for (const s of v.shots) {
      const cell = (x: string | number) => String(x ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
      md += `| ${cell(s.order)} | ${cell(s.duration)} | ${cell(s.visual)} | ${cell(s.text)} | ${cell(s.audio)} |\n`;
    }
    md += "\n";
  }
  md += block("Caption", v.caption);
  if (v.hashtags.length) md += `**Hashtags:** ${v.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}\n\n`;
  md += line("CTA", v.cta);
  md += line("CTA type", v.ctaType);
  md += line("Thumbnail text", v.thumbnailText);
  md += block("Visual direction", v.visualDirection);
  md += block("Audio direction", v.audioDirection);
  md += block("Image prompt", v.imagePrompt);
  md += block("Video prompt", v.videoPrompt);
  md += block("Voice-over text", v.voiceoverText);
  md += block("Alternative language version", v.altVersion);
  return md;
}

/** Readable Markdown of the whole result (strategy, every variant, self-review). */
export function flattenOutput(output: GenerationOutput, brief?: Brief): string {
  let md = `# ${output.strategy.angle || "Content strategy"}\n\n`;
  if (brief) {
    md += `_${brief.brandSlug} · ${brief.platform} · ${brief.postType} · ${brief.language} · goal: ${brief.goal}_\n\n`;
  }
  md += line("Why it fits", output.strategy.whyItFits);
  md += line("Emotional driver", output.strategy.emotionalDriver);
  md += list("References used", output.strategy.referencesUsed);
  md += line("Repetition check", output.strategy.repetitionCheck);
  output.variants.forEach((v, i) => {
    md += flattenVariant(v, i, output.variants.length);
  });
  md += `## Self-review\n\n**Score:** ${output.selfReview.score}/10\n\n`;
  md += list("Strengths", output.selfReview.strengths);
  md += list("Risks", output.selfReview.risks);
  md += line("Compliance check", output.selfReview.complianceCheck);
  return md.trim() + "\n";
}

// ---------------------------------------------------------------------------------------------------------------
// runGeneration
// ---------------------------------------------------------------------------------------------------------------

const STRICT_JSON_REMINDER =
  "\n\n---\nIMPORTANT: Your previous answer could not be parsed as JSON. Return ONLY one valid JSON object that matches the " +
  "output contract exactly: no Markdown, no code fences, no commentary before or after, no trailing commas, all strings " +
  "double-quoted with inner quotes escaped.";

const TRUNCATION_REMINDER =
  "\n\n---\nIMPORTANT: Your previous answer was cut off at the output token limit before the JSON object was closed. " +
  "Return the COMPLETE JSON object this time: keep every section, but write tighter (no repetition, no filler, shot and " +
  "slide descriptions in one sentence each) so the whole object fits. No prose before or after.";

/** True when the reply was cut at the token limit (vendor flag) or the parser had to close an unterminated object. */
function wasTruncated(res: TextResponse, parsed: ReturnType<typeof parseGenerationOutput>): boolean {
  return res.truncated === true || (parsed.ok && parsed.repaired.includes("closed_truncated_json"));
}

const TRUNCATED_OUTPUT_WARNING =
  "truncated_output: the model hit its output token limit; the parser closed the cut-off JSON, so later sections " +
  "(last variant, self-review) may be incomplete. Reduce variants or length, or pick a provider with a larger budget.";

/** Sums one usage field across attempts; null when no attempt reported it. */
function sumField(usages: (TextUsage | undefined)[], key: keyof TextUsage): number | null {
  const values = usages.map((u) => u?.[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function sumUsage(...usages: (TextUsage | undefined)[]): RunUsage {
  return {
    inputTokens: sumField(usages, "input"),
    outputTokens: sumField(usages, "output"),
    cacheReadTokens: sumField(usages, "cacheRead"),
  };
}

const tokenCount = (n: number | undefined): string => (typeof n === "number" ? n.toLocaleString("en-US") : "unknown");

function asProviderId(id: string): TextProviderId {
  if ((PROVIDER_IDS as readonly string[]).includes(id)) return id as TextProviderId;
  throw new PipelineError(`Unknown text provider "${id}". Choose one of: ${PROVIDER_IDS.join(", ")}.`, { status: 422 });
}

export async function runGeneration(brief: Brief): Promise<RunGenerationResult> {
  const startedAt = Date.now();
  const provider = asProviderId(brief.textProvider);
  const brand = await prisma.brand.findUnique({ where: { slug: brief.brandSlug } });
  if (!brand) {
    throw new PipelineError(`Unknown brand "${brief.brandSlug}". Run the seed (npm run db:seed) or pick a seeded brand.`, {
      status: 422,
    });
  }

  const { references, priorApproved, notes } = await selectReferences({ brandId: brand.id, brief });
  const today = new Date().toISOString().slice(0, 10);
  // Stable (brand) + variable (brief) parts: providers cache the stable prefix; the DB stores the joined text.
  // The brand's default reference images (kind + label, never URLs) go into the brand block; a database hiccup falls back to the built-ins.
  const imageReferences = await describeDefaultReferences(brand.slug).catch((err: unknown) => {
    console.warn(`[pipeline] reference image list unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  const systemParts = buildSystemPrompt(brand, brief, { imageReferences });
  const systemPrompt = joinSystemPrompt(systemParts);
  const userPrompt = buildUserPrompt({ brand, brief, references, priorApproved, today });

  // Parser options switch on brief-dependent normalisation (variant count, altVersion) and the E.8 lint
  // (health-claim lexicon, forbidden strings, register, mandatory sections, hook overlap with prior hooks).
  const parseOpts: ParseOptions = {
    brief,
    priorHooks: [...priorApproved.flatMap((g) => priorVariants(g).map((v) => v.hook)), ...references.map((r) => r.hook ?? "")].filter((h) => h.trim()),
    brandRules: { forbiddenTerms: brand.forbiddenTerms, claimTerms: brand.claimTerms, claimSensitive: brand.claimSensitive },
  };
  const variantsWanted = Number.parseInt(brief.variants, 10) || 1;
  const maxTokens = suggestedMaxTokens(provider, variantsWanted);
  const warnings: string[] = [];
  let raw: string | undefined;

  const first = await generateText({ provider, system: systemParts, user: userPrompt, json: true, temperature: 0.7, maxTokens });
  const firstParsed = parseGenerationOutput(first.text, parseOpts);
  let chosen: { parsed: ParseSuccess; res: TextResponse } | null =
    firstParsed.ok && !wasTruncated(first, firstParsed) ? { parsed: firstParsed, res: first } : null;
  const usageParts: (TextUsage | undefined)[] = [first.usage];

  if (!chosen) {
    // One retry: a JSON reminder after a parse failure, a "write tighter" reminder plus a larger budget after truncation.
    raw = first.text;
    const truncatedFirst = firstParsed.ok || first.truncated === true;
    const retryMaxTokens = truncatedFirst ? suggestedMaxTokens(provider, variantsWanted, { retry: true }) : maxTokens;
    const reminder = firstParsed.ok
      ? TRUNCATION_REMINDER
      : `${STRICT_JSON_REMINDER}${first.truncated ? " Write tighter: the previous answer was also cut off at the token limit." : ""}\n\nParser error: ${firstParsed.error}`;
    const retry = await generateText({
      provider,
      system: systemParts,
      user: `${userPrompt}${reminder}`,
      json: true,
      temperature: 0.4,
      maxTokens: retryMaxTokens,
    });
    usageParts.push(retry.usage);
    const retryParsed = parseGenerationOutput(retry.text, parseOpts);
    if (retryParsed.ok && !wasTruncated(retry, retryParsed)) {
      chosen = { parsed: retryParsed, res: retry };
      warnings.push(firstParsed.ok ? "retried_after_truncation: the first reply was cut off; the second attempt is complete." : "retried_after_parse_failure: the first reply was not valid JSON; the second attempt parsed.");
    } else if (retryParsed.ok) {
      chosen = { parsed: retryParsed, res: retry };
      warnings.push(TRUNCATED_OUTPUT_WARNING);
    } else if (firstParsed.ok) {
      // The first reply was cut off but repairable; the retry did not even parse. Keep the best we have and say so.
      chosen = { parsed: firstParsed, res: first };
      warnings.push(`${TRUNCATED_OUTPUT_WARNING} (The retry did not return valid JSON: ${retryParsed.error})`);
    } else {
      throw new PipelineError(`The model did not return valid JSON after two attempts: ${retryParsed.error}`, {
        status: 502,
        hint: "Try again, pick another text provider, or reduce the number of variants.",
        raw: retry.text,
      });
    }
    // Every retry names both attempts' output tokens so budget growth stays visible.
    warnings.push(
      `retry_token_usage: first attempt ${tokenCount(first.usage?.output)} output tokens (limit ${tokenCount(maxTokens)}), ` +
        `retry ${tokenCount(retry.usage?.output)} output tokens (limit ${tokenCount(retryMaxTokens)}).`,
    );
  }

  let output = chosen.parsed.output;
  let lint = [...chosen.parsed.warnings];
  let repaired = chosen.parsed.repaired;

  // Brands with compliance review switched on get a second, focused look (lib/compliance.ts): violations are fixed and listed as lint entries.
  if (provider !== "mock" && complianceEnabled(brand)) {
    let review: ComplianceReview | null = null;
    try {
      review = await reviewCompliance({ provider, brand, output, variantsWanted, language: brief.language, register: brief.register, findings: lint.filter((w) => FIXABLE_FINDINGS.test(w)) });
    } catch (err) {
      lint.push(`compliance_review_failed: ${err instanceof Error ? err.message : String(err)}; check the draft for health claims yourself`);
    }
    if (review) {
      usageParts.push(review.usage);
      if (review.corrected) {
        const reparsed = parseGenerationOutput(JSON.stringify(review.corrected), parseOpts);
        if (reparsed.ok) {
          output = reparsed.output;
          lint = [...reparsed.warnings];
          repaired = [...repaired, ...reparsed.repaired];
        } else {
          review.unfixed = `the corrected draft did not parse (${reparsed.error})`;
        }
      }
      const applied = Boolean(review.corrected) && !review.unfixed;
      for (const v of review.violations) {
        const code = v.kind === "rule" ? (applied ? "compliance_fixed" : "compliance_unfixed") : `${v.kind}_${applied ? "fixed" : "unfixed"}`;
        lint.push(`${code}:${v.field} (v${v.variant}) "${v.quote}": ${v.rule}`);
      }
      // Only rule violations block approval; a language slip left unfixed is just listed.
      if (review.unfixed && review.violations.some((v) => v.kind === "rule")) {
        lint.push(`compliance_unfixed: ${review.unfixed}; the original draft is shown, do not publish it before editing the quoted statements`);
      }
    }
  }
  const usage = sumUsage(...usageParts);

  // A strategist that received references must say which ones informed the work (or explicitly none).
  if (references.length > 0 && output.strategy.referencesUsed.length === 0) {
    lint.push("references_not_cited: the model received " + references.length + " reference posts but strategy.referencesUsed is empty; check that the angle is grounded in the brand's history (stronger models cite them).");
  }
  const model = chosen.res.model;
  const outputText = flattenOutput(output, brief);
  const repetition = repetitionReport(output, priorApproved, references);
  const safety = checkLanguageSafety(output, {
    language: brief.language,
    platform: brief.platform,
    postType: brief.postType,
    tone: brief.tone,
    bannedPhrases: brand.bannedPhrases,
    aiPhraseCheck: brand.aiPhraseCheck,
  });
  const score = Number.isFinite(output.selfReview.score) ? Math.max(1, Math.min(10, Math.round(output.selfReview.score))) : null;

  const draft: DraftGeneration = {
    brandId: brand.id,
    platform: brief.platform,
    postType: brief.postType,
    status: "draft",
    brief,
    systemPrompt,
    userPrompt,
    provider: chosen.res.provider,
    model: model ?? null,
    output,
    outputText,
    referenceIds: references.map((r) => r.id),
    priorGenIds: priorApproved.map((g) => g.id),
    audioUrl: null,
    audioProvider: null,
    videoUrl: null,
    videoProvider: null,
    imageUrl: null,
    imageUrls: [],
    imageProvider: null,
    score,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    notes: null,
    approvedAt: null,
  };

  return { draft, usage, durationMs: Date.now() - startedAt, references, priorApproved, repetition, retrievalNotes: notes, lint, safety, repaired, warnings, raw };
}

// ---------------------------------------------------------------------------------------------------------------
// Error → HTTP mapping shared by the route handlers
// ---------------------------------------------------------------------------------------------------------------

export type ErrorBody = { error: string; hint?: string; code?: string; raw?: string; issues?: string[]; providerStatus?: number };

const ENV_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** Extracts env var names named by a provider error (e.g. "Set GEMINI_API_KEY …") for the environment-variable hint. */
function envVarsFrom(err: unknown): string {
  const e = err as { envVars?: unknown; envVar?: unknown; env?: unknown; message?: unknown };
  const explicit = [e.envVars, e.envVar, e.env]
    .flatMap((v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (explicit.length) return [...new Set(explicit)].join(", ");
  const msg = typeof e.message === "string" ? e.message : "";
  const found = [...new Set(msg.match(ENV_TOKEN) ?? [])].filter((t) => t !== "NODE_ENV");
  return found.length ? found.join(", ") : "the required API key";
}

/** Generation.imageUrls is stored as a JSON string; API responses hand the client a plain array (or null). */
export function withImageUrlList<T extends { imageUrls?: string | null }>(row: T): Omit<T, "imageUrls"> & { imageUrls: string[] | null } {
  let list: string[] | null = null;
  if (typeof row.imageUrls === "string" && row.imageUrls) {
    try {
      const parsed: unknown = JSON.parse(row.imageUrls);
      if (Array.isArray(parsed)) list = parsed.filter((u): u is string => typeof u === "string");
    } catch {
      list = null;
    }
  }
  return { ...row, imageUrls: list };
}

export function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

/** Maps any thrown value to {status, body}. Never includes secrets: only messages the provider modules compose. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ProviderNotConfiguredError) {
    return { status: 502, body: { error: err.message, hint: ENV_HINT(envVarsFrom(err)), code: "provider_not_configured" } };
  }
  if (err instanceof ProviderRequestError) {
    const e = err as unknown as { status?: unknown; body?: unknown };
    const providerStatus = typeof e.status === "number" ? e.status : undefined;
    const bodyText = typeof e.body === "string" ? e.body.slice(0, 500) : undefined;
    const detail = bodyText && !err.message.includes(bodyText) ? ` ${bodyText}` : "";
    return {
      status: 502,
      body: {
        error: `${err.message}${detail}`.trim(),
        code: "provider_request_failed",
        providerStatus,
        hint:
          providerStatus === 401 || providerStatus === 403
            ? "The provider rejected the credentials. Check the API key in the app's environment variables (.env file or the container environment)."
            : providerStatus === 429
              ? "Rate limit or quota reached at the provider. Wait a moment or switch provider."
              : undefined,
      },
    };
  }
  if (err instanceof PipelineError) {
    return { status: err.status, body: { error: err.message, hint: err.hint, raw: err.raw, code: "pipeline" } };
  }
  if (err instanceof AuthConfigError) {
    return { status: 503, body: { error: err.message, hint: err.hint, code: "auth_config" } };
  }
  if (err instanceof z.ZodError) {
    return { status: 422, body: { error: "Validation failed.", issues: zodIssues(err), code: "validation" } };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return { status: 404, body: { error: "Record not found.", code: "not_found" } };
    if (err.code === "P2002") return { status: 409, body: { error: "A record with the same unique fields already exists.", code: "conflict" } };
    return { status: 500, body: { error: `Database error (${err.code}).`, code: "database" } };
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return { status: 503, body: { error: "Database connection failed.", hint: ENV_HINT("DATABASE_URL and DIRECT_URL"), code: "database" } };
  }
  if (err instanceof Error) {
    const timeout = err.name === "AbortError" || err.name === "TimeoutError" || /timed? ?out/i.test(err.message);
    if (timeout) return { status: 504, body: { error: `Upstream request timed out: ${err.message}`, code: "timeout" } };
    return { status: 500, body: { error: err.message || "Unexpected error.", code: "internal" } };
  }
  return { status: 500, body: { error: "Unexpected error.", code: "internal" } };
}

/** Builds a JSON Response from any error and logs it without secrets. */
export function errorResponse(err: unknown, context: string): Response {
  const { status, body } = toErrorResponse(err);
  if (status >= 500) console.error(`[${context}] ${status}: ${body.error}`);
  return Response.json(body, { status });
}
