import { describe, expect, it } from "vitest";
import { lintOutput, parseGenerationOutput, type ParseOptions } from "@/lib/prompt";
import { parseLooseJson } from "@/lib/prompt/parse";
import { brief, output, variant } from "./fixtures";

const valid = JSON.stringify(output());

describe("parseGenerationOutput: syntax repairs", () => {
  it("parses a clean reply without repairs", () => {
    const r = parseGenerationOutput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toEqual([]);
      expect(r.output.variants[0].hook).toContain("fresh coffee");
    }
  });

  it("strips code fences and commentary around the object", () => {
    const r = parseGenerationOutput("Here you go:\n```json\n" + valid + "\n```\nHope it helps.");
    expect(r.ok).toBe(true);
  });

  it("repairs trailing commas, comments and unquoted keys", () => {
    const messy = `{strategy: {"angle": "A", "whyItFits": "B",}, // note
      "variants": [{"title": "T", "hook": "H", }], "selfReview": {"score": 6,},}`;
    const r = parseGenerationOutput(messy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repaired).toEqual(expect.arrayContaining(["trailing_commas", "comments_removed", "unquoted_keys"]));
  });

  it("closes truncated JSON", () => {
    const cut = valid.slice(0, valid.indexOf('"selfReview"') + 30);
    const r = parseGenerationOutput(cut);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repaired).toContain("closed_truncated_json");
  });

  it("unwraps {output: …} and wraps a bare variant", () => {
    const wrapped = parseGenerationOutput(JSON.stringify({ output: output() }));
    expect(wrapped.ok && wrapped.repaired).toContain("unwrapped_output");
    const bare = parseGenerationOutput(JSON.stringify({ strategy: { angle: "A", whyItFits: "B" }, hook: "Just a hook", title: "T" }));
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.repaired).toContain("root_wrapped_as_variant");
      expect(bare.output.variants).toHaveLength(1);
    }
  });

  it("coerces string hashtags, string shots and a string score", () => {
    const raw = {
      strategy: { angle: "A", whyItFits: "B" },
      variants: [{ title: "", hook: "Hook words here today", hashtags: "#a, #b #c", shots: "Shot one\nShot two" }],
      selfReview: { score: "8" },
    };
    const r = parseGenerationOutput(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.output.variants[0];
      expect(v.hashtags).toEqual(["a", "b", "c"]);
      expect(v.shots.map((s) => s.visual)).toEqual(["Shot one", "Shot two"]);
      expect(v.title).toBe("Hook words here today");
      expect(r.output.selfReview.score).toBe(8);
      expect(r.repaired).toEqual(expect.arrayContaining(["hashtags_split", "shots_split", "title_from_hook", "score_from_string"]));
    }
  });

  it("clamps the self-review score into 1..10", () => {
    const r = parseGenerationOutput(JSON.stringify(output(undefined, { selfReview: { score: 10, strengths: [], risks: [], complianceCheck: "" } })).replace('"score":10', '"score":42'));
    expect(r.ok && r.output.selfReview.score).toBe(10);
  });

  it("fails cleanly on empty, non-JSON and contract-breaking replies", () => {
    expect(parseGenerationOutput("").ok).toBe(false);
    const none = parseGenerationOutput("no json at all");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/No JSON object/);
    const empty = parseGenerationOutput(JSON.stringify({ strategy: { angle: "A", whyItFits: "B" }, variants: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/contract/);
  });
});

describe("parseGenerationOutput: normalisation", () => {
  const opts: ParseOptions = { brief: brief({ variants: "1" }) };

  it("dedupes and strips # from hashtags and trims to the platform maximum", () => {
    const tags = ["#coffee", "Coffee", "a", "b", "c", "d", "e", "f", "g", "h"];
    const r = parseGenerationOutput(JSON.stringify(output([variant({ hashtags: tags })])), opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.variants[0].hashtags[0]).toBe("coffee");
      expect(r.output.variants[0].hashtags).toHaveLength(8); // instagram max
      expect(r.warnings.some((w) => w.startsWith("hashtags_trimmed:"))).toBe(true);
    }
  });

  it("replaces long dashes and keeps number ranges as hyphens", () => {
    const r = parseGenerationOutput(JSON.stringify(output([variant({ caption: "Fresh — always. Ships in 2–4 days." })])), opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.variants[0].caption).toBe("Fresh, always. Ships in 2-4 days.");
      expect(r.warnings).toContain("dash_replaced");
    }
  });

  it("cleans the voice-over text for TTS", () => {
    const r = parseGenerationOutput(JSON.stringify(output([variant({ voiceoverText: "Hello [pause] (smiles) #coffee https://x.example" })])), opts);
    expect(r.ok && r.output.variants[0].voiceoverText).toBe("Hello Link in der Bio");
  });

  it("truncates extra variants to the requested count", () => {
    const r = parseGenerationOutput(JSON.stringify(output([variant(), variant({ hook: "Second" })])), opts);
    expect(r.ok && r.output.variants).toHaveLength(1);
    expect(r.ok && r.warnings).toContain("variants_truncated:2->1");
  });

  it("drops altVersion unless the language is de_en", () => {
    const r = parseGenerationOutput(JSON.stringify(output([variant({ altVersion: "Zweite Version" })])), opts);
    expect(r.ok && r.output.variants[0].altVersion).toBe("");
  });
});

