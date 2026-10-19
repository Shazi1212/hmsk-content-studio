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
  it("is clean when nothing overlaps", () => {
    const r = repetitionReport(output(), [], []);
    expect(r).toEqual({ warnings: [], maxSimilarity: 0 });
  });

  it("warns when a hook repeats an approved generation", () => {
    const prior = generation(output([variant({ hook: "Why does fresh coffee taste flat after two weeks?", caption: "Other caption" })]));
    const r = repetitionReport(output([variant({ caption: "Brand new caption text here" })]), [prior], []);
    expect(r.warnings.some((w) => w.startsWith("Variant 1 hook is 1.00 similar to approved generation"))).toBe(true);
    expect(r.maxSimilarity).toBe(1);
  });

  it("warns when a reference hook is copied", () => {
    const ref = reference({ hook: "Why does fresh coffee taste flat after two weeks?" });
    const r = repetitionReport(output(), [], [ref]);
    expect(r.warnings.some((w) => w.includes("similar to reference post"))).toBe(true);
  });

  it("warns about near-identical variants and duplicate hooks", () => {
    const r = repetitionReport(output([variant(), variant()]), [], []);
    expect(r.warnings).toContain("Variants 1 and 2 have the same hook.");
    expect(r.warnings.some((w) => w.startsWith("Variants 1 and 2 are too similar"))).toBe(true);
  });
});
