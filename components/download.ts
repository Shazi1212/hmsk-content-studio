/** Client-side export: JSON and Markdown built from the result and downloaded via Blob URLs. */
import type { Brief, GenerationOutput, Variant } from "@/lib/types";
import { optionLabel } from "./brief";
import type { GenerateResponse } from "./types";

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function exportBaseName(brief: Brief): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${slugify(brief.brandSlug)}_${slugify(brief.platform)}_${slugify(brief.postType)}_${stamp}`;
}

export function downloadJson(result: GenerateResponse, brief: Brief, extra: { savedId?: string | null; brandName?: string }): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Content Studio",
    brand: extra.brandName ?? brief.brandSlug,
    savedId: extra.savedId ?? null,
    brief,
    provider: result.draft.provider,
    model: result.draft.model ?? null,
    output: result.draft.output,
    references: result.references,
    priorApproved: result.priorApproved,
    repetition: result.repetition,
    lint: result.lint ?? [],
    warnings: result.warnings ?? [],
    repaired: result.repaired ?? [],
    media: {
      audioUrl: result.draft.audioUrl ?? null,
      videoUrl: result.draft.videoUrl ?? null,
      imageUrl: result.draft.imageUrl ?? null,
    },
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${exportBaseName(brief)}.json`);
}

export function downloadMarkdown(result: GenerateResponse, brief: Brief, extra: { savedId?: string | null; brandName?: string }): void {
  const md = toMarkdown(result, brief, extra);
  downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), `${exportBaseName(brief)}.md`);
}

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function section(title: string, body: string | undefined | null, level = 3): string {
  if (!body || !body.trim()) return "";
  return `${"#".repeat(level)} ${title}\n\n${body.trim()}\n\n`;
}

function list(title: string, items: string[] | undefined, level = 3): string {
  if (!items || !items.length) return "";
  return `${"#".repeat(level)} ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}\n\n`;
}

export function variantToMarkdown(v: Variant, index: number, brief: Brief): string {
  const isSlides = ["carousel", "linkedin_document", "story_sequence"].includes(brief.postType);
  let out = `## Variant ${index + 1}${v.title ? `: ${v.title}` : ""}\n\n`;
  out += section("Hook" + (v.hookType ? ` (${v.hookType})` : ""), v.hook);
  out += section("Script", v.script);
  out += list("On-screen text", v.onScreenText);
  if (v.shots?.length) {
    out += `### ${isSlides ? "Slides" : "Shot list"}\n\n| # | Duration | Visual | Text | Audio |\n|---|---|---|---|---|\n`;
    for (const s of v.shots) {
      out += `| ${s.order} | ${mdEscapeCell(s.duration || "")} | ${mdEscapeCell(s.visual)} | ${mdEscapeCell(s.text || "")} | ${mdEscapeCell(s.audio || "")} |\n`;
    }
    out += "\n";
  }
  out += section("Caption", v.caption);
  if (v.hashtags?.length) out += `### Hashtags\n\n${v.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}\n\n`;
  out += section("CTA" + (v.ctaType ? ` (${v.ctaType})` : ""), v.cta);
  out += section("Thumbnail text", v.thumbnailText);
  out += section("Visual direction", v.visualDirection);
  out += section("Audio direction", v.audioDirection);
  out += section("Image prompt", v.imagePrompt);
  out += section("Video prompt", v.videoPrompt);
  out += section("Voice-over text", v.voiceoverText);
  out += section("Alternate language version", v.altVersion);
  return out;
}

export function toMarkdown(result: GenerateResponse, brief: Brief, extra: { savedId?: string | null; brandName?: string }): string {
  const o: GenerationOutput = result.draft.output;
  const brand = extra.brandName ?? brief.brandSlug;
  let md = `# ${brand} - ${optionLabel("postTypes", brief.postType)} for ${optionLabel("platforms", brief.platform)}\n\n`;
  md += `Generated ${new Date().toLocaleString()} with ${result.draft.provider}${result.draft.model ? ` / ${result.draft.model}` : ""}`;
  md += extra.savedId ? ` - saved as ${extra.savedId}\n\n` : " - not saved\n\n";

  md += "## Brief\n\n";
  const rows: Array<[string, string]> = [
    ["Goal", optionLabel("goals", brief.goal)],
    ["Pillar", brief.pillar],
    ["Hook type", optionLabel("hookTypes", brief.hookType)],
    ["Emotional driver", optionLabel("emotionalDrivers", brief.emotionalDriver)],
    ["Tone", optionLabel("tones", brief.tone)],
    ["Language", `${optionLabel("languages", brief.language)} / ${optionLabel("registers", brief.register)}`],
    ["Length", optionLabel("lengths", brief.length)],
    ["Visual style", optionLabel("visualStyles", brief.visualStyle)],
    ["Audience", brief.audience || "(brand default)"],
    ["Reference strategy", optionLabel("referenceStrategies", brief.referenceStrategy)],
  ];
  md += rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n") + "\n\n";
  if (brief.topic) md += `**Topic / brief:** ${brief.topic}\n\n`;
  if (brief.mustInclude) md += `**Must include:** ${brief.mustInclude}\n\n`;
  if (brief.mustAvoid) md += `**Must avoid:** ${brief.mustAvoid}\n\n`;
  if (brief.ctaOverride) md += `**CTA override:** ${brief.ctaOverride}\n\n`;

  md += "## Strategy\n\n";
  md += section("Angle", o.strategy.angle);
  md += section("Why it fits", o.strategy.whyItFits);
  md += section("Emotional driver", o.strategy.emotionalDriver);
  md += list("References used", o.strategy.referencesUsed);
  md += section("Repetition check", o.strategy.repetitionCheck);
  if (result.repetition.warnings.length) md += list(`Repetition warnings (max similarity ${(result.repetition.maxSimilarity * 100).toFixed(0)}%)`, result.repetition.warnings);
  const quality = [...(result.warnings ?? []), ...(result.lint ?? [])];
  if (quality.length) md += list("Quality lint (non-blocking, review before publishing)", quality);
  if (result.repaired?.length) md += section("Parser repairs", result.repaired.join(", "));

  o.variants.forEach((v, i) => {
    md += variantToMarkdown(v, i, brief);
  });

  md += `## Self-review\n\n**Score:** ${o.selfReview.score}/10\n\n`;
  md += list("Strengths", o.selfReview.strengths);
  md += list("Risks", o.selfReview.risks);
  md += section("Compliance check", o.selfReview.complianceCheck);

  const media: string[] = [];
  if (result.draft.imageUrl) media.push(`- Key visual: ${result.draft.imageUrl}`);
  if (result.draft.audioUrl) media.push(`- Voice-over: ${result.draft.audioUrl}`);
  if (result.draft.videoUrl) media.push(`- Video: ${result.draft.videoUrl}`);
  if (media.length) md += `## Media\n\n${media.join("\n")}\n\n`;
  return md;
}

export function hashtagsToText(tags: string[]): string {
  return tags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
}