describe("lintOutput", () => {
  it("returns nothing without a brief", () => {
    expect(lintOutput(output(), undefined)).toEqual([]);
  });

  it("flags forbidden strings from the brand rules", () => {
    const w = lintOutput(output([variant({ caption: "Our organic beans" })]), {
      brief: brief(),
      brandRules: { forbiddenTerms: ["organic"], claimTerms: [], claimSensitive: false },
    });
    expect(w).toContain("forbidden_string:organic (v1)");
  });

  it("flags claim-check terms case-insensitively and health terms only for claim-sensitive brands", () => {
    const v = variant({ caption: "This BOOSTS your morning and is a detox" });
    const plain = lintOutput(output([v]), { brief: brief(), brandRules: { forbiddenTerms: [], claimTerms: ["boosts"], claimSensitive: false } });
    expect(plain).toContain("claim_check:boosts (v1)");
    expect(plain.some((w) => w.startsWith("health_claim_term"))).toBe(false);
    const sensitive = lintOutput(output([v]), { brief: brief(), brandRules: { forbiddenTerms: [], claimTerms: [], claimSensitive: true } });
    expect(sensitive).toContain("health_claim_term:detox (v1)");
  });

  it("flags a hook that repeats five consecutive words of a prior hook", () => {
    const w = lintOutput(output([variant({ hook: "So here is why fresh coffee tastes flat" })]), {
      brief: brief(),
      priorHooks: ["Ever wondered why fresh coffee tastes flat after a week?"],
    });
    expect(w.some((x) => x.startsWith("hook_overlaps_prior:"))).toBe(true);
  });

  it("does not flag a hook that shares only four words", () => {
    const w = lintOutput(output([variant({ hook: "Why fresh coffee tastes great" })]), { brief: brief(), priorHooks: ["why fresh coffee tastes flat"] });
    expect(w.some((x) => x.startsWith("hook_overlaps_prior:"))).toBe(false);
  });

  it("checks mandatory sections, hashtag range, exclamation marks and LinkedIn first line", () => {
    const reel = lintOutput(output([variant({ script: "", hashtags: ["one"], hook: "Stop!" })]), { brief: brief() });
    expect(reel).toEqual(expect.arrayContaining(["missing:reel_script:script (v1)", "exclamation_in_hook (v1)"]));
    expect(reel.some((w) => w.startsWith("hashtags_out_of_range:1"))).toBe(true);
    const li = lintOutput(output([variant({ caption: "x".repeat(150), hashtags: ["a", "b", "c"] })]), { brief: brief({ platform: "linkedin", postType: "linkedin_text" }) });
    expect(li).toContain("linkedin_first_line_too_long:150 (v1)");
  });

  it("flags mixed du/Sie register in German", () => {
    const w = lintOutput(output([variant({ caption: "Kennst du das? Wir zeigen Ihnen den Weg." })]), { brief: brief({ language: "de" }) });
    expect(w).toContain("mixed_register (v1)");
  });

  it("flags reel shot durations outside the length band", () => {
    const shots = [{ order: 1, duration: "90 s", visual: "Long shot", text: "", audio: "" }];
    const w = lintOutput(output([variant({ shots })]), { brief: brief({ length: "short" }) });
    expect(w.some((x) => x.startsWith("shot_durations_off_band:90s"))).toBe(true);
  });
});

describe("parseLooseJson", () => {
  it("reads an array root and repairs it", () => {
    const r = parseLooseJson("```\n[{'hook': 'a'},]\n```", "[");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ hook: "a" }]);
  });

  it("heals a German opening quote closed by a straight quote", () => {
    const r = parseLooseJson('{"hook": "Er sagt: „Hallo", dann geht er."}');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { hook: string }).hook).toBe("Er sagt: „Hallo“, dann geht er.");
  });

  it("reports a missing root", () => {
    expect(parseLooseJson("nothing", "[").ok).toBe(false);
  });
});
