import { describe, expect, it } from "vitest";
import {
  briefJsonLine,
  buildPrompts,
  buildSystemPrompt,
  buildUserPrompt,
  countWords,
  estimateTokens,
  joinSystemPrompt,
  parseGenerationOutput,
  performanceBucket,
  summarizeGeneration,
  truncateWords,
} from "@/lib/prompt";
import { variationSeed } from "@/lib/prompt/user";
import { buildMockOutput, extractMockHints } from "@/lib/providers/text";
import { GenerationOutputSchema } from "@/lib/types";
import { brief, demoBrand, generation, output, reference, variant } from "./fixtures";

const today = "2026-10-19";

describe("system prompt", () => {
  it("is deterministic and splits into a stable brand part and a variable brief part", () => {
    const brand = demoBrand();
    const a = buildSystemPrompt(brand, brief());
    const b = buildSystemPrompt(brand, brief());
    expect(a).toEqual(b);
    expect(a.stable).toContain(brand.name);
    expect(a.stable).toContain(brand.guardrails);
    const other = buildSystemPrompt(brand, brief({ platform: "linkedin", postType: "linkedin_text" }));
    expect(other.stable).toBe(a.stable);
    expect(other.variable).not.toBe(a.variable);
    expect(joinSystemPrompt(a)).toContain(a.variable);
  });
});

describe("user prompt", () => {
  it("starts with the machine-readable brief line and never includes free text in it", () => {
    const b = brief({ topic: "Secret topic text" });
    const line = briefJsonLine(b);
    expect(line.startsWith("BRIEF_JSON: ")).toBe(true);
    expect(line).not.toContain("Secret topic text");
    const u = buildUserPrompt({ brand: demoBrand(), brief: b, references: [], priorApproved: [], today });
    expect(u.split("\n")[0]).toBe(line);
    expect(u).toContain(`Date: ${today}`);
  });

  it("is deterministic for hook types without a variation seed", () => {
    const input = { brand: demoBrand(), brief: brief({ hookType: "problem_question" }), references: [], priorApproved: [], today };
    expect(buildUserPrompt(input)).toBe(buildUserPrompt(input));
  });

  it("marks prior approved generations as DO NOT REPEAT and lists references", () => {
    const prior = generation(output([variant({ hook: "An old hook we used" })]));
    const ref = reference({ hook: "A reference hook", performanceLevel: "High" });
    const u = buildUserPrompt({ brand: demoBrand(), brief: brief(), references: [ref], priorApproved: [prior], today });
    expect(u).toContain("DO NOT REPEAT");
    expect(u).toContain("An old hook we used");
    expect(u).toContain("A reference hook");
  });

  it("buildPrompts returns a token estimate", () => {
    const p = buildPrompts({ brand: demoBrand(), brief: brief(), references: [], priorApproved: [], today });
    expect(p.tokens.total).toBe(p.tokens.system + p.tokens.user);
    expect(estimateTokens("abcd")).toBe(1);
    expect(countWords("  one two\nthree ")).toBe(3);
  });
});

describe("variationSeed", () => {
  it("only applies to scene hooks and never picks the used-up example times", () => {
    expect(variationSeed({ hookType: "problem_question", language: "en" })).toBeNull();
    let i = 0;
    // First draw lands on 9:12 (forbidden), so the loop must draw again.
    const seq = [0, (9 - 5) / 19 + 0.001, 12 / 60 + 0.001, (10 - 5) / 19 + 0.001, 30 / 60 + 0.001];
    const s = variationSeed({ hookType: "time_stamped_scene", language: "en" }, () => seq[i++ % seq.length]);
    expect(s).toContain("Monday, 10:30");
    expect(s).not.toContain("Monday, 9:12.");
  });
});

describe("prompt helpers", () => {
  it("truncateWords cuts at a sentence end or adds an ellipsis", () => {
    expect(truncateWords("One two three. Four five six.", 4)).toBe("One two three.");
    expect(truncateWords("One two. Three four five six.", 4)).toBe("One two. Three four …"); // stop too early in the cut
    expect(truncateWords("a b c d e f", 3)).toBe("a b c …");
    expect(truncateWords("short", 10)).toBe("short");
    expect(truncateWords(null, 3)).toBe("");
  });

  it("performanceBucket", () => {
    expect(performanceBucket("Exceptional")).toBe("exceptional");
    expect(performanceBucket("High (views) / Low (interaction)")).toBe("mixed");
    expect(performanceBucket("Typical-High")).toBe("high");
    expect(performanceBucket("Low-Typical")).toBe("low");
    expect(performanceBucket("typical")).toBe("typical");
    expect(performanceBucket("")).toBe("unknown");
  });

  it("summarizeGeneration falls back to outputText when the output is not structured", () => {
    const s = summarizeGeneration(generation({} as never, { outputText: "Plain text hook line" }));
    expect(s.hook).toBe("Plain text hook line");
    expect(s.hookType).toBe("-");
  });
});

describe("mock provider round trip (no network)", () => {
  it("reads the hints from the user prompt and produces a valid, parseable draft", () => {
    const b = brief({ variants: "2", language: "en", platform: "tiktok" });
    const user = buildUserPrompt({ brand: demoBrand(), brief: b, references: [], priorApproved: [], today });
    const hints = extractMockHints(user);
    expect(hints).toMatchObject({ brandSlug: b.brandSlug, platform: "tiktok", variants: 2, language: "en", brandName: demoBrand().name });
    const mock = buildMockOutput(hints);
    expect(GenerationOutputSchema.safeParse(mock).success).toBe(true);
    const parsed = parseGenerationOutput(JSON.stringify(mock), { brief: b });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.output.variants).toHaveLength(2);
  });
});
