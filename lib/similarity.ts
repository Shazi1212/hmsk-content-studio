/**
 * Normalised text similarity for hooks, plus the hook repetition and evergreen-refresh check.
 * Pure: no network, no database; the clock is passed in. Client-safe (the history list uses `refreshDue`).
 *
 * Why not only word shingles (lib/retrieval.ts): a reworded hook ("Fresh coffee tastes flat after two weeks. Here's why.") shares no
 * three-word run with the original ("Why does fresh coffee taste flat after two weeks?") but is the same post. Here both texts are
 * folded (case, accents, ß, punctuation, emoji, hashtags), stopwords are dropped and words are lightly stemmed; the score is the larger
 * of the token Jaccard and the character-trigram Jaccard of what is left, 0..1.
 */

// ---------------------------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------------------------

/** Function words in English and German, in folded form (no umlauts). */
const STOPWORDS = new Set(
  (
    "the a an and or of to in on for with is are was were be been by at as it its this that these those from not you your we our " +
    "they their has have had will can but if about into than then so do does did how what when where who why which here there " +
    "just also very more most all any no yes my me us i im youre its dont doesnt isnt cant lets heres thats whats " +
    "der die das den dem des ein eine einer eines einem einen und oder ist sind war waren sein nicht mit fur von auf aus bei zu zum " +
    "zur im in an am als auch wie wir ihr sie es er ich du man was wer wo wann warum noch mehr nur so sich dass wenn dann aber doch " +
    "schon sehr kann konnen wird werden hat haben euch uns mich dich dir mir dein deine unser unsere mein meine kein keine hier"
  ).split(/\s+/),
);

const SUFFIXES = ["ing", "ed", "es", "en", "er", "e", "s", "n"];

/** Lowercase, accents and ß folded, URLs / handles / hashtags / emoji / punctuation removed, whitespace collapsed. */
export function foldText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stem(token: string): string {
  for (const s of SUFFIXES) if (token.length - s.length >= 4 && token.endsWith(s)) return token.slice(0, -s.length);
  return token;
}

