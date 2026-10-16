/**
 * Reads the model's reply into Idea objects and checks them against the brand's rules.
 *
 * parseIdeas: tolerant JSON read (fences, commentary, truncation, trailing commas), tolerant key names, values snapped to
 * the catalog (format, pillar, hook type). lintIdeas: compliance findings, near-repeat detection, in-batch duplicates.
 * Pure: no network, no DB.
 */
import { HEALTH_CLAIM_LEXICON, parseLooseJson, type BrandLintRules } from "@/lib/prompt/parse";
import { canonicalHookType, textSimilarity, tokenize } from "@/lib/retrieval";
import { ideaFormatsFor } from "./prompt";
import type { Idea } from "./types";
import { clip } from "@/lib/text";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of a scalar field; arrays are joined, everything else is empty. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(" ");
  return "";
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Strips one layer of wrapping quotes / guillemets and a leading list marker. */
function tidy(s: string, max: number): string {
  let t = squash(s).replace(/^(?:[-*•]|\d+[.)])\s+/, "");
  t = t.replace(/^[«»"“”„'‘’]+/, "").replace(/[«»"“”„'‘’]+$/, "").trim();
  return t.length > max ? `${clip(t, max - 1).trimEnd()}…` : t;
}

/** First non-empty value among the key spellings models use (case-insensitive, `_`/`-` ignored). */
function pick(o: Rec, keys: string[]): string {
  const norm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, "");
  const byNorm = new Map(Object.keys(o).map((k) => [norm(k), o[k]]));
  for (const k of keys) {
    const v = asText(byNorm.get(norm(k)));
    if (squash(v)) return v;
  }
  return "";
}

/** The list of idea objects inside whatever shape the model chose. */
function ideaItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRec(value)) return [];
  for (const key of ["ideas", "post_ideas", "postIdeas", "posts", "items", "results", "data"]) {
    const v = value[key];
    if (Array.isArray(v)) return v;
    if (isRec(v)) return Object.values(v);
  }
  const values = Object.values(value);
  // {"1": {...}, "2": {...}}: an object of idea objects
  if (values.length > 0 && values.every(isRec)) return values;
  // a single idea object
  return "hook" in value || "Hook" in value ? [value] : [];
}

const FORMAT_SYNONYMS: [RegExp, string][] = [
  [/\b(reel|short|tiktok video|video script|clip)\b/i, "reel_script"],
  [/\b(talking[\s-]?head|founder video|face to camera|to camera)\b/i, "talking_head"],
  [/\b(document|pdf|slides? deck)\b/i, "linkedin_document"],
  [/\b(carousel|karussell|swipe)\b/i, "carousel"],
  [/\b(story|stories)\b/i, "story_sequence"],
  [/\b(static|single image|image post|bild|foto|photo|quote card|infographic|grafik)\b/i, "static_post"],
  [/\b(text post|text-only|linkedin post)\b/i, "linkedin_text"],
  [/\b(youtube|long[\s-]?form)\b/i, "youtube_script"],
  [/\b(ugc|testimonial)\b/i, "ugc_testimonial_brief"],
];

/** A POST_TYPES id valid for the platform, or "" when the model's wording matches none. */
export function snapFormat(raw: string, platform: string): string {
  const s = squash(raw).toLowerCase();
  if (!s) return "";
  const allowed = ideaFormatsFor(platform);
  const direct = allowed.find((f) => f.id === s || f.label.toLowerCase() === s || s.replace(/[\s-]+/g, "_") === f.id);
  if (direct) return direct.id;
  for (const [re, id] of FORMAT_SYNONYMS) if (re.test(s) && allowed.some((f) => f.id === id)) return id;
  // "text post" / "post" on LinkedIn, "image" on Instagram …
  if (platform === "linkedin" && /\b(text|post)\b/.test(s)) return "linkedin_text";
  return "";
}

/** The brand pillar that shares the most words with the model's wording (at least half of the shorter side), or "". */
export function snapPillar(raw: string, pillars: string[]): string {
  const s = squash(raw);
  if (!s) return "";
  const lower = s.toLowerCase();
  const exact = pillars.find((p) => p.toLowerCase() === lower);
  if (exact) return exact;
  const want = new Set(tokenize(s));
  if (want.size === 0) return "";
  let best = { pillar: "", score: 0 };
  for (const p of pillars) {
    const have = new Set(tokenize(p));
    if (have.size === 0) continue;
    let common = 0;
    for (const t of want) if (have.has(t)) common++;
    const score = common / Math.min(want.size, have.size);
    if (score > best.score) best = { pillar: p, score };
  }
  return best.score >= 0.5 ? best.pillar : "";
}

export type ParsedIdeas = { ok: true; ideas: Idea[]; repaired: string[] } | { ok: false; error: string };

