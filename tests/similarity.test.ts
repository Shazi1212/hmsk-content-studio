import { describe, expect, it } from "vitest";
import {
  ageInDays,
  contentTokens,
  foldText,
  HOOK_SIMILARITY_THRESHOLD,
  hookRepetition,
  hookSimilarity,
  parsePostDate,
  refreshDue,
  tokenJaccard,
  trigramSimilarity,
  type HistoryItem,
} from "@/lib/similarity";

const now = new Date("2026-10-19T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("normalisation", () => {
  it("folds case, accents, ß, punctuation, emoji, hashtags and links", () => {
    expect(foldText("Größe & Café! ☕ #Kaffee @shop https://x.example/a")).toBe("grosse cafe");
    expect(foldText(null)).toBe("");
  });

  it("drops stopwords and stems lightly", () => {
    expect(contentTokens("Why does fresh coffee taste flat after two weeks?")).toEqual(["fresh", "coffe", "tast", "flat", "after", "two", "week"]);
    expect(contentTokens("Fresh coffee tastes flat")).toEqual(["fresh", "coffe", "tast", "flat"]);
    expect(contentTokens("Warum schmeckt der Kaffee nach zwei Wochen flach?")).toEqual(["schmeckt", "kaffe", "nach", "zwei", "woch", "flach"]);
  });
});

describe("hookSimilarity", () => {
  it("is 1 for the same hook with different punctuation and case", () => {
    expect(hookSimilarity("Why does fresh coffee taste flat?", "why does FRESH coffee taste flat")).toBe(1);
  });

  it("scores a reworded hook above the threshold", () => {
    const s = hookSimilarity("Why does fresh coffee taste flat after two weeks?", "Fresh coffee tastes flat after two weeks. Here's why.");
    expect(s).toBeGreaterThanOrEqual(HOOK_SIMILARITY_THRESHOLD);
  });

  it("catches inflection and small spelling changes through trigrams", () => {
    expect(trigramSimilarity("Röstdatum schlägt Etikett", "Rostdaten schlagen Etiketten")).toBeGreaterThan(0.4);
  });

  it("keeps different hooks on the same topic below the threshold", () => {
    expect(hookSimilarity("Fresh coffee for your office team", "Why does fresh coffee taste flat after two weeks?")).toBeLessThan(HOOK_SIMILARITY_THRESHOLD);
    expect(hookSimilarity("Three grind sizes, three cups", "Meet the farmers behind our Ethiopian lot")).toBeLessThan(0.2);
  });

  it("is 0 for empty or stopword-only text", () => {
    expect(tokenJaccard("", "anything")).toBe(0);
    expect(hookSimilarity("the and of", "the and of")).toBe(0);
  });
});

describe("dates", () => {
  it("ageInDays and refreshDue", () => {
    expect(ageInDays(daysAgo(10), now)).toBe(10);
    expect(ageInDays(new Date(now.getTime() + 86_400_000), now)).toBeNull();
    expect(ageInDays(null, now)).toBeNull();
    expect(refreshDue(daysAgo(200), now, 180)).toBe(true);
    expect(refreshDue(daysAgo(100), now, 180)).toBe(false);
    expect(refreshDue(daysAgo(999), now, 0)).toBe(false);
  });

  it("parsePostDate only accepts ISO dates", () => {
    expect(parsePostDate("2026-03-14")?.toISOString()).toBe("2026-03-14T00:00:00.000Z");
    expect(parsePostDate("2026-03-14T10:00:00Z")).not.toBeNull();
    expect(parsePostDate("3 weeks ago")).toBeNull();
    expect(parsePostDate(null)).toBeNull();
  });
});

describe("hookRepetition", () => {
  const hook = "Why does fresh coffee taste flat after two weeks?";
  const history: HistoryItem[] = [
    { id: "a", source: "approved", hook: "Fresh coffee tastes flat after two weeks. Here's why.", date: daysAgo(20) },
    { id: "b", source: "post", hook: "Why fresh coffee goes flat after two weeks", date: daysAgo(400), url: "https://example.com/p/9" },
    { id: "c", source: "draft", hook: "Meet the farmers behind our Ethiopian lot", date: daysAgo(400) },
  ];

  it("warns about the closest recent match only, once per variant", () => {
    const r = hookRepetition([{ hook }], history, { now, refreshAfterDays: 180 });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^Variant 1 hook is \d+% similar to approved generation "Fresh coffee tastes flat/);
    expect(r.maxSimilarity).toBeGreaterThanOrEqual(HOOK_SIMILARITY_THRESHOLD);
  });

  it("gives an evergreen hint for an old published piece instead of a warning", () => {
    const r = hookRepetition([{ hook }], history, { now, refreshAfterDays: 180 });
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/^Evergreen refresh: variant 1 revisits post "Why fresh coffee goes flat after two weeks" from \d{4}-\d{2}-\d{2} \(400 days ago/);
  });

  it("never treats a draft as published", () => {
    const r = hookRepetition([{ hook: "Meet the farmers behind our Ethiopian lot" }], history, { now, refreshAfterDays: 180 });
    expect(r.hints).toEqual([]);
    expect(r.warnings[0]).toMatch(/similar to saved draft/);
  });

  it("with refresh off, old published pieces are repeats again", () => {
    const old: HistoryItem[] = [history[1]];
    const r = hookRepetition([{ hook }], old, { now, refreshAfterDays: 0 });
    expect(r.hints).toEqual([]);
    expect(r.warnings[0]).toContain("https://example.com/p/9");
  });

  it("respects a custom threshold and skips empty hooks and duplicate history rows", () => {
    const close = "Why does fresh coffee taste flat after a month?";
    expect(hookRepetition([{ hook: close }], history, { now, threshold: 0.5 }).warnings).toHaveLength(1);
    expect(hookRepetition([{ hook: close }], history, { now, threshold: 0.99 }).warnings).toEqual([]);
    expect(hookRepetition([{ hook: "  " }], history, { now }).warnings).toEqual([]);
    const dup = hookRepetition([{ hook }], [history[0], history[0]], { now });
    expect(dup.warnings).toHaveLength(1);
  });
});