/** Content words of a text: folded, without stopwords and one-letter tokens, lightly stemmed. */
export function contentTokens(text: string | null | undefined): string[] {
  return foldText(text)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Jaccard of the content-word sets. */
export function tokenJaccard(a: string, b: string): number {
  return jaccard(new Set(contentTokens(a)), new Set(contentTokens(b)));
}

function trigrams(text: string): Set<string> {
  const s = ` ${contentTokens(text).join(" ")} `;
  const out = new Set<string>();
  if (s.trim().length === 0) return out;
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Jaccard of the character trigrams of the content words (robust to inflection and small spelling changes). */
export function trigramSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** Normalised similarity of two hooks, 0..1: the larger of token Jaccard and trigram Jaccard. */
export function hookSimilarity(a: string, b: string): number {
  return Math.max(tokenJaccard(a, b), trigramSimilarity(a, b));
}

// ---------------------------------------------------------------------------------------------------------------
// Hook repetition + evergreen refresh
// ---------------------------------------------------------------------------------------------------------------

/** From this similarity on, a new hook counts as a repeat of a recent one. */
export const HOOK_SIMILARITY_THRESHOLD = 0.6;
/** From this similarity on, a new hook revisits an older published piece (evergreen refresh hint). */
export const REFRESH_SIMILARITY_THRESHOLD = 0.45;
/** Default age in days after which a published piece may be refreshed instead of counting as a repeat. */
export const DEFAULT_REFRESH_AFTER_DAYS = 180;

const DAY_MS = 86_400_000;

export type HistorySource = "approved" | "draft" | "post";

/** One earlier piece of the brand: an approved generation, a saved draft or a (synced or imported) post. */
export type HistoryItem = {
  id: string;
  source: HistorySource;
  hook: string;
  /** When it went out: approval date for approved generations, the post date for posts; null when unknown. Drafts: creation date. */
  date: Date | null;
  /** Link of a post, shown with the warning. */
  url?: string | null;
};

export type HookRepetitionOptions = {
  now: Date;
  /** Published pieces at least this many days old get a refresh hint instead of a repetition warning; 0 switches the hint off. */
  refreshAfterDays?: number;
  threshold?: number;
  refreshThreshold?: number;
};

export type HookRepetitionResult = { warnings: string[]; hints: string[]; maxSimilarity: number };

const SOURCE_LABEL: Record<HistorySource, string> = { approved: "approved generation", draft: "saved draft", post: "post" };

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const quote = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Age in whole days, or null when the date is unknown or in the future. */
export function ageInDays(date: Date | null | undefined, now: Date): number | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  return days >= 0 ? days : null;
}

/** True when a published piece is old enough to be refreshed (refreshAfterDays > 0 and its age reaches it). */
export function refreshDue(date: Date | null | undefined, now: Date, refreshAfterDays: number = DEFAULT_REFRESH_AFTER_DAYS): boolean {
  const age = ageInDays(date, now);
  return refreshAfterDays > 0 && age !== null && age >= refreshAfterDays;
}

/** Parses a stored post date ("2026-03-14", ISO timestamps); relative or free-text dates ("3 weeks ago") give null. */
export function parsePostDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compares every variant hook with the brand's earlier hooks. Per variant, the closest recent match at or above `threshold` is a
 * warning; the closest match among published pieces older than `refreshAfterDays` (at or above `refreshThreshold`) is an evergreen
 * refresh hint instead, since bringing back an idea that worked months ago is a refresh, not a repeat. Drafts are never "published".
 */
export function hookRepetition(variants: { hook: string }[], history: HistoryItem[], opts: HookRepetitionOptions): HookRepetitionResult {
  const threshold = opts.threshold ?? HOOK_SIMILARITY_THRESHOLD;
  const refreshThreshold = opts.refreshThreshold ?? REFRESH_SIMILARITY_THRESHOLD;
  const refreshAfterDays = opts.refreshAfterDays ?? DEFAULT_REFRESH_AFTER_DAYS;
  const warnings: string[] = [];
  const hints: string[] = [];
  let max = 0;

  const seen = new Set<string>();
  const items = history.filter((h) => {
    const key = `${h.source}:${h.id}`;
    if (!h.hook.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  variants.forEach((v, i) => {
    if (!v.hook.trim()) return;
    let repeat: { item: HistoryItem; sim: number } | null = null;
    let refresh: { item: HistoryItem; sim: number; age: number } | null = null;
    for (const item of items) {
      const sim = hookSimilarity(v.hook, item.hook);
      const age = ageInDays(item.date, opts.now);
      const evergreen = item.source !== "draft" && refreshDue(item.date, opts.now, refreshAfterDays);
      if (evergreen && age !== null) {
        if (sim >= refreshThreshold && (!refresh || sim > refresh.sim)) refresh = { item, sim, age };
        continue;
      }
      max = Math.max(max, sim);
      if (sim >= threshold && (!repeat || sim > repeat.sim)) repeat = { item, sim };
    }
    const n = i + 1;
    if (repeat) {
      const { item, sim } = repeat;
      const when = item.date ? ` (${isoDay(item.date)})` : "";
      const link = item.url ? ` ${item.url}` : "";
      warnings.push(`Variant ${n} hook is ${pct(sim)} similar to ${SOURCE_LABEL[item.source]} "${quote(item.hook)}"${when}${link}; rephrase it or pick another angle.`);
    }
    if (refresh) {
      const { item, sim, age } = refresh;
      hints.push(
        `Evergreen refresh: variant ${n} revisits ${SOURCE_LABEL[item.source]} "${quote(item.hook)}" from ${isoDay(item.date as Date)} ` +
          `(${age} days ago, ${pct(sim)} similar). Older than ${refreshAfterDays} days, so bringing it back is fine: update facts, prices and links and keep what worked.`,
      );
    }
  });

  return { warnings, hints, maxSimilarity: Math.round(max * 100) / 100 };
}
