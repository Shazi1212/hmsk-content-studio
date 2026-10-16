/**
 * Robust parsing of the model's reply into a validated GenerationOutput (PROMPT-SPEC section E).
 * Pure: never throws, no network, no DB, no filesystem. Deterministic for the same input.
 *
 * Pipeline: pre-clean → locate outermost object (string-aware) → close truncated JSON → syntax repairs →
 * JSON.parse → shape coercions (incl. {"output": …} wrapper) → zod validation → normalisation → lint warnings.
 */
import { GenerationOutputSchema, type Brief, type GenerationOutput, type Variant } from "@/lib/types";
import { hashtagRangeFor, mandatorySectionsFor, mappedPostType } from "./schema";
import { clip } from "@/lib/text";

export type ParseOptions = {
  /** When given, brief-dependent normalisation (altVersion, variant count) and lint run. */
  brief?: Pick<Brief, "postType" | "platform" | "language" | "variants" | "register" | "brandSlug" | "tone" | "length">;
  /** Hooks of prior approved generations and reference posts, for the consecutive-words overlap lint. */
  priorHooks?: string[];
  /** The brand's own lint terms (forbidden strings, claim-check words, claim-sensitive switch). */
  brandRules?: BrandLintRules;
};

export type ParseSuccess = { ok: true; output: GenerationOutput; repaired: string[]; warnings: string[] };
export type ParseFailure = { ok: false; error: string; raw: string };
export type ParseResult = ParseSuccess | ParseFailure;

// ---------------------------------------------------------------------------------------------------------------
// String-aware segmentation (everything below treats text inside double-quoted JSON strings as opaque)
// ---------------------------------------------------------------------------------------------------------------

type Segment = { inString: boolean; text: string };

function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      buf += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        out.push({ inString: true, text: buf });
        buf = "";
        inString = false;
      }
    } else if (ch === '"') {
      if (buf) out.push({ inString: false, text: buf });
      buf = ch;
      inString = true;
    } else {
      buf += ch;
    }
  }
  if (buf) out.push({ inString, text: buf });
  return out;
}

const join = (segs: Segment[]): string => segs.map((s) => s.text).join("");

function mapOutside(text: string, fn: (outside: string) => string): string {
  return join(segment(text).map((s) => (s.inString ? s : { inString: false, text: fn(s.text) })));
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 1 to 3: pre-clean, locate, close truncation, repair
// ---------------------------------------------------------------------------------------------------------------

function preClean(text: string): string {
  let t = text.replace(/^\uFEFF/, "").trim();
  // Code fences (```json … ```), including a fence that was never closed.
  t = t.replace(/^```[\w-]*[ \t]*\r?\n?/gm, "").replace(/```/g, "");
  t = t.replace(/^\s*json\s*[\r\n]+/i, "");
  return t.trim();
}

/** Returns the slice from the first `open` ("{" or "[") to its matching close (string-aware), or the tail if unbalanced. */
function locateFrom(text: string, open: "{" | "["): { body: string; truncated: boolean } | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return { body: text.slice(start, i + 1), truncated: false };
    }
  }
  return { body: text.slice(start), truncated: true };
}

function locateObject(text: string): { body: string; truncated: boolean } | null {
  return locateFrom(text, "{");
}

/** Closes an unterminated string, drops a dangling key or comma, then closes open arrays/objects in reverse order. */
function closeTruncated(body: string): string {
  let t = body;
  // Is the text still inside an open string literal at its very end? (A segment that ends on its closing quote
  // is complete, so we scan for the real end state instead of trusting the last segment's flag.)
  let openString = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (openString) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') openString = false;
    } else if (ch === '"') openString = true;
  }
  if (openString) {
    if (esc) t = t.slice(0, -1); // a trailing lone backslash would escape the quote we add
    t += '"';
  }
  // Dangling `"key":` at the very end; then a bare quoted token in key position (a key cut mid-name, or a
  // partial array element) which has no colon; then a trailing comma.
  t = t.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "");
  t = t.replace(/([{,]\s*)"(?:[^"\\]|\\.)*"\s*$/, "$1");
  t = t.replace(/,\s*$/, "");
  // Compute the open bracket stack outside strings.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) t += stack.pop();
  return t;
}

const SINGLE_QUOTE_PLACEHOLDER = "\u0001SQ\u0001";

