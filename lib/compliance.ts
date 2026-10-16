/**
 * Compliance pass: a second, focused model call that checks each draft against the brand's GUARDRAILS.
 *
 * The strategist writes under the brand's GUARDRAILS, but smaller, cheaper models still slip claims into the copy or invent a
 * number. Writing under a rule and checking against it are different jobs, so a second call reviews the finished draft: it names
 * every violation and returns the audience-facing text with only those statements fixed. The pipeline merges the fixes into the
 * draft, parses it again and lists each one as a `compliance_fixed:` lint entry, so the user sees what changed and why.
 *
 * Scope: what is read, heard or shown as text (hook, script, voice-over, overlays, caption, hashtags, CTA, thumbnail text,
 * altVersion). Production notes (visual direction, image/video prompts, shot visuals) are never sent or touched.
 *
 * German drafts also get a language polish in the same call, reported separately as `language_fixed:`. The findings of the
 * rule-based checker go along, so they are fixed in the same call and reported as `format_fixed:`.
 *
 * Per brand (Brands tab): `complianceReview` switches the pass on or off, `claimSensitive` (regulated products such as food
 * supplements or cosmetics) adds the health / effect claim rules, `forbiddenTerms` are passed on as banned strings. The global
 * env switch COMPLIANCE_REVIEW=off disables it everywhere. Costs one extra model call per generation.
 */
import { z } from "zod";
import { generateText, suggestedMaxTokens, type TextUsage } from "@/lib/providers";
import { parseLooseJson } from "@/lib/prompt/parse";
import type { GenerationOutput, TextProviderId, Variant } from "@/lib/types";

/**
 * `rule` = breaks a guardrail or states an unsupported claim or fact; `language` = typo, mixed language or broken sentence in German
 * copy; `format` = a finding of the rule-based checker (LinkedIn first line, hashtag count, exclamation mark, register mix, hook overlap).
 */
export type ComplianceViolation = { variant: number; field: string; kind: "rule" | "language" | "format"; quote: string; rule: string };

/** Lint codes the reviewer is asked to fix as well (they name a text problem it can repair; structure problems like a missing section are not among them). */
export const FIXABLE_FINDINGS = /^(linkedin_first_line_too_long|hashtags_out_of_range|exclamation_in_hook|mixed_register|hook_overlaps_prior|health_claim_term|claim_check)\b/;

export type ComplianceReview = {
  violations: ComplianceViolation[];
  /** The draft with the violating statements fixed; absent when nothing was wrong or the fix could not be applied. */
  corrected?: GenerationOutput;
  usage?: TextUsage;
  /** Set when violations were found but the corrected text was unusable (the pipeline then blocks approval). */
  unfixed?: string;
};

