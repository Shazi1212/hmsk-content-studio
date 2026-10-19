import { describe, expect, it } from "vitest";
import {
  checkLanguageSafety,
  containsPhrase,
  countEmoji,
  DEFAULT_AI_PHRASES,
  detectLanguage,
  segments,
  variantHashtags,
  type LanguageSafetyOptions,
} from "@/lib/language-safety";
import { output, variant } from "./fixtures";

const en: LanguageSafetyOptions = { language: "en", platform: "instagram", postType: "reel_script" };
const de: LanguageSafetyOptions = { ...en, language: "de" };

/** A German variant with every reader field in German. */
const germanVariant = variant({
  hook: "Warum schmeckt frischer Kaffee nach zwei Wochen flach?",
  script: "Wir rösten jeden Dienstag. Das ist der Grund, warum die Bohnen bei dir frisch ankommen.",
  caption: "Das Röstdatum ist wichtiger als das Etikett. Bestell die Röstung dieser Woche.",
  onScreenText: ["Röstdatum zählt"],
  cta: "Bestell die Röstung dieser Woche",
  thumbnailText: "Röstdatum",
  voiceoverText: "Wir rösten jeden Dienstag und schicken die Bohnen am selben Tag los.",
});

describe("detectLanguage", () => {
  it("recognises clear English and German sentences", () => {
    expect(detectLanguage("This is why the beans are fresh when they arrive")).toBe("en");
    expect(detectLanguage("Das ist der Grund, warum die Bohnen frisch sind")).toBe("de");
  });

  it("stays unknown for short or ambiguous text and loan words", () => {
    expect(detectLanguage("Roast date")).toBe("unknown");
    expect(detectLanguage("Workflow Meeting Call Update")).toBe("unknown");
    expect(detectLanguage("Unser Meeting-Workflow für das Team ist jetzt live")).toBe("de");
  });

  it("ignores hashtags, handles and URLs", () => {
    expect(detectLanguage("#the #and #is #with @you https://the.example/and")).toBe("unknown");
  });
});

describe("segments", () => {
  it("splits on line breaks and sentence ends and drops hashtag lines", () => {
    expect(segments("One sentence here. Two sentence here.\n#tag #more\nThird line")).toEqual(["One sentence here.", "Two sentence here.", "Third line"]);
  });
});

describe("mixed language", () => {
  it("is clean for a consistently German draft", () => {
    expect(checkLanguageSafety(output([germanVariant]), de)).toEqual([]);
  });

  it("flags English sentences in a German caption", () => {
    const v = { ...germanVariant, caption: `${germanVariant.caption}\nThis is why you should order it now.` };
    const w = checkLanguageSafety(output([v]), de);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^mixed_language:caption has 1 English sentence in a German draft: "This is why you should order it now\." \(v1\)$/);
  });

  it("flags German sentences in an English draft", () => {
    const v = variant({ script: "We roast on Tuesdays. Das ist der Grund, warum die Bohnen frisch sind." });
    expect(checkLanguageSafety(output([v]), en)[0]).toMatch(/^mixed_language:script has 1 German sentence in an? English draft/);
  });

  it("never checks the English model prompts", () => {
    const v = { ...germanVariant, imagePrompt: "This is a photo of the beans on the counter", videoPrompt: "Slow push-in on the beans with steam" };
    expect(checkLanguageSafety(output([v]), de)).toEqual([]);
  });

  it("checks altVersion as English for de_en", () => {
    const good = { ...germanVariant, altVersion: "This is why the beans are fresh when they arrive at your door." };
    expect(checkLanguageSafety(output([good]), { ...de, language: "de_en" })).toEqual([]);
    const bad = { ...germanVariant, altVersion: "Das ist der Grund, warum die Bohnen frisch sind." };
    expect(checkLanguageSafety(output([bad]), { ...de, language: "de_en" })[0]).toMatch(/^mixed_language:altVersion has 1 German sentence/);
  });
});

