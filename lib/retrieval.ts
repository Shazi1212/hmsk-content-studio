/**
 * Reference retrieval + repetition checks.
 *
 * selectReferences(): picks the ReferencePost rows a generation should learn from (High/Exceptional mechanisms),
 * calibrate against (Typical) and avoid (Low), plus the last approved generations so the model does not repeat
 * itself. Pure keyword/token scoring over the seeded research rows: no embeddings, no external services.
 *
 * repetitionReport(): hook repetition with the normalised similarity of lib/similarity.ts against approved generations, saved drafts
 * and the brand's posts (with an evergreen-refresh hint for old published pieces), plus word-shingle (3-gram) Jaccard for captions,
 * reused hook wording and the variants among themselves.
 *
 * loadHookHistory(): the brand's recent approved generations, saved drafts and posts for that check (database read).
 */
import type { Generation, ReferencePost } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BriefSchema, GenerationOutputSchema, HOOK_TYPES, type Brief, type GenerationOutput, type Variant } from "@/lib/types";
import { clip } from "@/lib/text";
import { DEFAULT_REFRESH_AFTER_DAYS, hookRepetition, parsePostDate, refreshDue, type HistoryItem } from "@/lib/similarity";

// ---------------------------------------------------------------------------------------------------------------
// Tokenisation helpers (shared by retrieval and repetition checks)
// ---------------------------------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "der die das und oder ein eine einer eines einem einen ist sind nicht mit für fuer von auf aus bei zu zum zur den dem des " +
    "im in an am als auch wie wir ihr sie es er ich du man was wer wo wann warum noch mehr nur so sich ihre ihren ihrem seine " +
    "dass wenn dann aber doch schon sehr kann können koennen wird werden hat haben war waren euch uns mich dich " +
    "the and or a an of to in on for with is are be by at as it this that from not you your we our they their has have was " +
    "were will can but if about into than then more most over under after before between out up down off all any each few " +
    "no nor own same some such very just also how what when where who why which its it's do does did done get got via per"
  ).split(/\s+/),
);

/** Lowercase word tokens (letters/digits incl. umlauts), no stopwords, min length 3. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Tokens for repetition checks: keeps stopwords (word order matters for shingles), min length 2. */
function shingleTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#\S+/g, " ")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function shingles(text: string | null | undefined, n = 3): Set<string> {
  const tokens = shingleTokens(text);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < n) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Share of `a`'s shingles that also occur in `b` (asymmetric; for short-vs-long comparisons). */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / a.size;
}

/** Similarity of two short texts, 0..1: the larger of word-shingle Jaccard and containment either way. Keeps brainstormed ideas apart from hooks already used. */
export function textSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  return Math.max(jaccard(sa, sb), containment(sa, sb), containment(sb, sa));
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------------------------------------------

export type PerformanceBucket = "exceptional" | "high" | "mixed" | "typical" | "low" | "unknown";

/** "High (views) / Low (interaction)": reach without resonance. Learn the distribution mechanism, never the copy. */
export function isMixedPerformance(level: string | null | undefined): boolean {
  const s = (level ?? "").trim().toLowerCase();
  const slash = s.indexOf("/");
  if (slash < 0) return false;
  const head = s.slice(0, slash).trim();
  const tail = s.slice(slash + 1).trim();
  return tail.startsWith("low") && (head.startsWith("high") || head.startsWith("exceptional") || head.startsWith("typical"));
}

/**
 * Maps the free-text research label ("High (views) / Low (interaction)", "Typical-High", …) to a bucket.
 * Mixed labels (high reach, low interaction) are their own bucket so the model is never told to rebuild the copy of
 * a post whose observations flag a copy error; retrieval treats them as baseline material.
 */
export function performanceBucket(level: string | null | undefined): PerformanceBucket {
  const s = (level ?? "").trim().toLowerCase();
  if (!s || s.startsWith("unknown")) return "unknown";
  if (isMixedPerformance(s)) return "mixed";
  if (s.startsWith("exceptional")) return "exceptional";
  if (s.startsWith("typical-high")) return "high";
  if (s.startsWith("high")) return "high";
  if (s.startsWith("low-typical")) return "low";
  if (s.startsWith("low")) return "low";
  if (s.startsWith("typical")) return "typical";
  return "unknown";
}

export type PlatformFamily = "social" | "linkedin" | "text";

