/*
 * Maps one row of a reference-post file (the column names of a research spreadsheet export: "Platform", "Post URL", "Hook",
 * "Content Pillar", "Performance Level", ...) to a ReferencePost record. Used by prisma/seed.ts and prisma/import-references.ts.
 * Unknown columns are kept in `raw`; every column except Platform, Post URL and Hook is optional.
 */
import type { Prisma } from "@prisma/client";

export function normPlatform(p: string): string {
  const s = (p || "").toLowerCase();
  if (s.startsWith("instagram")) return "instagram";
  if (s.startsWith("tiktok")) return "tiktok";
  if (s.includes("showcase")) return "linkedin-showcase";
  if (s.includes("company")) return "linkedin-company";
  if (s.includes("founder")) return "linkedin-founder";
  if (s.includes("personal")) return "linkedin-personal";
  if (s.startsWith("linkedin")) return "linkedin";
  return s || "unknown";
}
export const str = (v: unknown) => (v === undefined || v === null ? null : String(v));

export function referenceRow(r: Record<string, unknown>, brandId: string, source: string): Prisma.ReferencePostUncheckedCreateInput {
  const platform = normPlatform(String(r["Platform"] ?? ""));
  const hook = str(r["Hook"]) ?? "";
  const postUrl = String(r["Post URL"] ?? "");
  const searchText = [r["Hook"], r["Topic"], r["Main Message"], r["Caption Structure"], r["CTA"], r["Content Pillar"], r["Observations"]]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
  const data = {
    brandId,
    platform,
    postUrl,
    date: str(r["Date"]),
    format: str(r["Format"]),
    pillar: str(r["Content Pillar"]),
    topic: str(r["Topic"]),
    product: str(r["Product / Service"]),
    hook,
    hookType: str(r["Hook Type"]),
    mainMessage: str(r["Main Message"]),
    visualConcept: str(r["Visual Concept"]),
    visualStyle: str(r["Visual Style"]),
    colors: str(r["Colors"]),
    typography: str(r["Typography"]),
    people: str(r["People"]),
    productPlacement: str(r["Product Placement"]),
    captionStyle: str(r["Caption Style"]),
    captionStructure: str(r["Caption Structure"]),
    cta: str(r["CTA"]),
    ctaType: str(r["CTA Type"]),
    views: str(r["Views"]),
    likes: str(r["Likes"] ?? r["Likes (reactions)"]),
    comments: str(r["Comments"]),
    shares: str(r["Shares"] ?? r["Shares (reposts)"]),
    saves: str(r["Saves"]),
    engagementIndicators: str(r["Engagement Indicators"]),
    performanceLevel: str(r["Performance Level"]),
    performanceEvidence: str(r["Performance Evidence"]),
    audienceReaction: str(r["Audience Reaction"]),
    trendReference: str(r["Trend / Reference"]),
    storytelling: str(r["Storytelling"]),
    emotionalDriver: str(r["Emotional Driver"]),
    contentMechanism: str(r["Content Mechanism"]),
    replicability: str(r["Replicability"]),
    observations: str(r["Observations"]),
    confidence: str(r["Confidence"]),
    sourceEvidence: str(r["Source Evidence"]),
    source,
    searchText,
    raw: r as Prisma.InputJsonObject,
  };
  return data;
}