export function parseIdeas(text: string, ctx: { platform: string; pillars: string[] }): ParsedIdeas {
  let firstError = "";
  for (const start of ["{", "["] as const) {
    const read = parseLooseJson(text, start);
    if (!read.ok) {
      firstError ||= read.error;
      continue;
    }
    const ideas: Idea[] = [];
    for (const item of ideaItems(read.value)) {
      const o: Rec = typeof item === "string" ? { hook: item } : isRec(item) ? item : {};
      const hook = tidy(pick(o, ["hook", "title", "headline", "opening", "openingLine", "firstLine", "idea"]), 300);
      if (hook.length < 4) continue;
      const angle = tidy(pick(o, ["angle", "concept", "description", "summary", "body", "details", "idea"]), 700);
      ideas.push({
        hook,
        angle: angle === hook ? "" : angle,
        format: snapFormat(pick(o, ["format", "postType", "type", "contentType", "medium"]), ctx.platform),
        pillar: snapPillar(pick(o, ["pillar", "contentPillar", "theme", "category"]), ctx.pillars),
        hookType: canonicalHookType(pick(o, ["hookType", "hookStyle", "hookKind"])),
        why: tidy(pick(o, ["why", "rationale", "reason", "because", "whyItWorks", "reasoning", "basedOn"]), 500),
        flags: [],
      });
    }
    if (ideas.length > 0) return { ok: true, ideas, repaired: read.repaired };
    firstError ||= "The JSON contained no ideas (expected an \"ideas\" list with a hook per idea).";
  }
  return { ok: false, error: firstError || "No ideas found in the reply." };
}

// ---------------------------------------------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------------------------------------------

/** Share of shared 3-word runs from which an idea counts as a near-repeat of a hook that already exists. */
const SIMILAR_FLAG = 0.55;
const SIMILAR_DROP = 0.8;
/** Two ideas of one batch this alike are the same idea. */
const DUPLICATE = 0.7;

export type LintContext = {
  brandSlug: string;
  /** The brand's own lint terms (Brands tab). */
  brandRules?: BrandLintRules;
  /** Hooks of the brand's researched posts, approved generations and earlier idea batches. */
  existingHooks: string[];
  /** Text a number may legitimately come from: the brand facts, the reference posts shown to the model, the team's direction. */
  factsText?: string;
};

/**
 * Numbers in `text` that appear nowhere in `facts`. Small counts (1 to 12), years, clock times and fractions like 24/7 are ignored: a
 * scene may have "3 Schritte" or "20:30 Uhr"; a lab value, price or percentage the brand never stated is what this catches (a local
 * model once turned 0,88 mg/kg arsenic into "0,02 mg/g").
 */
export function unverifiedNumbers(text: string, facts: string): string[] {
  const norm = (n: string) => n.replace(",", ".").replace(/^0+(?=\d)/, "");
  const known = new Set((facts.match(/\d+(?:[.,]\d+)?/g) ?? []).map(norm));
  const cleaned = text
    .replace(/\b\d{1,2}[:.]\d{2}\s*(?:Uhr|h)?/gi, " ")
    .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  const found: string[] = [];
  for (const m of cleaned.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const n = norm(m);
    const small = Number.isInteger(Number(n)) && Number(n) <= 12;
    if (!known.has(n) && !small && !found.includes(m)) found.push(m);
  }
  return found;
}

export type LintResult = { ideas: Idea[]; dropped: number };

/** Adds flags to every idea and removes exact-ish copies: of existing hooks (>= 0.8) and of earlier ideas in the batch (>= 0.7). */
export function lintIdeas(ideas: Idea[], ctx: LintContext): LintResult {
  const forbidden = (ctx.brandRules?.forbiddenTerms ?? []).filter(Boolean);
  const claimTerms = (ctx.brandRules?.claimTerms ?? []).filter(Boolean);
  const kept: Idea[] = [];
  let dropped = 0;

  for (const idea of ideas) {
    if (kept.some((k) => textSimilarity(idea.hook, k.hook) >= DUPLICATE)) {
      dropped++;
      continue;
    }
    let maxSimilarity = 0;
    let closest = "";
    for (const existing of ctx.existingHooks) {
      const sim = textSimilarity(idea.hook, existing);
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        closest = existing;
      }
    }
    if (maxSimilarity >= SIMILAR_DROP) {
      dropped++;
      continue;
    }

    const flags: string[] = [];
    const text = `${idea.hook}\n${idea.angle}\n${idea.why}`;
    for (const f of forbidden) if (text.includes(f)) flags.push(`forbidden_string:${f}`);
    {
      const lower = text.toLowerCase();
      if (ctx.brandRules?.claimSensitive) for (const term of HEALTH_CLAIM_LEXICON) if (lower.includes(term.toLowerCase())) flags.push(`health_claim_term:${term}`);
      for (const term of claimTerms) if (lower.includes(term.toLowerCase())) flags.push(`claim_check:${term}`);
    }
    if (idea.hook.includes("!")) flags.push("exclamation_in_hook");
    if (ctx.factsText) {
      const numbers = unverifiedNumbers(`${idea.hook}\n${idea.angle}`, ctx.factsText);
      if (numbers.length) flags.push(`unverified_number:${numbers.join(", ")} (not in the brand facts or references)`);
    }
    if (maxSimilarity >= SIMILAR_FLAG) flags.push(`similar_to_existing:${Math.round(maxSimilarity * 100)}% «${clip(closest, 60)}»`);
    kept.push({ ...idea, flags });
  }
  return { ideas: kept, dropped };
}