/** Whether the compliance pass runs for this brand: the brand's own switch, unless COMPLIANCE_REVIEW=off disables it globally. */
export function complianceEnabled(brand: { complianceReview: boolean }): boolean {
  const raw = (process.env.COMPLIANCE_REVIEW ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return false;
  return brand.complianceReview;
}

// ---------------------------------------------------------------------------------------------------------------
// The audience-facing slice of a variant
// ---------------------------------------------------------------------------------------------------------------

const ReviewedVariantSchema = z.object({
  hook: z.string().optional(),
  script: z.string().optional(),
  onScreenText: z.array(z.string()).optional(),
  shots: z.array(z.object({ order: z.number(), text: z.string() })).optional(),
  caption: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  cta: z.string().optional(),
  thumbnailText: z.string().optional(),
  voiceoverText: z.string().optional(),
  altVersion: z.string().optional(),
});
type ReviewedVariant = z.infer<typeof ReviewedVariantSchema>;

const TEXT_FIELDS = ["hook", "script", "caption", "cta", "thumbnailText", "voiceoverText", "altVersion"] as const;

/** The fields sent to the reviewer, empty ones left out (fewer tokens in and out). */
function reviewShape(v: Variant): ReviewedVariant {
  const out: ReviewedVariant = {};
  for (const key of TEXT_FIELDS) if (v[key]?.trim()) out[key] = v[key];
  if (v.onScreenText.length) out.onScreenText = v.onScreenText;
  if (v.hashtags.length) out.hashtags = v.hashtags;
  const shotTexts = v.shots.filter((s) => s.text.trim()).map((s) => ({ order: s.order, text: s.text }));
  if (shotTexts.length) out.shots = shotTexts;
  return out;
}

/** Writes the reviewed fields back into the full variant; everything the reviewer never saw stays as it was. */
function merge(original: Variant, reviewed: ReviewedVariant): Variant {
  const next: Variant = { ...original };
  for (const key of TEXT_FIELDS) if (reviewed[key] !== undefined) next[key] = reviewed[key];
  if (reviewed.onScreenText) next.onScreenText = reviewed.onScreenText;
  if (reviewed.hashtags) next.hashtags = reviewed.hashtags;
  if (reviewed.shots) {
    const byOrder = new Map(reviewed.shots.map((s) => [s.order, s.text]));
    next.shots = original.shots.map((s) => (byOrder.has(s.order) ? { ...s, text: byOrder.get(s.order) ?? s.text } : s));
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------------------------

const ROLE = `You are the compliance reviewer for {BRAND}. A strategist wrote the draft below under the brand's GUARDRAILS. The draft lists only the audience-facing text (hook, script, voiceoverText, onScreenText, shots[].text, caption, hashtags, cta, thumbnailText, altVersion). Find every statement in it that breaks the rules below and fix only those. Production specs (dimensions, aspect ratios, lenses, durations, colours) are not part of this review.

A violation is any statement or hint that:`;

const CLAIM_RULES = `1. says or implies the product or an ingredient causes, relieves, supports, improves or prevents something in the body or in how someone feels or performs (regulated product such as a food supplement or cosmetic, e.g. EU Health Claims Regulation 1924/2006). Typical: "hilft", "wirkt", "funktioniert", "stärkt", "unterstützt", "fördert", "mehr Energie", "natürliche Energie", "Fokus", "kein Crash", "gegen Müdigkeit", "macht wach", "boost", "supports", "helps", "works".
2. presents the product as the answer to a symptom or feeling (tiredness, low energy, stress, sleep, performance), also through contrast or a hashtag such as #müdigkeit or #fokus placed next to the product.
3. breaks a rule in GUARDRAILS (banned words, invented discounts or prices, claims the website does not state).
4. states a number, price, link, handle or test value that is not in the BRAND FACTS.`;

const GENERAL_RULES = `1. breaks a rule in GUARDRAILS (banned words or claims, invented discounts or prices, promises the brand does not make).
2. states a fact the BRAND FACTS do not contain and presents it as true: a statistic, percentage, duration or hours saved, number of systems or customers, customer or company name, case result, certification, award, price, link or handle. Anonymised case metrics are allowed exactly as the BRAND FACTS give them.`;

const ALLOWED_CLAIM = `Allowed: a scene that shows the situation (a grey morning, the third coffee) without presenting the product as its answer; how the product is used; test or lab facts that are in the BRAND FACTS; a question; the testimonial disclaimer.`;
const ALLOWED_GENERAL = `Allowed: an illustrative scene (a time of day, the wording of a customer message), a question, an opinion, and anything the BRAND FACTS state. Not allowed: a made-up number or result dressed up as a fact.`;

const LANGUAGE_POLISH = `LANGUAGE POLISH (this draft is German): besides the violations, fix with the smallest possible change (a) spelling errors and missing umlauts or ß, (b) English words or phrases inside German sentences, except brand terms, platform terms and loanwords that are normal in German (Reel, Feed, Link in Bio, Dashboard), for example "Pea-sized" becomes "erbsengroß", (c) broken or incomplete sentences and wrong word endings, (d) hashtags with spelling mistakes. Report each of these with "kind":"language"; violations of the rules above have "kind":"rule". Never change meaning, tone or register, and never rewrite a correct sentence.`;

const FINDINGS_BLOCK = `AUTOMATIC FINDINGS: a rule-based checker flagged these in the draft. Fix each one when it is real, with the smallest change, and report it with "kind":"format".
{FINDINGS}
Meaning of the codes: linkedin_first_line_too_long = the first line of the caption must be at most 140 characters; hashtags_out_of_range = use the stated number of hashtags; exclamation_in_hook = no exclamation mark in the hook; mixed_register = du and Sie must not be mixed (use {REGISTER}); hook_overlaps_prior = the hook repeats five or more consecutive words of an earlier post, rephrase it; health_claim_term and claim_check = fix when the term is used as a claim about the product, leave it when it is a plain description or part of a scene.`;

const FIX_AND_ANSWER = `How to fix a violation: delete the statement or replace it with something the BRAND FACTS support (a scene, a question, a concrete description without a made-up number). Keep language, length, tone, shot count and order, and every field that has no violation, character for character. If a hook or key line is removed, the script, voiceoverText, caption and onScreenText that repeat it must change the same way.

GUARDRAILS:
{GUARDRAILS}

BRAND FACTS (what may be stated as true: numbers, prices, links, handles, product details):
DESCRIPTION: {DESCRIPTION}
VISUAL: {VISUAL}
VOICE: {VOICE}
OFFERS: {OFFERS}

Answer with one JSON object and nothing else:
{"violations":[{"variant":1,"field":"script","kind":"rule","quote":"the exact offending words","rule":"why it is a violation, in at most 12 words"}],"variants":[ ... ]}
("kind" is "rule", "language" or "format", as described above.)
"variants" holds ALL variants in the same order, each with the same fields as in the draft and the fixes applied. When there is no violation return {"violations":[],"variants":[]}.`;

type BrandFacts = { slug: string; name: string; guardrails: string; description: string; visual: string; voice: string; offers: string; claimSensitive: boolean; forbiddenTerms: string[] };

export async function reviewCompliance(p: {
  provider: TextProviderId;
  brand: BrandFacts;
  output: GenerationOutput;
  variantsWanted: number;
  /** The brief's language: German drafts also get the language polish. */
  language: string;
  /** The brief's register (du / sie / brand_default), for the du-Sie mix finding. */
  register: string;
  /** Lint codes of the rule-based checker that the reviewer should fix too (see FIXABLE_FINDINGS). */
  findings: string[];
}): Promise<ComplianceReview> {
  const claims = p.brand.claimSensitive;
  const german = p.language === "de" || p.language === "de_en";
  const findings = p.findings.length
    ? FINDINGS_BLOCK.replace("{FINDINGS}", () => p.findings.map((f) => `- ${f}`).join("\n")).replace("{REGISTER}", () => (p.register === "du" ? "du" : p.register === "sie" ? "Sie" : "the brand's default register from VOICE"))
    : "";
  const template = [ROLE, claims ? CLAIM_RULES : GENERAL_RULES, claims ? ALLOWED_CLAIM : ALLOWED_GENERAL, ...(german ? [LANGUAGE_POLISH] : []), ...(findings ? [findings] : []), FIX_AND_ANSWER].join("\n");
  // Function replacers: brand text contains "$" and "'$'", which String.replace would read as replacement patterns.
  const system = template
    .replace("{BRAND}", () => p.brand.name)
    .replace("{GUARDRAILS}", () => p.brand.guardrails + (p.brand.forbiddenTerms.length ? `\nNever use these exact strings: ${p.brand.forbiddenTerms.map((t) => `"${t}"`).join(", ")}.` : ""))
    .replace("{DESCRIPTION}", () => p.brand.description)
    .replace("{VISUAL}", () => p.brand.visual)
    .replace("{VOICE}", () => p.brand.voice)
    .replace("{OFFERS}", () => p.brand.offers);
  const res = await generateText({
    provider: p.provider,
    system,
    user: `DRAFT (JSON):\n${JSON.stringify({ variants: p.output.variants.map(reviewShape) })}`,
    json: true,
    temperature: 0.2,
    maxTokens: suggestedMaxTokens(p.provider, p.variantsWanted),
  });

  const parsed = parseLooseJson(res.text);
  if (!parsed.ok) throw new Error(`the review reply was not readable (${parsed.error})`);
  const body = parsed.value as { violations?: unknown; variants?: unknown };
  const violations = readViolations(body.violations);
  if (violations.length === 0) return { violations: [], usage: res.usage };

  const variants = Array.isArray(body.variants) ? body.variants : [];
  const checked = variants.map((v) => ReviewedVariantSchema.safeParse(v));
  if (variants.length !== p.output.variants.length || checked.some((c) => !c.success)) {
    return { violations, usage: res.usage, unfixed: "the reviewer found violations but did not return usable corrected text" };
  }
  const fixed = p.output.variants.map((v, i) => {
    const c = checked[i];
    return c.success ? merge(v, c.data) : v;
  });
  return { violations, corrected: { ...p.output, variants: fixed }, usage: res.usage };
}

function readViolations(value: unknown): ComplianceViolation[] {
  if (!Array.isArray(value)) return [];
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return value
    .map((v): ComplianceViolation | null => {
      const o = (v ?? {}) as Record<string, unknown>;
      const quote = text(o.quote, 160);
      if (!quote) return null;
      const n = Number(o.variant);
      const kind = o.kind === "language" ? "language" : o.kind === "format" ? "format" : "rule";
      return { variant: Number.isInteger(n) && n > 0 ? n : 1, field: text(o.field, 40) || "text", kind, quote, rule: text(o.rule, 120) || (kind === "rule" ? "breaks a guardrail" : kind) };
    })
    .filter((v): v is ComplianceViolation => v !== null)
    .slice(0, 12);
}
