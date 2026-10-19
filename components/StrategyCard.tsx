"use client";

import type { GenerationOutput } from "@/lib/types";
import type { PriorSummary, ReferenceSummary, Repetition } from "./types";

function perfClass(level: string | null | undefined): string {
  const l = (level ?? "").toLowerCase();
  if (l.startsWith("exceptional") || l.startsWith("high")) return "border-success/40 text-success";
  if (l.startsWith("low")) return "border-danger/40 text-danger";
  return "border-subtle text-muted";
}

/** Lint codes that must not be approved without a second look (see ContentStudio.persist). */
export const CRITICAL_LINT = /^(health_claim_term|forbidden_string|compliance_unfixed)\b/;

const LINT_LABELS: Array<[RegExp, string]> = [
  [/^health_claim_term/, "Compliance"],
  [/^forbidden_string/, "Compliance"],
  [/^claim_check/, "Claim check"],
  [/^compliance_fixed/, "Compliance fixed"],
  [/^language_fixed/, "Language fixed"],
  [/^language_unfixed/, "Language"],
  [/^format_fixed/, "Format fixed"],
  [/^format_unfixed/, "Format"],
  [/^compliance_unfixed/, "Compliance"],
  [/^compliance_review_failed/, "Compliance review"],
  [/^mixed_register/, "Register"],
  [/^missing:/, "Missing section"],
  [/^hashtags_(out_of_range|trimmed)/, "Hashtags"],
  [/^linkedin_first_line_too_long/, "LinkedIn hook"],
  [/^shot_durations_off_band/, "Timing"],
  [/^exclamation_in_hook/, "Hook"],
  [/^hook_overlaps_prior/, "Repetition"],
  [/^score_too_high/, "Self-review"],
  [/^variants_truncated/, "Variants"],
  [/^dash_replaced/, "Typography"],
  [/^truncated_output/, "Truncated"],
  [/^retried_/, "Retry"],
];

const SAFETY_LABELS: Array<[RegExp, string]> = [
  [/^mixed_language/, "Language"],
  [/^banned_phrase/, "Banned phrase"],
  [/^ai_phrase/, "AI phrase"],
  [/^hashtag_limit/, "Hashtags"],
  [/^emoji_limit/, "Emoji"],
];

/** Chip label and readable text of a language safety warning (`code:detail (vN)` → label + `detail (vN)`). */
function safetyParts(w: string): { label: string; text: string } {
  const label = SAFETY_LABELS.find(([re]) => re.test(w))?.[1] ?? "Language";
  return { label, text: w.replace(/^[a-z_]+:/, "") };
}

function lintLabel(code: string): string {
  for (const [re, label] of LINT_LABELS) if (re.test(code)) return label;
  return "Format";
}