/** instagram/tiktok/youtube/facebook → "social"; linkedin* → "linkedin"; x → "text". */
export function platformFamily(platform: string | null | undefined): PlatformFamily {
  const p = (platform ?? "").toLowerCase();
  if (p.startsWith("linkedin")) return "linkedin";
  if (p === "x" || p === "twitter") return "text";
  return "social";
}

const POST_TYPE_FORMAT_HINTS: Record<string, string[]> = {
  reel_script: ["reel", "video", "tiktok"],
  talking_head: ["talking head", "talking-head", "video", "reel"],
  carousel: ["carousel"],
  static_post: ["static", "image", "photo"],
  story_sequence: ["story"],
  linkedin_text: ["text post"],
  linkedin_document: ["document"],
  youtube_script: ["video"],
  ugc_testimonial_brief: ["testimonial", "ugc", "collab", "creator"],
  ad_creative: ["paid", "partnership", "werbung", "ad"],
  blog_to_social: ["article", "blog", "text post"],
};

const HOOK_TYPE_HINTS: Record<string, string[]> = {
  problem_question: ["problem question", "problem", "question"],
  statistic: ["statistic", "number"],
  contrarian: ["contrarian", "counter-intuitive", "provocative", "paradox", "contradiction"],
  story_scene: ["story", "scene", "opener"],
  time_stamped_scene: ["time-stamped", "time stamped", "scenario"],
  pattern_interrupt: ["pattern interrupt"],
  curiosity: ["curiosity", "secret"],
  how_to: ["how-to", "how to", "imperative"],
  myth_bust: ["myth"],
  listicle: ["listicle", "numbered", "list"],
  social_proof: ["social proof", "testimonial"],
  aphorism: ["aphorism", "contrast", "two-line", "two line"],
  pov_relatable: ["pov", "relatable", "humor", "humour"],
};

function hookTypeLabel(id: string): string {
  return HOOK_TYPES.find((h) => h.id === id)?.label ?? id;
}

const HOOK_TYPE_ID_SET = new Set(HOOK_TYPES.map((h) => h.id));

/**
 * Specific phrases only: a research label such as "Question", "Statement" or "Contrast statement" is generic and
 * maps to "" so that fresh_angle never drops half a brand's references over one shared word.
 */
const HOOK_TYPE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["time_stamped_scene", /time[- ]?stamp/],
  ["pattern_interrupt", /pattern[- ]interrupt/],
  ["social_proof", /social[- ]proof|testimonial/],
  ["myth_bust", /myth/],
  ["listicle", /listicle|numbered[- ]list/],
  ["how_to", /how[- ]to/],
  ["problem_question", /problem[- ]question/],
  ["statistic", /statistic/],
  ["contrarian", /contrarian|counter[- ]?intuitive|provocative|paradox/],
  ["story_scene", /story[- ]opener|scene[- ]opener|\bstory\b/],
  ["curiosity", /curiosity/],
  ["aphorism", /aphorism|two[- ]line/],
  ["pov_relatable", /\bpov\b|relatable/],
];

/** Catalog id for a free-text hook-type label (research row, prior variant, HOOK_TYPES label), or "" when generic. */
export function canonicalHookType(text: string | null | undefined): string {
  const s = (text ?? "").trim().toLowerCase();
  if (!s || s === "auto") return "";
  if (HOOK_TYPE_ID_SET.has(s)) return s;
  for (const [id, re] of HOOK_TYPE_PATTERNS) if (re.test(s)) return id;
  return "";
}