/**
 * A typographic opening quote closed by a STRAIGHT quote inside a string value ("sagt: „Hallo", liegt …": German replies do
 * this) ends the JSON string early. When that straight quote is followed by running text instead of JSON structure it
 * closes the inner quotation, so it becomes the matching typographic quote. Valid JSON never matches: after the quote that
 * really closes a string only structure can follow (a comma and the next key or value, a bracket, a colon, the line end).
 */
const MIXED_QUOTE_RE = /([„\u201C])([^"„\u201C\u201D\n]*)"(?!\s*(?:$|[}\]:]|,\s*(?:["{[}\]\d-]|true\b|false\b|null\b|$)))/gm;

function healMixedQuotes(text: string): string {
  return text.replace(MIXED_QUOTE_RE, (_m, open: string, inner: string) => `${open}${inner}${open === "„" ? "\u201C" : "\u201D"}`);
}

function repairSyntax(input: string, repaired: string[]): string {
  let t = input;

  // Smart quotes used as delimiters (outside strings) → straight quotes.
  const smart = mapOutside(t, (s) => s.replace(/[\u201C\u201D\u2018\u2019]/g, '"'));
  if (smart !== t) {
    repaired.push("smart_quotes");
    t = smart;
  }

  // Single-quoted document (no double quotes anywhere).
  if (!t.includes('"') && t.includes("'")) {
    t = t.split("\\'").join(SINGLE_QUOTE_PLACEHOLDER).replace(/'/g, '"').split(SINGLE_QUOTE_PLACEHOLDER).join("'");
    repaired.push("single_quotes");
  }

  // Raw control characters inside strings → escaped.
  const escapedNl = join(
    segment(t).map((s) =>
      s.inString ? { inString: true, text: s.text.replace(/\r\n?/g, "\n").replace(/\n/g, "\\n").replace(/\t/g, "\\t") } : s,
    ),
  );
  if (escapedNl !== t) {
    repaired.push("escaped_control_chars");
    t = escapedNl;
  }

  // Comments outside strings.
  const noComments = mapOutside(t, (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
  if (noComments !== t) {
    repaired.push("comments_removed");
    t = noComments;
  }

  // NaN / undefined / Infinity → null.
  const noNaN = mapOutside(t, (s) => s.replace(/-?\b(NaN|undefined|Infinity)\b/g, "null"));
  if (noNaN !== t) {
    repaired.push("nan_undefined_to_null");
    t = noNaN;
  }

  // Unquoted keys.
  const quotedKeys = mapOutside(t, (s) => s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*):/g, '$1"$2"$3:'));
  if (quotedKeys !== t) {
    repaired.push("unquoted_keys");
    t = quotedKeys;
  }

  // Trailing commas before } or ].
  const noTrailing = mapOutside(t, (s) => s.replace(/,(\s*[}\]])/g, "$1"));
  if (noTrailing !== t) {
    repaired.push("trailing_commas");
    t = noTrailing;
  }

  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 5: coercions before zod
// ---------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

const VARIANT_KEYS = ["hook", "caption", "script", "shots", "onScreenText", "hashtags", "cta", "title"];

function toStringArray(v: unknown, kind: "hashtags" | "lines"): string[] {
  if (Array.isArray(v)) return v.map(asStr).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    const parts = kind === "hashtags" ? v.split(/[\n,]|\s+(?=#)/) : v.split(/\n/);
    return parts.map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function coerceShots(v: unknown): unknown[] {
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string")
    arr = v
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => ({ visual: line }));
  else if (isRec(v)) arr = [v];
  else arr = [];
  return arr.map((s, i) => {
    const r: Rec = isRec(s) ? { ...s } : { visual: asStr(s) };
    const order = typeof r.order === "number" ? r.order : Number.parseInt(asStr(r.order), 10);
    r.order = Number.isFinite(order) ? order : i + 1;
    if (typeof r.duration === "number") r.duration = `${r.duration} s`;
    else r.duration = asStr(r.duration);
    r.visual = asStr(r.visual ?? r.description ?? r.scene);
    r.text = asStr(r.text ?? r.onScreenText ?? r.overlay);
    r.audio = asStr(r.audio ?? r.sound ?? r.vo);
    return r;
  });
}

const VARIANT_STRING_FIELDS = [
  "title",
  "hook",
  "hookType",
  "script",
  "caption",
  "cta",
  "ctaType",
  "visualDirection",
  "audioDirection",
  "thumbnailText",
  "imagePrompt",
  "videoPrompt",
  "voiceoverText",
  "altVersion",
];

function coerceVariant(v: unknown, repaired: string[]): Rec {
  const r: Rec = isRec(v) ? { ...v } : {};
  if (typeof r.hashtags === "string") repaired.push("hashtags_split");
  r.hashtags = toStringArray(r.hashtags, "hashtags");
  if (typeof r.onScreenText === "string") repaired.push("onScreenText_split");
  r.onScreenText = toStringArray(r.onScreenText, "lines");
  if (typeof r.shots === "string") repaired.push("shots_split");
  r.shots = coerceShots(r.shots);
  for (const key of VARIANT_STRING_FIELDS) {
    const val = r[key];
    if (Array.isArray(val)) r[key] = val.map(asStr).join("\n");
    else if (val != null && typeof val !== "string") r[key] = asStr(val);
  }
  r.hook = asStr(r.hook);
  if (!asStr(r.title).trim()) {
    r.title = asStr(r.hook).split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    repaired.push("title_from_hook");
  }
  return r;
}

function coerce(parsed: unknown, repaired: string[]): Rec {
  let root: Rec = isRec(parsed) ? { ...parsed } : {};

  // Model wrapped the answer: {"output": {...}} / {"result": {...}} / {"data": {...}}.
  for (const wrapper of ["output", "result", "data", "generation", "response"]) {
    const inner = root[wrapper];
    if (isRec(inner) && !("variants" in root) && ("variants" in inner || "strategy" in inner || "hook" in inner)) {
      repaired.push(`unwrapped_${wrapper}`);
      root = { ...inner };
      break;
    }
  }

  // variants: object → [object]; missing but the root looks like a variant → wrap it.
  if (isRec(root.variants)) {
    root.variants = [root.variants];
    repaired.push("variants_object_to_array");
  } else if (!Array.isArray(root.variants)) {
    if (Array.isArray(root.variant)) root.variants = root.variant;
    else if (isRec(root.variant)) root.variants = [root.variant];
    else if (VARIANT_KEYS.some((k) => k in root)) {
      const { strategy, selfReview, ...rest } = root;
      root = { strategy, selfReview, variants: [rest] };
      repaired.push("root_wrapped_as_variant");
    } else root.variants = [];
  }
  root.variants = (root.variants as unknown[]).map((v) => coerceVariant(v, repaired));

  // strategy
  const strategy: Rec = isRec(root.strategy) ? { ...root.strategy } : {};
  if (!isRec(root.strategy)) repaired.push("strategy_missing");
  strategy.angle = asStr(strategy.angle);
  strategy.whyItFits = asStr(strategy.whyItFits ?? strategy.why_it_fits ?? strategy.rationale);
  strategy.referencesUsed = toStringArray(strategy.referencesUsed ?? strategy.references_used ?? strategy.references, "lines");
  strategy.repetitionCheck = asStr(strategy.repetitionCheck ?? strategy.repetition_check);
  strategy.emotionalDriver = asStr(strategy.emotionalDriver ?? strategy.emotional_driver);
  root.strategy = strategy;

  // selfReview
  const review: Rec = isRec(root.selfReview) ? { ...root.selfReview } : isRec(root.self_review) ? { ...root.self_review } : {};
  let score = typeof review.score === "number" ? review.score : Number.parseFloat(asStr(review.score));
  if (!Number.isFinite(score)) {
    score = 5;
    repaired.push("score_defaulted");
  } else if (typeof review.score === "string") repaired.push("score_from_string");
  review.score = Math.max(1, Math.min(10, score));
  review.strengths = toStringArray(review.strengths, "lines");
  review.risks = toStringArray(review.risks, "lines");
  review.complianceCheck = Array.isArray(review.complianceCheck)
    ? review.complianceCheck.map(asStr).join("\n")
    : asStr(review.complianceCheck ?? review.compliance_check ?? review.compliance);
  root.selfReview = review;

  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 7: post-validation normalisation (deterministic, never changes meaning)
// ---------------------------------------------------------------------------------------------------------------

// Emoji and pictographs (supplementary planes + common symbol blocks), variation selector and ZWJ.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\uFE0F|\u200D/gu;
const DASH_RE = /\s*[\u2013\u2014]\s*/g;

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\*\s+/gm, "")
    .replace(/^\s*-\s+/gm, "");
}

function replaceDashes(s: string): { text: string; changed: boolean } {
  // A dash between two numbers is a range ("300–500 mg", "2–4 Werktage"): a plain hyphen keeps it readable, a comma would not.
  const text = s.replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2").replace(DASH_RE, ", ");
  return { text, changed: text !== s };
}

function cleanVoiceover(s: string): string {
  return s
    .replace(EMOJI_RE, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/gi, "Link in der Bio")
    .replace(/#\S+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalise(output: GenerationOutput, opts: ParseOptions | undefined, warnings: string[]): GenerationOutput {
  let dashReplaced = false;
  const fixText = (s: string): string => {
    const r = replaceDashes(s);
    if (r.changed) dashReplaced = true;
    return r.text;
  };
  const fixMd = (s: string): string => fixText(stripMarkdown(s));

  const hashtagRange = opts?.brief ? hashtagRangeFor(opts.brief.platform, opts.brief.postType, opts.brief.tone) : null;
  const variants: Variant[] = output.variants.map((v, idx) => {
    const seen = new Set<string>();
    const hashtags: string[] = [];
    for (const h of v.hashtags) {
      const tag = h.trim().replace(/^#+/, "").trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      hashtags.push(tag);
    }
    // More tags than the platform's range is a counting slip, and the strategist lists the strongest first: keep those.
    if (hashtagRange && hashtagRange.max > 0 && hashtags.length > hashtagRange.max) {
      warnings.push(`hashtags_trimmed:${hashtags.length}->${hashtagRange.max} (v${idx + 1})`);
      hashtags.length = hashtagRange.max;
    }
    return {
      ...v,
      title: fixText(v.title),
      hook: fixMd(v.hook),
      script: fixMd(v.script),
      onScreenText: v.onScreenText.map(fixMd),
      shots: v.shots.map((s) => ({ ...s, visual: fixText(s.visual), text: fixText(s.text), audio: fixText(s.audio) })),
      caption: fixMd(v.caption),
      hashtags,
      cta: fixMd(v.cta),
      visualDirection: fixText(v.visualDirection),
      audioDirection: fixText(v.audioDirection),
      thumbnailText: fixText(v.thumbnailText),
      voiceoverText: cleanVoiceover(fixText(v.voiceoverText)),
      altVersion: opts?.brief && opts.brief.language !== "de_en" ? "" : fixText(v.altVersion),
    };
  });

  const wanted = opts?.brief ? Number.parseInt(opts.brief.variants, 10) || 1 : variants.length;
  if (variants.length > wanted) warnings.push(`variants_truncated:${variants.length}->${wanted}`);
  if (dashReplaced) warnings.push("dash_replaced");

  return {
    strategy: {
      ...output.strategy,
      angle: fixText(output.strategy.angle),
      whyItFits: fixText(output.strategy.whyItFits),
      repetitionCheck: fixText(output.strategy.repetitionCheck),
    },
    variants: variants.slice(0, Math.max(1, wanted)),
    selfReview: { ...output.selfReview, complianceCheck: fixText(output.selfReview.complianceCheck) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Step 8: lint (warnings only)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Per-brand lint terms. They live on the brand (Brand.forbiddenTerms / claimTerms / claimSensitive, edited in the Brands tab)
 * and reach the lint through ParseOptions.brandRules.
 */
export type BrandLintRules = { forbiddenTerms: string[]; claimTerms: string[]; claimSensitive: boolean };
export const HEALTH_CLAIM_LEXICON = ["Testosteron", "Immunsystem", "steigert", "heilt", "wissenschaftlich belegt", "boost", "detox", "cures"];
/**
 * Softer effect wording for claim-sensitive brands: often a claim, sometimes a harmless scene ("Der dritte Kaffee hilft nicht"), so
 * it is listed for a human look (`claim_check:`, not blocking) instead of gating approval like the terms above.
 */
export const CLAIM_CHECK_LEXICON = [
  "hilft",
  "wirkt",
  "funktioniert",
  "stärkt",
  "unterstützt",
  "fördert",
  "verbessert",
  "mehr Energie",
  "natürliche Energie",
  "kein Crash",
  "keinen Crash",
  "ohne Crash",
  "gegen Müdigkeit",
  "macht wach",
  "Körper braucht",
  "Mineralien",
];
// "Sie"/"Ihnen"/"Ihr…" not at a sentence start (where "Sie" could be "they").
const SIE_RE = /[^.!?\n]\s(Sie|Ihnen|Ihrem|Ihren|Ihrer|Ihres|Ihr)\b/;
const DU_RE = /\b(du|dich|dir|dein|deine|deinen|deiner|deinem|deins|ihr|euch|euer|eure)\b/;
const IHR_EUCH_RE = /\b(ihr|euch)\b/;

function variantText(v: Variant): string {
  return [
    v.title,
    v.hook,
    v.script,
    ...v.onScreenText,
    ...v.shots.map((s) => `${s.visual} ${s.text} ${s.audio}`),
    v.caption,
    v.hashtags.join(" "),
    v.cta,
    v.thumbnailText,
    v.voiceoverText,
    v.altVersion,
  ].join("\n");
}

function isEmpty(v: Variant, field: string): boolean {
  const val = (v as unknown as Record<string, unknown>)[field];
  if (Array.isArray(val)) return val.length === 0;
  return !asStr(val).trim();
}

function parseSeconds(d: string): number | null {
  const m = d.match(/(\d+(?:[.,]\d+)?)\s*(?:s|sec|sek)/i) ?? d.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const REEL_BANDS: Record<string, [number, number]> = { short: [15, 25], medium: [25, 45], long: [45, 60] };

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** True when a and b share a run of at least minWords consecutive words (case-folded, punctuation ignored). */
function sharedRun(a: string, b: string, minWords: number): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length < minWords || wb.length < minWords) return false;
  const grams = new Set<string>();
  for (let i = 0; i + minWords <= wb.length; i++) grams.add(wb.slice(i, i + minWords).join(" "));
  for (let i = 0; i + minWords <= wa.length; i++) if (grams.has(wa.slice(i, i + minWords).join(" "))) return true;
  return false;
}

export function lintOutput(output: GenerationOutput, opts: ParseOptions | undefined): string[] {
  const warnings: string[] = [];
  const brief = opts?.brief;
  if (!brief) return warnings;
  const effective = mappedPostType(brief.postType, brief.platform);
  const mandatory = mandatorySectionsFor(brief.postType, brief.platform);
  const range = hashtagRangeFor(brief.platform, brief.postType, brief.tone);
  const german = brief.language === "de" || brief.language === "de_en";
  const forbidden = (opts?.brandRules?.forbiddenTerms ?? []).filter(Boolean);
  const claimTerms = (opts?.brandRules?.claimTerms ?? []).filter(Boolean);
  const claimSensitive = opts?.brandRules?.claimSensitive ?? false;
  const priorHooks = opts?.priorHooks ?? [];

  output.variants.forEach((v, idx) => {
    const tag = `v${idx + 1}`;
    for (const field of mandatory) if (isEmpty(v, field)) warnings.push(`missing:${brief.postType}:${field} (${tag})`);
    if (v.hashtags.length < range.min || v.hashtags.length > range.max) {
      warnings.push(`hashtags_out_of_range:${v.hashtags.length} (expected ${range.min}-${range.max}, ${tag})`);
    }
    if (brief.platform === "linkedin") {
      const firstLine = (v.caption || v.hook).split("\n")[0] ?? "";
      if (firstLine.length > 140) warnings.push(`linkedin_first_line_too_long:${firstLine.length} (${tag})`);
    }
    if (effective === "reel_script" && v.shots.length) {
      const secs = v.shots.map((s) => parseSeconds(s.duration));
      if (secs.every((s) => s !== null)) {
        const total = secs.reduce<number>((a, b) => a + (b ?? 0), 0);
        const band = REEL_BANDS[brief.length] ?? REEL_BANDS.medium;
        if (total < band[0] - 5 || total > band[1] + 5) {
          warnings.push(`shot_durations_off_band:${total}s (band ${band[0]}-${band[1]}s, ${tag})`);
        }
      }
    }
    if (v.hook.includes("!")) warnings.push(`exclamation_in_hook (${tag})`);
    const text = variantText(v);
    if (german && SIE_RE.test(text) && DU_RE.test(text)) warnings.push(`mixed_register (${tag})`);
    for (const f of forbidden) if (text.includes(f)) warnings.push(`forbidden_string:${f} (${tag})`);
    if (german && brief.register === "sie" && IHR_EUCH_RE.test(text)) {
      warnings.push(`forbidden_string:ihr/euch with register ${brief.register} (${tag})`);
    }
    {
      const lower = text.toLowerCase();
      if (claimSensitive) {
        for (const term of HEALTH_CLAIM_LEXICON) if (lower.includes(term.toLowerCase())) warnings.push(`health_claim_term:${term} (${tag})`);
        for (const term of CLAIM_CHECK_LEXICON) if (lower.includes(term.toLowerCase())) warnings.push(`claim_check:${term} (${tag})`);
      }
      for (const term of claimTerms) if (lower.includes(term.toLowerCase())) warnings.push(`claim_check:${term} (${tag})`);
    }
    for (const prior of priorHooks) {
      if (prior && sharedRun(v.hook, prior, 5)) {
        warnings.push(`hook_overlaps_prior:"${clip(prior, 60)}" (${tag})`);
        break;
      }
    }
  });

  const compliance = output.selfReview.complianceCheck.toLowerCase();
  if (output.selfReview.score > 5 && (/\bpending\b/.test(compliance) || /\bfix\b/.test(compliance))) {
    warnings.push(`score_too_high_with_pending_compliance:${output.selfReview.score}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------------------
// Generic tolerant JSON reader
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads a model reply that is not a GenerationOutput (the Ideas tab's idea list) with the same tolerance as the
 * generation parser: code fences and commentary stripped, truncated JSON closed, the usual syntax slips repaired.
 * `start` picks which bracket opens the root value: the first "{" or the first "[" in the reply.
 */
export function parseLooseJson(
  text: string,
  start: "{" | "[" = "{",
): { ok: true; value: unknown; repaired: string[] } | { ok: false; error: string } {
  const repaired: string[] = [];
  const precleaned = preClean(typeof text === "string" ? text : "");
  const cleaned = healMixedQuotes(precleaned);
  if (cleaned !== precleaned) repaired.push("mixed_quotes");
  if (!cleaned) return { ok: false, error: "The model returned an empty reply." };
  const located = locateFrom(cleaned, start);
  if (!located) return { ok: false, error: `No JSON found in the reply (no '${start}' present).` };
  let body = located.body;
  if (located.truncated) {
    body = closeTruncated(body);
    repaired.push("closed_truncated_json");
  }
  body = repairSyntax(body, repaired);
  try {
    return { ok: true, value: JSON.parse(body), repaired };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

export function parseGenerationOutput(text: string, opts?: ParseOptions): ParseResult {
  const raw = typeof text === "string" ? text : "";
  const repaired: string[] = [];
  try {
    const precleaned = preClean(raw);
    const cleaned = healMixedQuotes(precleaned); // before locating: an early-closed string would flip the quote parity
    if (cleaned !== precleaned) repaired.push("mixed_quotes");
    if (!cleaned) return { ok: false, error: "The model returned an empty reply.", raw };

    const located = locateObject(cleaned);
    if (!located) return { ok: false, error: "No JSON object found in the reply (no '{' present).", raw };
    let body = located.body;
    if (located.truncated) {
      body = closeTruncated(body);
      repaired.push("closed_truncated_json");
    }
    body = repairSyntax(body, repaired);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const at = msg.match(/position (\d+)/);
      const where = at ? ` at character ${at[1]}` : "";
      return { ok: false, error: `Invalid JSON${where}: ${msg}`, raw };
    }

    const shaped = coerce(parsed, repaired);
    const result = GenerationOutputSchema.safeParse(shaped);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      const hint = repaired.includes("strategy_missing") ? "The reply had no 'strategy' object. " : "";
      return { ok: false, error: `${hint}Output does not match the contract: ${issues.join("; ")}`, raw };
    }

    const warnings: string[] = [];
    const output = normalise(result.data, opts, warnings);
    warnings.push(...lintOutput(output, opts));
    return { ok: true, output, repaired, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Unexpected parser failure: ${msg}`, raw };
  }
}
