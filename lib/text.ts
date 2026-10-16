/**
 * Text helpers for strings that end up in the database.
 *
 * `"…😀…".slice(0, n)` can cut an emoji (a surrogate pair of two UTF-16 units) in half. The lone high surrogate is a legal JavaScript string
 * but not legal JSON text for Prisma's Rust engine: it answers `unexpected end of hex escape at line 1 column …` and the whole write fails.
 * That is how a TikTok sync of a brand whose captions carry emojis failed. `clip` never cuts inside a pair, `wellFormed` and
 * `scrubDeep` replace any lone surrogate that still arrives (from a platform API or a model) by U+FFFD, and lib/db.ts runs `scrubDeep`
 * over every write as a safety net.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g"); // a global regex keeps lastIndex between test() calls, so the check uses the plain one

/** `text` with every unpaired surrogate replaced by U+FFFD. */
export function wellFormed(text: string): string {
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATES, "�") : text;
}

/** At most `max` UTF-16 units of `text`, never ending in half of an emoji. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Deep copy of plain objects and arrays with every string made well-formed; Dates, Buffers, Decimals and other class instances pass through untouched. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out as T;
  }
  return value;
}
