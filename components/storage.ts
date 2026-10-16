/** localStorage persistence for per-browser conveniences (last brief, drawer filters). Always guarded. */
import type { Brief } from "@/lib/types";

const BRIEF_KEY = "content-studio.lastBrief.v1";
// Set once the "Claude Haiku 4.5 / GPT-6 Luna first" provider default has been applied to this browser (see loadStoredBrief).
const PROVIDER_DEFAULT_KEY = "content-studio.providerDefault.v2";
const HISTORY_FILTER_KEY = "content-studio.historyFilter.v1";

export function loadStoredBrief(): Partial<Brief> | null {
  try {
    const raw = window.localStorage.getItem(BRIEF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const brief = parsed as Partial<Brief>;
    // One-time reset: a provider saved before Claude Haiku 4.5 / GPT-6 Luna became the defaults was an automatic pick
    // (the first configured one), so drop it once and let the new default apply. Later choices persist as usual.
    if (!window.localStorage.getItem(PROVIDER_DEFAULT_KEY)) {
      delete brief.textProvider;
      window.localStorage.setItem(PROVIDER_DEFAULT_KEY, "1");
    }
    return brief;
  } catch {
    return null;
  }
}

export function saveStoredBrief(brief: Brief): void {
  try {
    window.localStorage.setItem(BRIEF_KEY, JSON.stringify(brief));
    window.localStorage.setItem(PROVIDER_DEFAULT_KEY, "1");
  } catch {
    /* private mode or quota: ignore */
  }
}

export type HistoryFilter = { brandSlug: string; status: string };

export function loadHistoryFilter(): HistoryFilter | null {
  try {
    const raw = window.localStorage.getItem(HISTORY_FILTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HistoryFilter>;
    return { brandSlug: typeof parsed.brandSlug === "string" ? parsed.brandSlug : "", status: typeof parsed.status === "string" ? parsed.status : "" };
  } catch {
    return null;
  }
}

export function saveHistoryFilter(filter: HistoryFilter): void {
  try {
    window.localStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify(filter));
  } catch {
    /* ignore */
  }
}