function parseDate(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Prior-generation helpers
// ---------------------------------------------------------------------------------------------------------------

export type PriorVariant = { hook: string; caption: string; hookType: string; title: string };

/** Extracts the variants of a saved Generation (falls back to outputText when the JSON does not validate). */
export function priorVariants(gen: Pick<Generation, "output" | "outputText">): PriorVariant[] {
  const parsed = GenerationOutputSchema.safeParse(gen.output);
  if (parsed.success) {
    return parsed.data.variants.map((v) => ({ hook: v.hook, caption: v.caption, hookType: v.hookType, title: v.title }));
  }
  return [{ hook: "", caption: gen.outputText, hookType: "", title: "" }];
}

export function priorBrief(gen: Pick<Generation, "brief">): Brief | null {
  const parsed = BriefSchema.safeParse(gen.brief);
  return parsed.success ? parsed.data : null;
}

/** Short label for a prior generation in warnings/notes. */
export function generationLabel(gen: Pick<Generation, "id" | "createdAt" | "output" | "outputText">): string {
  const hook = priorVariants(gen)[0]?.hook ?? "";
  const date = gen.createdAt instanceof Date ? gen.createdAt.toISOString().slice(0, 10) : "";
  const short = hook.length > 60 ? `${clip(hook, 57)}…` : hook;
  return short ? `"${short}" (${date})` : `#${gen.id.slice(-6)} (${date})`;
}

// ---------------------------------------------------------------------------------------------------------------
// selectReferences
// ---------------------------------------------------------------------------------------------------------------

type Scored = { post: ReferencePost; score: number; bucket: PerformanceBucket };

function scoreReference(post: ReferencePost, brief: Brief, queryTokens: Set<string>, pillarTokens: Set<string>): number {
  let score = 0;

  // Platform family / exact platform.
  const briefFamily = platformFamily(brief.platform);
  const postFamily = platformFamily(post.platform);
  if (briefFamily === postFamily) score += 3;
  else if (briefFamily === "text" && postFamily === "linkedin") score += 1.5; // X posts learn most from LinkedIn text
  if (post.platform.toLowerCase().startsWith(brief.platform.toLowerCase())) score += 1;

  // Pillar similarity (brief.pillar is the brand pillar label or "custom").
  if (pillarTokens.size > 0) {
    const postPillar = new Set([...tokenize(post.pillar), ...tokenize(post.topic)]);
    const n = overlapCount(pillarTokens, postPillar);
    if (n > 0) score += Math.min(3, 1.5 + 0.5 * n);
  }

  // Keyword overlap between brief topic/mustInclude and searchText.
  if (queryTokens.size > 0) {
    const postTokens = new Set(tokenize(post.searchText));
    const n = overlapCount(queryTokens, postTokens);
    score += Math.min(6, n) * 0.75;
  }

  // Format ↔ post type.
  const format = (post.format ?? "").toLowerCase();
  const hints = POST_TYPE_FORMAT_HINTS[brief.postType] ?? [];
  if (format && hints.some((h) => format.includes(h))) score += 1.5;

  // Hook type.
  if (brief.hookType !== "auto") {
    const ht = (post.hookType ?? "").toLowerCase();
    const hh = HOOK_TYPE_HINTS[brief.hookType] ?? [];
    if (ht && hh.some((h) => ht.includes(h))) score += 1;
  }

  // Emotional driver.
  if (brief.emotionalDriver !== "auto") {
    const ed = (post.emotionalDriver ?? "").toLowerCase();
    if (ed && ed.includes(brief.emotionalDriver.replace("_", " "))) score += 0.5;
  }

  // Tie-breakers: recency (max +0.5 for posts within the last year) and confidence.
  const age = Date.now() - parseDate(post.date);
  if (age > 0 && age < 365 * 24 * 3600 * 1000) score += 0.5 * (1 - age / (365 * 24 * 3600 * 1000));
  if ((post.confidence ?? "").toLowerCase().startsWith("high")) score += 0.25;

  return score;
}

function take(list: Scored[], n: number, used: Set<string>): Scored[] {
  const out: Scored[] = [];
  for (const s of list) {
    if (out.length >= n) break;
    if (used.has(s.post.id)) continue;
    used.add(s.post.id);
    out.push(s);
  }
  return out;
}

export async function selectReferences(p: {
  brandId: string;
  brief: Brief;
  limit?: number;
}): Promise<{ references: ReferencePost[]; priorApproved: Generation[]; notes: string[] }> {
  const { brandId, brief } = p;
  const notes: string[] = [];
  const strategy = brief.referenceStrategy;

  if (strategy === "none") {
    notes.push("Reference strategy 'none': no historical posts or approved generations were provided to the model.");
    return { references: [], priorApproved: [], notes };
  }

  const [posts, priorApproved] = await Promise.all([
    prisma.referencePost.findMany({ where: { brandId } }),
    // Mock-strategist output is template text: approving it (for a UI test) must never steer real generations.
    prisma.generation.findMany({
      where: { brandId, status: "approved", provider: { not: "mock" } },
      orderBy: [{ approvedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 10,
    }),
  ]);

  const limit = Math.max(3, Math.min(30, Math.round(p.limit ?? 12)));
  let highN: number;
  let typicalN: number;
  if (strategy === "model_high_performers") {
    highN = Math.round(limit * 0.67);
    typicalN = Math.round(limit * 0.17);
  } else {
    highN = Math.round(limit * 0.5);
    typicalN = Math.round(limit * 0.25);
  }
  const lowN = Math.max(0, limit - highN - typicalN);

  const queryTokens = new Set(tokenize(`${brief.topic} ${brief.mustInclude}`));
  const pillarTokens = brief.pillar.toLowerCase() === "custom" ? new Set<string>() : new Set(tokenize(brief.pillar));

  // fresh_angle: pillars and hook types used in the last approved generations are off the table. Pillars match by
  // token overlap; hook types only by exact catalog id (canonicalHookType), never by a shared generic word.
  let usedPillarTokens = new Set<string>();
  const usedHookTypeIds = new Set<string>();
  if (strategy === "fresh_angle" && priorApproved.length > 0) {
    const pillarLabels: string[] = [];
    const hookLabels: string[] = [];
    for (const g of priorApproved) {
      const b = priorBrief(g);
      if (b) {
        if (b.pillar.toLowerCase() !== "custom") pillarLabels.push(b.pillar);
        if (b.hookType !== "auto") {
          usedHookTypeIds.add(b.hookType);
          hookLabels.push(hookTypeLabel(b.hookType));
        }
      }
      for (const v of priorVariants(g)) {
        const id = canonicalHookType(v.hookType);
        if (id) {
          usedHookTypeIds.add(id);
          hookLabels.push(hookTypeLabel(id));
        } else if (v.hookType) hookLabels.push(v.hookType);
      }
    }
    usedPillarTokens = new Set(pillarLabels.flatMap((l) => tokenize(l)));
    if (pillarLabels.length) notes.push(`fresh_angle: recently used pillars → ${[...new Set(pillarLabels)].join(" | ")}`);
    if (hookLabels.length) notes.push(`fresh_angle: recently used hook types → ${[...new Set(hookLabels)].join(" | ")}`);
  }

  let excluded = 0;
  const scored: Scored[] = [];
  const excludedScored: Scored[] = [];
  for (const post of posts) {
    const bucket = performanceBucket(post.performanceLevel);
    let score = scoreReference(post, brief, queryTokens, pillarTokens);
    if (bucket === "unknown") score -= 1;
    const entry: Scored = { post, score, bucket };
    if (strategy === "fresh_angle") {
      const postPillar = new Set(tokenize(post.pillar));
      const pillarHit = postPillar.size > 0 && overlapCount(postPillar, usedPillarTokens) / postPillar.size >= 0.5;
      const postHookId = canonicalHookType(post.hookType);
      const hookHit = postHookId !== "" && usedHookTypeIds.has(postHookId);
      if (pillarHit || hookHit) {
        excluded++;
        excludedScored.push(entry);
        continue;
      }
    }
    scored.push(entry);
  }

  const byScore = (a: Scored, b: Scored) => b.score - a.score || parseDate(b.post.date) - parseDate(a.post.date);
  const highList = scored.filter((s) => s.bucket === "exceptional" || s.bucket === "high").sort(byScore);
  // Exceptional first when scores are close (they carry the strongest mechanisms).
  highList.sort((a, b) => {
    const d = b.score - a.score;
    if (Math.abs(d) > 1.5) return d;
    if (a.bucket !== b.bucket) return a.bucket === "exceptional" ? -1 : 1;
    return d;
  });
  // Mixed (high reach / low interaction) and unknown rows are baseline material, never "what worked".
  const typicalList = scored.filter((s) => s.bucket === "typical" || s.bucket === "mixed" || s.bucket === "unknown").sort(byScore);
  const lowList = scored.filter((s) => s.bucket === "low").sort(byScore);

  const used = new Set<string>();
  const high = take(highList, highN, used);
  const typical = take(typicalList, typicalN, used);
  const low = take(lowList, lowN, used);
  // Backfill from the whole scored pool (unfiltered) if a bucket is short, so the model still sees `limit`
  // examples. Posts excluded by fresh_angle come last; the prompt's "recently used … forbidden" line still applies.
  const rest = [...scored.sort(byScore), ...excludedScored.sort(byScore)];
  const fill = take(rest, limit - high.length - typical.length - low.length, used);
  const fillFromExcluded = fill.filter((s) => excludedScored.includes(s)).length;

  const references = [...high, ...typical, ...low, ...fill].map((s) => s.post);

  const familyLabel = platformFamily(brief.platform);
  notes.push(
    `Selected ${references.length} of ${posts.length} reference posts (strategy '${strategy}', platform family '${familyLabel}'): ` +
      `${high.length} high/exceptional, ${typical.length} typical, ${low.length} low${fill.length ? `, ${fill.length} backfilled` : ""}.`,
  );
  if (queryTokens.size) notes.push(`Topic keywords used for matching: ${[...queryTokens].slice(0, 12).join(", ")}.`);
  if (excluded) {
    notes.push(
      `fresh_angle: ${excluded} posts whose pillar or hook type was used in recent approved generations were ranked last` +
        (fillFromExcluded ? ` (${fillFromExcluded} still shown to fill the selection).` : " and not shown."),
    );
  }
  notes.push(
    priorApproved.length
      ? `${priorApproved.length} approved generation(s) supplied for repetition avoidance (newest: ${generationLabel(priorApproved[0])}).`
      : "No approved generations yet for this brand; repetition check runs against reference posts only.",
  );

  return { references, priorApproved, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// repetitionReport
// ---------------------------------------------------------------------------------------------------------------

const WARN_THRESHOLD = 0.35;
const VARIANT_WARN_THRESHOLD = 0.5;

function fmt(n: number): string {
  return n.toFixed(2);
}

function shortText(s: string, n = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${clip(t, n - 1)}…` : t;
}

export type Repetition = { warnings: string[]; maxSimilarity: number; hints: string[] };

export type RepetitionOptions = {
  /** Further earlier pieces of the brand (saved drafts, older approved generations, synced posts), see loadHookHistory(). */
  history?: HistoryItem[];
  /** Reference time for ages; passed in so the report stays deterministic. Default: now. */
  now?: Date;
  /** Brand setting: published pieces at least this old get an evergreen-refresh hint instead of a repetition warning (0 = off). */
  refreshAfterDays?: number;
};

const approvedDate = (gen: Pick<Generation, "approvedAt" | "createdAt">): Date => gen.approvedAt ?? gen.createdAt;

/** Approved generations and posts as HistoryItems for the hook check. */
export function toHistoryItems(priorApproved: Generation[], references: ReferencePost[]): HistoryItem[] {
  return [
    ...priorApproved.flatMap((gen) =>
      priorVariants(gen).map((pv, i) => ({ id: `${gen.id}#${i}`, source: "approved" as const, hook: pv.hook, date: approvedDate(gen) })),
    ),
    ...references.map((post) => ({ id: post.id, source: "post" as const, hook: post.hook ?? "", date: parsePostDate(post.date), url: post.postUrl })),
  ];
}

export function repetitionReport(
  output: GenerationOutput,
  priorApproved: Generation[],
  references: ReferencePost[],
  opts: RepetitionOptions = {},
): Repetition {
  const warnings: string[] = [];
  const now = opts.now ?? new Date();
  const refreshAfterDays = opts.refreshAfterDays ?? DEFAULT_REFRESH_AFTER_DAYS;

  const variants: Variant[] = output.variants;
  const variantShingles = variants.map((v) => ({
    hook: shingles(v.hook),
    caption: shingles(v.caption),
    script: shingles(v.script),
  }));

  // 0) Hook against hook: normalised similarity over every earlier piece; old published pieces become refresh hints.
  const hooks = hookRepetition(variants, [...toHistoryItems(priorApproved, references), ...(opts.history ?? [])], { now, refreshAfterDays });
  warnings.push(...hooks.warnings);
  let max = hooks.maxSimilarity;

  // 1) Against approved generations: caption↔caption and the hook's wording inside a prior caption or hook.
  priorApproved.forEach((gen) => {
    if (refreshDue(approvedDate(gen), now, refreshAfterDays)) return; // evergreen: covered by the refresh hint
    const label = generationLabel(gen);
    const prior = priorVariants(gen);
    prior.forEach((pv) => {
      const ph = shingles(pv.hook);
      const pc = shingles(pv.caption);
      variantShingles.forEach((vs, i) => {
        const n = i + 1;
        const capSim = jaccard(vs.caption, pc);
        const hookInPrior = Math.max(containment(vs.hook, pc), containment(vs.hook, ph));
        max = Math.max(max, capSim, hookInPrior);
        if (hookInPrior > WARN_THRESHOLD && vs.hook.size > 1 && !hooks.warnings.some((w) => w.startsWith(`Variant ${n} hook `)))
          warnings.push(`Variant ${n} hook reuses wording from approved generation ${label} (${fmt(hookInPrior)}).`);
        if (capSim > WARN_THRESHOLD) warnings.push(`Variant ${n} caption is ${fmt(capSim)} similar to approved generation ${label}.`);
      });
    });
  });

  // 2) Against reference posts: their hook must not be pasted into the caption.
  references.forEach((post) => {
    const refHook = post.hook ?? "";
    if (!refHook.trim()) return;
    if (refreshDue(parsePostDate(post.date), now, refreshAfterDays)) return;
    const rh = shingles(refHook);
    if (rh.size === 0) return;
    variantShingles.forEach((vs, i) => {
      const n = i + 1;
      const hookInCaption = containment(rh, vs.caption);
      max = Math.max(max, hookInCaption);
      if (hookInCaption > WARN_THRESHOLD && rh.size > 1)
        warnings.push(`Variant ${n} caption reuses the hook of reference post "${shortText(refHook)}" (${post.postUrl}).`);
    });
  });

  // 3) Variants against each other (they must be genuinely different angles).
  for (let i = 0; i < variantShingles.length; i++) {
    for (let j = i + 1; j < variantShingles.length; j++) {
      const hookSim = jaccard(variantShingles[i].hook, variantShingles[j].hook);
      const capSim = jaccard(variantShingles[i].caption, variantShingles[j].caption);
      const scriptSim = jaccard(variantShingles[i].script, variantShingles[j].script);
      const best = Math.max(hookSim, capSim, scriptSim);
      if (best > VARIANT_WARN_THRESHOLD)
        warnings.push(`Variants ${i + 1} and ${j + 1} are too similar to each other (${fmt(best)}); regenerate for distinct angles.`);
    }
  }

  // 4) Exact duplicate hooks inside the same output.
  const seen = new Map<string, number>();
  variants.forEach((v, i) => {
    const key = shingleTokens(v.hook).join(" ");
    if (!key) return;
    const prev = seen.get(key);
    if (prev !== undefined) warnings.push(`Variants ${prev + 1} and ${i + 1} have the same hook.`);
    else seen.set(key, i);
  });

  return { warnings: [...new Set(warnings)], maxSimilarity: Math.round(max * 100) / 100, hints: hooks.hints };
}

// ---------------------------------------------------------------------------------------------------------------
// loadHookHistory
// ---------------------------------------------------------------------------------------------------------------

/**
 * The brand's earlier hooks for the repetition check, beyond the few approved generations and references the prompt shows: the latest
 * approved generations and saved drafts (mock output excluded) and the most recently imported or synced posts.
 */
export async function loadHookHistory(brandId: string, limits: { generations?: number; posts?: number } = {}): Promise<HistoryItem[]> {
  const [gens, posts] = await Promise.all([
    prisma.generation.findMany({
      where: { brandId, status: { in: ["approved", "draft"] }, provider: { not: "mock" } },
      orderBy: { createdAt: "desc" },
      take: limits.generations ?? 60,
      select: { id: true, status: true, output: true, outputText: true, approvedAt: true, createdAt: true },
    }),
    prisma.referencePost.findMany({
      where: { brandId, hook: { not: null } },
      orderBy: { createdAt: "desc" },
      take: limits.posts ?? 200,
      select: { id: true, hook: true, date: true, postUrl: true },
    }),
  ]);
  return [
    ...gens.flatMap((g) =>
      priorVariants(g).map((pv, i) => ({
        id: `${g.id}#${i}`,
        source: g.status === "approved" ? ("approved" as const) : ("draft" as const),
        hook: pv.hook,
        date: g.status === "approved" ? (g.approvedAt ?? g.createdAt) : g.createdAt,
      })),
    ),
    ...posts.map((p) => ({ id: p.id, source: "post" as const, hook: p.hook ?? "", date: parsePostDate(p.date), url: p.postUrl })),
  ];
}
