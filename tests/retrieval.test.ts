import { describe, expect, it } from "vitest";
import { canonicalHookType, generationLabel, platformFamily, priorVariants, repetitionReport, textSimilarity, tokenize } from "@/lib/retrieval";
import { generation, output, reference, variant } from "./fixtures";

describe("tokenize / textSimilarity", () => {
  it("drops stopwords, URLs and short tokens, keeps umlauts", () => {
    expect(tokenize("The Größe of a bag https://x.example is 250 g")).toEqual(["größe", "bag", "250"]);
    expect(tokenize(null)).toEqual([]);
  });

  it("is 1 for identical text and 0 for unrelated text", () => {
    expect(textSimilarity("fresh coffee every tuesday", "fresh coffee every tuesday")).toBe(1);
    expect(textSimilarity("fresh coffee every tuesday", "grinder settings for espresso")).toBe(0);
  });
});

describe("classifiers", () => {
  it("platformFamily", () => {
    expect(platformFamily("linkedin-showcase")).toBe("linkedin");
    expect(platformFamily("x")).toBe("text");
    expect(platformFamily("tiktok")).toBe("social");
  });

  it("canonicalHookType maps specific labels and ignores generic ones", () => {
    expect(canonicalHookType("Time-stamped scene")).toBe("time_stamped_scene");
    expect(canonicalHookType("how_to")).toBe("how_to");
    expect(canonicalHookType("Question")).toBe("");
    expect(canonicalHookType("auto")).toBe("");
  });

  it("priorVariants / generationLabel read saved generations", () => {
    const g = generation(output([variant({ hook: "Saved hook" })]));
    expect(priorVariants(g)[0].hook).toBe("Saved hook");
    expect(generationLabel(g)).toBe('"Saved hook" (2026-01-01)');
    const broken = generation({} as never, { outputText: "raw text", id: "gen_abcdef123456" });
    expect(priorVariants(broken)).toEqual([{ hook: "", caption: "raw text", hookType: "", title: "" }]);
    expect(generationLabel(broken)).toBe("#123456 (2026-01-01)");
  });
});

describe("repetitionReport", () => {
  // Fixtures are dated 2026-01-01; one month later nothing is old enough for an evergreen refresh.
  const now = new Date("2026-02-01T00:00:00Z");

  it("is clean when nothing overlaps", () => {
    expect(repetitionReport(output(), [], [], { now })).toEqual({ warnings: [], maxSimilarity: 0, hints: [] });
  });

  it("warns when a hook repeats an approved generation", () => {
    const prior = generation(output([variant({ hook: "Why does fresh coffee taste flat after two weeks?", caption: "Other caption" })]));
    const r = repetitionReport(output([variant({ caption: "Brand new caption text here" })]), [prior], [], { now });
    expect(r.warnings[0]).toMatch(/^Variant 1 hook is 100% similar to approved generation "Why does fresh coffee/);
    expect(r.maxSimilarity).toBe(1);
  });

  it("catches a reworded hook that shares no three-word run", () => {
    const prior = generation(output([variant({ hook: "Fresh coffee tastes flat after two weeks. Here's why.", caption: "x" })]));
    const r = repetitionReport(output([variant({ caption: "Brand new caption text here" })]), [prior], [], { now });
    expect(r.warnings.some((w) => w.startsWith("Variant 1 hook is"))).toBe(true);
  });

  it("warns when a reference hook is copied, with its link", () => {
    const ref = reference({ hook: "Why does fresh coffee taste flat after two weeks?", date: "2026-01-20" });
    const r = repetitionReport(output(), [], [ref], { now });
    expect(r.warnings[0]).toContain('similar to post "Why does fresh coffee');
    expect(r.warnings[0]).toContain("https://example.com/p/1");
  });

  it("checks saved drafts passed as extra history", () => {
    const r = repetitionReport(output(), [], [], {
      now,
      history: [{ id: "d1", source: "draft", hook: "Why fresh coffee tastes flat after two weeks", date: new Date("2026-01-30") }],
    });
    expect(r.warnings[0]).toMatch(/similar to saved draft/);
  });

  it("turns a match with an old published piece into an evergreen hint", () => {
    const prior = generation(output([variant({ hook: "Why does fresh coffee taste flat after two weeks?", caption: "Fresh caption" })]));
    const later = new Date("2026-09-01T00:00:00Z");
    const r = repetitionReport(output([variant({ caption: "Fresh caption" })]), [prior], [], { now: later, refreshAfterDays: 180 });
    expect(r.warnings).toEqual([]);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatch(/^Evergreen refresh: variant 1 revisits approved generation .* from 2026-01-01 \(243 days ago, 100% similar\)/);
    const off = repetitionReport(output([variant({ caption: "Fresh caption" })]), [prior], [], { now: later, refreshAfterDays: 0 });
    expect(off.hints).toEqual([]);
    expect(off.warnings.length).toBeGreaterThan(0);
  });

  it("warns about near-identical variants and duplicate hooks", () => {
    const r = repetitionReport(output([variant(), variant()]), [], [], { now });
    expect(r.warnings).toContain("Variants 1 and 2 have the same hook.");
    expect(r.warnings.some((w) => w.startsWith("Variants 1 and 2 are too similar"))).toBe(true);
  });
});
