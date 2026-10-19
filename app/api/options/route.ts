import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { OPTION_GROUPS } from "@/lib/types";
import { listVoices, providerStatus } from "@/lib/providers";
import { requireSession } from "@/lib/auth";
import { errorResponse } from "@/lib/pipeline";
import { kickScheduler } from "@/lib/scheduler";
import { productReferenceCounts } from "@/lib/references";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SKIP_PREFIXES = [
  "pains",
  "pain",
  "desires",
  "problems",
  "objections",
  "typical questions",
  "not the audience",
  "entry emotion",
  "fragmented",
  "engagement comes",
  "they respond",
];
const LABEL_PREFIX = /^(primary|secondary|tertiary|instagram|tiktok|linkedin|youtube|facebook|website|social)\b[^:]*:\s*/i;
/** A chunk only counts as a persona when it names a group of people / organisations. */
const PERSONA_WORDS =
  /\b(adults?|owners?|operators?|teams?|directors?|leads?|managers?|founders?|peers|clients?|customers?|recruiters?|colleagues?|network|people|users?|professionals?|decision[- ]makers?|gym-goers|students?|learners?|buyers?|agencies|smes?|mittelstand|schools?|companies|firms?|entrepreneurs?|groups?|employees?|staff|parents?|men|women|creators?|followers?|community|diaspora|generation|executives?|ceos?|cfos?|coos?|heads?|freelancers?|consultants?|engineers?|developers?|marketers?|retailers?|brands?|startups?|businesses)\b/i;
const MAX_LABEL = 72;

function truncate(s: string, n = MAX_LABEL): string {
  const t = s.replace(/\s+/g, " ").trim().replace(/[.;,:]+$/, "");
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${(at > 30 ? cut.slice(0, at) : cut).replace(/[,;(]+$/, "")}…`;
}

/** Splits on commas/semicolons that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}

/** Up to 5 short persona labels parsed from the first sentences of Brand.audience (keep simple). */
function audienceSuggestions(audience: string): string[] {
  const sentences = audience
    .split(/(?<=\.)\s+(?=[A-ZÄÖÜ(])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  const push = (s: string): boolean => {
    const t = truncate(s.replace(/^(?:plus|and|also|or)\s+/i, ""));
    if (t.length < 8 || !PERSONA_WORDS.test(t.replace(/\([^)]*\)/g, ""))) return false;
    if (out.some((o) => o.toLowerCase() === t.toLowerCase())) return false;
    out.push(t);
    return true;
  };
  const pushParts = (text: string, max: number) => {
    let added = 0;
    for (const part of splitTopLevel(text).flatMap((x) => x.split(/\s+and\s+(?=[a-z])/))) {
      if (out.length >= 5 || added >= max) break;
      if (part.trim().length >= 12 && part.trim().length <= MAX_LABEL && push(part)) added++;
    }
    return added;
  };
  for (const raw of sentences) {
    if (out.length >= 5) break;
    const s = raw.replace(LABEL_PREFIX, "").trim();
    const lower = s.toLowerCase();
    if (SKIP_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (s.length <= MAX_LABEL && push(s)) continue;
    // Long sentence: keep the noun phrase before the first qualifier, then mine the remainder for more groups.
    const m = s.match(/^(.{20,}?)\s(?:who|with|in|around|reached|that)\s(.*)$/);
    if (m && push(m[1])) {
      pushParts(m[2], 2);
      continue;
    }
    // Persona lists ("peers in data/AI, potential clients (…), recruiters (…), colleagues").
    if (pushParts(s, 3) === 0) push(s);
  }
  if (out.length === 0 && sentences.length) out.push(truncate(sentences[0].replace(LABEL_PREFIX, "")));
  return out.slice(0, 5);
}

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  void kickScheduler(); // catch-up for the weekly jobs when this process missed its timer (restart, idle)
  try {
    const brands = await prisma.brand.findMany({
      orderBy: { createdAt: "asc" },
      select: { slug: true, name: true, tagline: true, pillars: true, platforms: true, languages: true, audience: true, bannedPhrases: true, aiPhraseCheck: true },
    });
    const providers = providerStatus();
    const productPhotos = await productReferenceCounts(brands.map((b) => b.slug));

    let elevenlabsVoices: { voiceId: string; name: string }[] | undefined;
    if (providers.audio.elevenlabs.configured) {
      try {
        elevenlabsVoices = await listVoices();
      } catch (err) {
        console.warn("[api/options] ElevenLabs voice list unavailable:", err instanceof Error ? err.message : err);
        elevenlabsVoices = [];
      }
    }

    return NextResponse.json({
      brands: brands.map((b) => ({
        slug: b.slug,
        name: b.name,
        tagline: b.tagline,
        pillars: b.pillars,
        platforms: b.platforms,
        languages: b.languages,
        audienceSuggestions: audienceSuggestions(b.audience),
        // How many default product / packaging reference images key visuals and video start frames use (0 = none), counting
        // built-in website images that are not imported yet; nothing is fetched here. The URLs stay server-side.
        productReferenceCount: productPhotos[b.slug] ?? 0,
        // Language safety settings, so drafts reopened from history are checked the same way as fresh ones.
        bannedPhrases: b.bannedPhrases,
        aiPhraseCheck: b.aiPhraseCheck,
      })),
      options: OPTION_GROUPS,
      providers,
      ...(elevenlabsVoices !== undefined ? { elevenlabsVoices } : {}),
    });
  } catch (err) {
    return errorResponse(err, "api/options");
  }
}