export function StrategyCard({
  strategy,
  references,
  priorApproved,
  repetition,
  retrievalNotes = [],
  lint = [],
  safety = [],
  warnings = [],
  repaired = [],
}: {
  strategy: GenerationOutput["strategy"];
  references: ReferenceSummary[];
  priorApproved: PriorSummary[];
  repetition: Repetition;
  retrievalNotes?: string[];
  lint?: string[];
  safety?: string[];
  warnings?: string[];
  repaired?: string[];
}) {
  const simPct = Math.round((repetition.maxSimilarity || 0) * 100);
  const hasWarnings = repetition.warnings.length > 0;
  const hints = repetition.hints ?? [];
  const quality = [...warnings, ...lint];
  const criticalCount = lint.filter((w) => CRITICAL_LINT.test(w)).length;

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="eyebrow">Strategy</div>
        {strategy.emotionalDriver ? (
          <span className="rounded-full border border-subtle px-2 py-0.5 text-[11px] text-muted">Driver: {strategy.emotionalDriver}</span>
        ) : null}
      </div>
      <h2 className="text-lg font-semibold leading-snug tracking-tight">{strategy.angle}</h2>
      {strategy.whyItFits ? <p className="mt-2 text-sm leading-relaxed text-paper/80">{strategy.whyItFits}</p> : null}

      {strategy.referencesUsed.length ? (
        <div className="mt-4">
          <div className="eyebrow mb-1.5">What informed it</div>
          <ul className="grid gap-1 text-sm text-paper/80">
            {strategy.referencesUsed.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-gold-ink" aria-hidden="true">
                  •
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {strategy.repetitionCheck ? (
        <div className="mt-4">
          <div className="eyebrow mb-1.5">Deliberately avoided</div>
          <p className="text-sm text-paper/80">{strategy.repetitionCheck}</p>
        </div>
      ) : null}

      <div className={`mt-4 rounded-lg border px-3 py-2.5 ${hasWarnings ? "border-warn/50 bg-warn/10" : "border-subtle bg-ink"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">
            Repetition check: {hasWarnings ? `${repetition.warnings.length} warning${repetition.warnings.length > 1 ? "s" : ""}` : "no overlap with recent posts and drafts"}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>max similarity</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle">
              <span className={`block h-full ${simPct > 35 ? "bg-warn" : "bg-success"}`} style={{ width: `${Math.min(100, simPct)}%` }} />
            </span>
            <span className="tabular-nums">{simPct}%</span>
          </div>
        </div>
        {hasWarnings ? (
          <ul className="mt-2 grid gap-1 text-xs text-paper/85">
            {repetition.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        ) : null}
        {hints.length ? (
          <ul className="mt-2 grid gap-1 text-xs text-paper/85">
            {hints.map((h, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-px shrink-0 rounded-full border border-success/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-success">Evergreen</span>
                <span className="min-w-0 break-words">{h.replace(/^Evergreen refresh: (.)/, (_m, c: string) => c.toUpperCase())}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {quality.length || repaired.length ? (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 ${quality.length ? "border-warn/50 bg-warn/10" : "border-subtle bg-ink"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              Quality lint: {quality.length ? `${quality.length} finding${quality.length > 1 ? "s" : ""}` : "clean"}
              {criticalCount ? <span className="ml-2 rounded-full border border-danger/50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-danger">{criticalCount} compliance</span> : null}
            </div>
            <span className="text-[11px] text-muted">non-blocking · review before approving</span>
          </div>
          {quality.length ? (
            <ul className="mt-2 grid gap-1 text-xs text-paper/85">
              {quality.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className={`mt-px shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${CRITICAL_LINT.test(w) ? "border-danger/50 text-danger" : "border-subtle text-muted"}`}>
                    {lintLabel(w)}
                  </span>
                  <span className="min-w-0 break-words">{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {repaired.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted hover:text-paper">Parser repairs ({repaired.length})</summary>
              <p className="mt-1 text-[11px] text-muted">{repaired.join(", ")}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className={`mt-3 rounded-lg border px-3 py-2.5 ${safety.length ? "border-warn/50 bg-warn/10" : "border-subtle bg-ink"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">
            Language safety: {safety.length ? `${safety.length} warning${safety.length > 1 ? "s" : ""}` : "clean"}
          </div>
          <span className="text-[11px] text-muted">language mix · phrases · hashtags · emoji · never blocks</span>
        </div>
        {safety.length ? (
          <ul className="mt-2 grid gap-1 text-xs text-paper/85">
            {safety.map((w, i) => {
              const { label, text } = safetyParts(w);
              return (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-px shrink-0 rounded-full border border-subtle px-1.5 py-px text-[10px] uppercase tracking-wide text-muted">{label}</span>
                  <span className="min-w-0 break-words">{text}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {references.length || priorApproved.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {references.length ? (
            <div>
              <div className="eyebrow mb-1.5">Reference posts shown to the model ({references.length})</div>
              <ul className="grid gap-1.5">
                {references.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 text-xs">
                    <span className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${perfClass(r.performanceLevel)}`}>
                      {(r.performanceLevel || "n/a").split(" ")[0]}
                    </span>
                    <span className="min-w-0">
                      <span className="text-muted">{r.platform}</span>{" "}
                      {r.postUrl ? (
                        <a href={r.postUrl} target="_blank" rel="noreferrer noopener" className="text-paper/85 underline decoration-subtle underline-offset-2 hover:decoration-gold">
                          {truncate(r.hook || r.postUrl, 90)}
                        </a>
                      ) : (
                        <span className="text-paper/85">{truncate(r.hook || "(no hook)", 90)}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {priorApproved.length ? (
            <div>
              <div className="eyebrow mb-1.5">Approved generations avoided ({priorApproved.length})</div>
              <ul className="grid gap-1.5">
                {priorApproved.map((p) => (
                  <li key={p.id} className="text-xs text-paper/80">
                    <span className="text-muted">{formatDate(p.createdAt)}</span> {truncate(p.hook || "(no hook)", 90)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {retrievalNotes.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted hover:text-paper">How references were selected</summary>
          <ul className="mt-1.5 grid gap-1 text-[11px] text-muted">
            {retrievalNotes.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** "12,345 in / 3,210 out tokens (8,000 cached)"; "" when the provider reported no usage (older rows, some local servers). */
export function formatTokens(input: number | null | undefined, output: number | null | undefined, cacheRead?: number | null): string {
  if (typeof input !== "number" && typeof output !== "number") return "";
  const n = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString("en-US") : "?");
  const cached = typeof cacheRead === "number" && cacheRead > 0 ? ` (${n(cacheRead)} cached)` : "";
  return `${n(input)} in / ${n(output)} out tokens${cached}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}