describe("banned and AI-sounding phrases", () => {
  it("containsPhrase matches whole words, case-insensitively, across whitespace and apostrophe styles", () => {
    expect(containsPhrase("A real GAME-CHANGER for you", "game-changer")).toBe(true);
    expect(containsPhrase("In today’s   fast-paced world", "in today's fast-paced world")).toBe(true);
    expect(containsPhrase("unleashed", "unleash")).toBe(false);
    expect(containsPhrase("anything", "")).toBe(false);
  });

  it("brand banned phrases are empty by default and flagged when set", () => {
    const v = variant({ caption: "Limited offer: order now while stocks last." });
    expect(checkLanguageSafety(output([v]), en)).toEqual([]);
    expect(checkLanguageSafety(output([v]), { ...en, bannedPhrases: ["Limited offer", " "] })).toEqual(['banned_phrase:"Limited offer" (v1)']);
  });

  it("flags default AI phrases per language and can be switched off", () => {
    const v = variant({ caption: "This roast is a game-changer. Let's dive in." });
    expect(checkLanguageSafety(output([v]), en)).toEqual(['ai_phrase:"game-changer" (v1)', 'ai_phrase:"let\'s dive in" (v1)']);
    expect(checkLanguageSafety(output([v]), { ...en, aiPhraseCheck: false })).toEqual([]);
    const g = { ...germanVariant, caption: "In der heutigen schnelllebigen Welt zählt jede Minute. Das ist nahtlos." };
    expect(checkLanguageSafety(output([g]), de)).toEqual(['ai_phrase:"in der heutigen schnelllebigen welt" (v1)', 'ai_phrase:"nahtlos" (v1)']);
  });

  it("custom AI lists replace the defaults", () => {
    const v = variant({ caption: "Pure synergy." });
    expect(checkLanguageSafety(output([v]), { ...en, aiPhrases: { en: ["synergy"] } })).toEqual(['ai_phrase:"synergy" (v1)']);
  });

  it("default lists are non-empty and lowercase-safe", () => {
    expect(DEFAULT_AI_PHRASES.en.length).toBeGreaterThan(10);
    expect(DEFAULT_AI_PHRASES.de.length).toBeGreaterThan(10);
  });
});

describe("hashtag and emoji limits", () => {
  it("counts list and inline caption hashtags once each", () => {
    expect(variantHashtags({ hashtags: ["coffee", "Beans"], caption: "Fresh #coffee and #beans and #roast, not a#tag or &#39;" })).toEqual(["coffee", "Beans", "roast"]);
  });

  it("warns when the posted text has more hashtags than the platform allows", () => {
    const v = variant({ caption: "Fresh beans #a #b #c #d", hashtags: ["e", "f", "g", "h", "i"] });
    expect(checkLanguageSafety(output([v]), en)).toEqual(["hashtag_limit:9 hashtags, instagram limit 8 (v1)"]);
    expect(checkLanguageSafety(output([v]), { ...en, maxHashtags: 20 })).toEqual([]);
  });

  it("any hashtag is over the limit for ad creatives", () => {
    const v = variant({ hashtags: ["coffee"] });
    expect(checkLanguageSafety(output([v]), { ...en, postType: "ad_creative" })).toEqual(["hashtag_limit:1 hashtags, instagram limit 0 (v1)"]);
  });

  it("counts emoji including ZWJ sequences and flags once, and applies the platform limit", () => {
    expect(countEmoji("☕️ 👩‍💻 🇩🇪 © 123")).toBe(3);
    const v = variant({ hook: "☕ Fresh", caption: "🔥🔥 Beans 🚀" });
    expect(checkLanguageSafety(output([v]), { ...en, platform: "linkedin", postType: "linkedin_text", maxHashtags: 10 })).toEqual(["emoji_limit:4 emoji, linkedin limit 3 (v1)"]);
    expect(checkLanguageSafety(output([v]), en)).toEqual([]);
  });

  it("tags findings with the variant number", () => {
    const w = checkLanguageSafety(output([variant(), variant({ caption: "A true game-changer" })]), en);
    expect(w).toEqual(['ai_phrase:"game-changer" (v2)']);
  });
});
