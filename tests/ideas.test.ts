import { describe, expect, it } from "vitest";
import { lintIdeas, parseIdeas, snapFormat, snapPillar, unverifiedNumbers } from "@/lib/ideas/parse";
import { stripReasoning } from "@/lib/ideas/llm";
import type { Idea } from "@/lib/ideas/types";

const pillars = ["Brew guides (filter, espresso, cold brew)", "Origin stories (the farms we buy from)"];

const idea = (hook: string, extra: Partial<Idea> = {}): Idea => ({ hook, angle: "", format: "", pillar: "", hookType: "", why: "", flags: [], ...extra });

describe("parseIdeas", () => {
  it("reads an ideas list, snapping formats and pillars", () => {
    const text = JSON.stringify({
      ideas: [
        { hook: "Cold brew in 3 steps", format: "Carousel", pillar: "brew guides", angle: "A how-to" },
        { title: "Meet the farm in Huila", type: "reel", theme: "origin stories" },
        { hook: "x" },
      ],
    });
    const r = parseIdeas(text, { platform: "instagram", pillars });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ideas).toHaveLength(2);
      expect(r.ideas[0]).toMatchObject({ format: "carousel", pillar: pillars[0], angle: "A how-to" });
      expect(r.ideas[1]).toMatchObject({ hook: "Meet the farm in Huila", format: "reel_script", pillar: pillars[1] });
    }
  });

  it("accepts a bare array of strings and fails on no ideas", () => {
    const r = parseIdeas('["First idea here", "Second idea here"]', { platform: "instagram", pillars });
    expect(r.ok && r.ideas.map((i) => i.hook)).toEqual(["First idea here", "Second idea here"]);
    expect(parseIdeas("{}", { platform: "instagram", pillars }).ok).toBe(false);
  });
});

describe("snapFormat / snapPillar", () => {
  it("only returns formats valid for the platform", () => {
    expect(snapFormat("LinkedIn post", "linkedin")).toBe("linkedin_text");
    expect(snapFormat("story", "linkedin")).toBe("");
    expect(snapFormat("", "instagram")).toBe("");
  });

  it("needs at least half the words to match", () => {
    expect(snapPillar("origin", pillars)).toBe(pillars[1]);
    expect(snapPillar("pricing", pillars)).toBe("");
  });
});

describe("lintIdeas", () => {
  it("drops duplicates and near-copies of existing hooks, flags the rest", () => {
    const r = lintIdeas(
      [
        idea("Our organic beans are back!"),
        idea("Our organic beans are back!"),
        idea("Why fresh coffee tastes flat after two weeks"),
        idea("A brand new idea about grinders and 87 percent"),
      ],
      {
        brandSlug: "demo",
        brandRules: { forbiddenTerms: ["organic"], claimTerms: [], claimSensitive: false },
        existingHooks: ["Why fresh coffee tastes flat after two weeks"],
        factsText: "250 g bag: 12.90 EUR",
      },
    );
    expect(r.dropped).toBe(2);
    expect(r.ideas[0].flags).toEqual(expect.arrayContaining(["forbidden_string:organic", "exclamation_in_hook"]));
    expect(r.ideas[1].flags.some((f) => f.startsWith("unverified_number:87"))).toBe(true);
  });
});

describe("unverifiedNumbers", () => {
  it("ignores small counts, years, times and fractions, and known facts", () => {
    expect(unverifiedNumbers("3 steps at 20:30 Uhr in 2026, open 24/7, 12,90 EUR, 0,02 mg", "Price 12.90 EUR")).toEqual(["0,02"]);
  });
});

describe("stripReasoning", () => {
  it("removes think blocks, including an unterminated one", () => {
    expect(stripReasoning("<think>plan</think>Answer")).toBe("Answer");
    expect(stripReasoning("Answer<think>never closed")).toBe("Answer");
  });
});
