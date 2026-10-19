import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, scrubDeep, wellFormed } from "@/lib/text";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { redactSecrets, trimBaseUrl } from "@/lib/providers/config";
import { compareDefaultOrder, formatPromptReferences, promptLabel } from "@/lib/reference-kinds";
import { defaultAspectRatio, modelLabel, normalizeBrief, pickDefaultVoice, postTypesFor, providerLabel } from "@/components/brief";
import { hashtagsToText, slugify, toMarkdown } from "@/components/download";
import type { BrandOption, GenerateResponse } from "@/components/types";
import { brief, output } from "./fixtures";

afterEach(() => vi.unstubAllEnvs());

describe("text helpers", () => {
  it("clip never cuts an emoji in half", () => {
    const s = "ab😀cd";
    expect(clip(s, 3)).toBe("ab");
    expect(clip(s, 4)).toBe("ab😀");
    expect(clip("short", 10)).toBe("short");
  });

  it("wellFormed and scrubDeep replace lone surrogates", () => {
    const lone = "x\uD83D";
    expect(wellFormed(lone)).toBe("x�");
    const date = new Date(0);
    const out = scrubDeep({ a: [lone], b: { c: lone }, d: date, n: 1 });
    expect(out).toEqual({ a: ["x�"], b: { c: "x�" }, d: date, n: 1 });
    expect(out.d).toBe(date);
  });
});

describe("token encryption", () => {
  it("round-trips and rejects a tampered blob", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "test-only-key-0123456789abcdef");
    const blob = encryptSecret("platform-token");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(decryptSecret(blob)).toBe("platform-token");
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
    expect(() => decryptSecret("garbage")).toThrow(/unknown format/);
  });

  it("refuses to work without a secret", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => encryptSecret("x")).toThrow(/AUTH_SECRET/);
  });
});

describe("provider config helpers", () => {
  it("redacts configured secrets and key-like query params", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret-value-123");
    const out = redactSecrets("key test-secret-value-123 at https://x.example/?key=abcdef&x=1");
    expect(out).toBe("key [redacted] at https://x.example/?key=[redacted]&x=1");
  });

  it("trimBaseUrl", () => {
    expect(trimBaseUrl("http://localhost:1234/v1///")).toBe("http://localhost:1234/v1");
  });
});

describe("reference kinds", () => {
  it("orders product before logo, then by position", () => {
    const d = new Date(0);
    const list = [
      { kind: "logo", position: 0, createdAt: d },
      { kind: "product", position: 1, createdAt: d },
      { kind: "product", position: 0, createdAt: d },
    ].sort(compareDefaultOrder);
    expect(list.map((r) => `${r.kind}${r.position}`)).toEqual(["product0", "product1", "logo0"]);
  });

  it("formats labels for the prompt safely", () => {
    expect(promptLabel("a\nb\u0007  c")).toBe("a b c");
    expect(formatPromptReferences([{ kind: "product", label: "Bag." }, { kind: "logo", label: "" }])).toBe("product: Bag");
    expect(formatPromptReferences([])).toBe("none");
  });
});

describe("brief helpers", () => {
  const brands: BrandOption[] = [{ slug: "demo", name: "Demo", pillars: ["Pillar A"], languages: ["de"], platforms: ["instagram"] } as unknown as BrandOption];

  it("modelLabel and providerLabel", () => {
    expect(modelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(modelLabel("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelLabel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(modelLabel("custom-model")).toBe("custom-model");
    expect(providerLabel("anthropic", "Anthropic", "claude-haiku-4-5")).toBe("Claude Haiku 4.5 (Anthropic)");
  });

  it("normalizeBrief repairs invalid fields against the catalog and brand", () => {
    const b = normalizeBrief({ brandSlug: "missing", platform: "linkedin", postType: "reel_script", tone: "nonsense" as never }, brands, null);
    expect(b.brandSlug).toBe("demo");
    expect(postTypesFor("linkedin").some((p) => p.id === b.postType)).toBe(true);
    expect(b.postType).not.toBe("reel_script");
    expect(b.tone).toBe("brand_default");
    expect(b.pillar).toBe("Pillar A");
    expect(b.language).toBe("de");
  });

  it("defaultAspectRatio", () => {
    expect(defaultAspectRatio({ platform: "instagram", postType: "reel_script" })).toBe("9:16");
    expect(defaultAspectRatio({ platform: "youtube", postType: "talking_head" })).toBe("16:9");
    expect(defaultAspectRatio({ platform: "instagram", postType: "carousel" })).toBe("4:5");
    expect(defaultAspectRatio({ platform: "linkedin", postType: "linkedin_document" })).toBe("1:1");
  });

  it("pickDefaultVoice prefers calm voices in the brief language and skips personal clones", () => {
    const voices = [
      { voiceId: "1", name: "My personal clone (de)" },
      { voiceId: "2", name: "Energetic ads (de)" },
      { voiceId: "3", name: "Calm narrator (de)" },
      { voiceId: "4", name: "Calm narrator (en)" },
    ];
    expect(pickDefaultVoice(voices, "de")).toBe("3");
    expect(pickDefaultVoice(voices, "en")).toBe("4");
    expect(pickDefaultVoice([], "en")).toBe("");
  });
});

describe("download formatting", () => {
  it("hashtagsToText and slugify", () => {
    expect(hashtagsToText(["a", "#b"])).toBe("#a #b");
    expect(slugify("Northwind Café / Reel")).toBe("northwind-cafe-reel");
  });

  it("toMarkdown includes the hook and repetition warnings", () => {
    const result = {
      draft: { provider: "mock", model: null, output: output(), imageUrl: null, audioUrl: null, videoUrl: null },
      references: [],
      priorApproved: [],
      repetition: { warnings: ["Variant 1 hook is 0.50 similar"], maxSimilarity: 0.5 },
      lint: ["dash_replaced"],
    } as unknown as GenerateResponse;
    const md = toMarkdown(result, brief(), { brandName: "Demo" });
    expect(md).toContain("fresh coffee taste flat");
    expect(md).toContain("Variant 1 hook is 0.50 similar");
    expect(md).toContain("dash_replaced");
  });
});
