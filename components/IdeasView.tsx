"use client";

import { useEffect, useMemo, useState } from "react";
import { OPTION_GROUPS } from "@/lib/types";
import {
  CRITICAL_IDEA_FLAG,
  IDEA_COUNT_DEFAULT,
  type Idea,
  type IdeaBatchDTO,
  type IdeasParams,
  type IdeasResponse,
  type IdeasStatus,
} from "@/lib/ideas/types";
import { ApiError, api, toApiError } from "./api";
import { brandPlatformIds, optionLabel } from "./brief";
import type { BrandOption } from "./types";
import { CopyButton } from "./ui/CopyButton";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Field, Fieldset, Select, Spinner, TextArea, type SelectOption } from "./ui/Field";

/** What "Use in Create" needs besides the idea itself: the settings of the batch it came from. */
export type IdeaOrigin = { brandSlug: string; platform: string; pillar: string; goal: string; language: "de" | "en" };

const COUNT_OPTIONS: SelectOption[] = [5, 8, 10, 12].map((n) => ({ id: String(n), label: `${n} ideas` }));
const LANGUAGE_OPTIONS: SelectOption[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
];
const GOAL_OPTIONS: SelectOption[] = [{ id: "any", label: "Mixed goals" }, ...OPTION_GROUPS.goals.map((g) => ({ id: g.id, label: g.label }))];

const formatLabel = (id: string): string => optionLabel("postTypes", id).split(" — ")[0];

const dateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
};

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function flagLabel(flag: string): string {
  if (/^health_claim_term|^forbidden_string/.test(flag)) return "Compliance";
  if (flag.startsWith("similar_to_existing")) return "Similar to existing";
  if (flag.startsWith("exclamation")) return "Exclamation mark";
  if (flag.startsWith("unverified_number")) return "Check number";
  return "Check";
}

function IdeaCard({ idea, index, onUse }: { idea: Idea; index: number; onUse: () => void }) {
  const copy = [idea.hook, idea.angle && `\n${idea.angle}`, idea.why && `\nWhy: ${idea.why}`].filter(Boolean).join("");
  return (
    <article className="card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-3 text-[11px] font-semibold tabular-nums text-muted" aria-hidden="true">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-semibold leading-snug text-paper">{idea.hook}</p>
          {idea.angle ? <p className="mt-1.5 break-words text-sm leading-relaxed text-paper/85">{idea.angle}</p> : null}
          {idea.format || idea.hookType || idea.pillar ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
              {idea.format ? <span className="rounded-full border border-subtle px-2 py-0.5 font-medium text-paper/85">{formatLabel(idea.format)}</span> : null}
              {idea.hookType ? <span className="rounded-full border border-subtle px-2 py-0.5 text-muted">{optionLabel("hookTypes", idea.hookType)}</span> : null}
              {idea.pillar ? (
                <span className="max-w-full truncate rounded-full border border-subtle px-2 py-0.5 text-muted" title={idea.pillar}>
                  {idea.pillar}
                </span>
              ) : null}
            </div>
          ) : null}
          {idea.why ? <p className="mt-2 break-words text-xs italic leading-relaxed text-muted">{idea.why}</p> : null}
          {idea.flags.length ? (
            <ul className="mt-2.5 grid gap-1 text-xs">
              {idea.flags.map((flag, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className={`mt-px shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${CRITICAL_IDEA_FLAG.test(flag) ? "border-danger/50 text-danger" : "border-subtle text-muted"}`}>
                    {flagLabel(flag)}
                  </span>
                  <span className="min-w-0 break-words text-muted">{flag}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 sm:pl-9">
        <button type="button" className="btn btn-sm btn-primary" onClick={onUse} title="Fill the Create brief with this idea">
          Use in Create
        </button>
        <CopyButton text={copy} label="Copy idea" />
      </div>
    </article>
  );
}

function BatchRow({ batch, open, onToggle, onUse, onDelete, deleting }: { batch: IdeaBatchDTO; open: boolean; onToggle: () => void; onUse: (idea: Idea) => void; onDelete: () => void; deleting: boolean }) {
  return (
    <article className="card overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 p-3.5 text-left text-xs transition-colors hover:bg-ink-3/60">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${batch.source === "weekly" ? "border-gold/50 text-gold-ink" : "border-subtle text-muted"}`}>{batch.source === "weekly" ? "Weekly" : "Manual"}</span>
        <span className="font-semibold text-paper">{batch.brandName}</span>
        <span className="text-muted">{optionLabel("platforms", batch.params.platform)}</span>
        <span className="text-faint">·</span>
        <span className="text-muted">{batch.ideas.length} ideas</span>
        <span className="text-faint">·</span>
        <span className="text-faint">{dateTime(batch.createdAt)}</span>
        {batch.model ? <span className="ml-auto truncate text-faint">{batch.model}</span> : null}
      </button>
      {open ? (
        <div className="grid gap-2.5 border-t border-subtle bg-ink/60 p-3 sm:p-4">
          {batch.ideas.map((idea, i) => (
            <IdeaCard key={i} idea={idea} index={i} onUse={() => onUse(idea)} />
          ))}
          <div className="flex justify-end">
            <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onDelete} disabled={deleting}>
              {deleting ? <Spinner /> : "Delete batch"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function IdeasView({
  brands,
  initialBrandSlug,
  providerNote,
  onUseIdea,
  onToast,
}: {
  brands: BrandOption[];
  initialBrandSlug: string;
  /** Status text from /api/options while the tab has not loaded its own status yet. */
  providerNote?: string;
  onUseIdea: (idea: Idea, origin: IdeaOrigin) => void;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const startBrand = brands.find((b) => b.slug === initialBrandSlug) ?? brands[0];
  const [brandSlug, setBrandSlug] = useState(startBrand?.slug ?? "");
  const brand = brands.find((b) => b.slug === brandSlug) ?? startBrand;
  const platformIds = useMemo(() => brandPlatformIds(brand), [brand]);
  const defaultLanguage = (b: BrandOption | undefined): "de" | "en" => (b?.languages[0] === "en" ? "en" : "de");

  const [platform, setPlatform] = useState(platformIds[0] ?? "instagram");
  const [pillar, setPillar] = useState("");
  const [goal, setGoal] = useState("any");
  const [language, setLanguage] = useState<"de" | "en">(defaultLanguage(startBrand));
  const [count, setCount] = useState(String(IDEA_COUNT_DEFAULT));
  const [direction, setDirection] = useState("");
  const [model, setModel] = useState("");

  const [status, setStatus] = useState<IdeasStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<IdeasResponse | null>(null);

  const [historyTab, setHistoryTab] = useState<"manual" | "weekly">("manual");
  const [allBrands, setAllBrands] = useState(false);
  const [history, setHistory] = useState<IdeaBatchDTO[] | null>(null);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.ideas
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* the tab still works; the status line just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));

  useEffect(() => {
    let cancelled = false;
    api.ideas
      .list({ source: historyTab, limit: 60 })
      .then((batches) => {
        if (!cancelled) setHistory(batches);
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(toApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [historyTab, reloadKey]);

  const reloadHistory = () => {
    setHistory(null);
    setHistoryError(null);
    setReloadKey((k) => k + 1);
  };
  const changeHistoryTab = (tab: "manual" | "weekly") => {
    setHistoryTab(tab);
    setHistory(null);
    setHistoryError(null);
  };

  const changeBrand = (slug: string) => {
    const next = brands.find((b) => b.slug === slug);
    setBrandSlug(slug);
    setPlatform(brandPlatformIds(next)[0] ?? "instagram");
    setPillar("");
    setLanguage(defaultLanguage(next));
  };

  const configured = status ? status.configured : true; // until the status arrives, do not block the button
  // The default is the placeholder entry; the dropdown only lists the alternatives.
  const modelOptions: SelectOption[] = (status?.models ?? []).filter((m) => m !== status?.model).map((m) => ({ id: m, label: m }));

  const generate = async () => {
    const params: IdeasParams = { brandSlug, platform, pillar, goal, language, count: Number(count), direction: direction.trim(), ...(model ? { model } : {}) } as IdeasParams;
    setGenerating(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setError(null);
    setResult(null);
    try {
      const res = await api.ideas.generate(params);
      setResult(res);
      if (res.batch.source === "manual" && historyTab === "manual") setHistory((h) => [res.batch, ...(h ?? []).filter((b) => b.id !== res.batch.id)]);
      const critical = res.batch.ideas.filter((i) => i.flags.some((f) => CRITICAL_IDEA_FLAG.test(f))).length;
      if (critical) onToast("error", `${critical} idea${critical > 1 ? "s" : ""} flagged by the compliance lint; review before using.`);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      onToast("error", err.message);
    } finally {
      setGenerating(false);
      setStartedAt(null);
    }
  };

  const checkConnection = async () => {
    setProbing(true);
    try {
      setStatus(await api.ideas.status(true));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setProbing(false);
    }
  };

  const remove = async (batch: IdeaBatchDTO) => {
    if (!window.confirm("Delete this batch of ideas?")) return;
    setDeletingId(batch.id);
    try {
      await api.ideas.remove(batch.id);
      setHistory((h) => (h ?? []).filter((b) => b.id !== batch.id));
      if (result?.batch.id === batch.id) setResult(null);
    } catch (e) {
      onToast("error", toApiError(e).message);
    } finally {
      setDeletingId(null);
    }
  };

  const originOf = (p: IdeasParams): IdeaOrigin => ({ brandSlug: p.brandSlug, platform: p.platform, pillar: p.pillar, goal: p.goal, language: p.language });
  const shownHistory = (history ?? []).filter((b) => allBrands || b.brandSlug === brandSlug);
  const probe = status?.probe;

  return (
    <section aria-label="Ideas">
      <div className="mb-4 min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">Ideas</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
          Brainstorm post ideas with your own OpenAI-compatible model (IDEAS_LLM_* or LOCAL_LLM_*). Each idea is a hook plus an angle, based on what worked for the
          brand and checked against its guardrails. Pick one and press <strong className="font-semibold text-paper/85">Use in Create</strong> to have the strategist write it.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Fieldset title="Brainstorm">
            <Field label="Brand" htmlFor="ideas-brand">
              <Select id="ideas-brand" value={brandSlug} onChange={changeBrand} options={brands.map((b) => ({ id: b.slug, label: b.name }))} disabled={!brands.length || generating} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Platform" htmlFor="ideas-platform">
                <Select id="ideas-platform" value={platform} onChange={setPlatform} options={platformIds.map((id) => ({ id, label: optionLabel("platforms", id) }))} disabled={generating} />
              </Field>
              <Field label="Language" htmlFor="ideas-language">
                <Select id="ideas-language" value={language} onChange={(v) => setLanguage(v === "en" ? "en" : "de")} options={LANGUAGE_OPTIONS} disabled={generating} />
              </Field>
            </div>
            <Field label="Pillar" htmlFor="ideas-pillar">
              <Select id="ideas-pillar" value={pillar} onChange={setPillar} options={(brand?.pillars ?? []).map((p) => ({ id: p, label: p }))} placeholder="Any pillar (spread across them)" disabled={generating} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="Goal" htmlFor="ideas-goal">
                <Select id="ideas-goal" value={goal} onChange={setGoal} options={GOAL_OPTIONS} disabled={generating} />
              </Field>
              <Field label="How many" htmlFor="ideas-count">
                <Select id="ideas-count" value={count} onChange={setCount} options={COUNT_OPTIONS} disabled={generating} />
              </Field>
            </div>
            <Field label="Direction (optional)" htmlFor="ideas-direction" hint="A theme, an offer, an event or a question the ideas should circle around.">
              <TextArea id="ideas-direction" value={direction} onChange={setDirection} rows={3} maxLength={1000} placeholder="e.g. the 2027 reform, a new batch sheet, Ramadan routines…" disabled={generating} />
            </Field>
            {modelOptions.length > 0 ? (
              <Field label="Model" htmlFor="ideas-model" hint="Larger models think longer and write better hooks; smaller ones answer in under a minute.">
                <Select id="ideas-model" value={model} onChange={setModel} options={modelOptions} placeholder={`Default (${status?.model ?? "server default"})`} disabled={generating} />
              </Field>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => void generate()} disabled={generating || !brands.length || !configured}>
              {generating ? <Spinner /> : null}
              {generating ? `Brainstorming… ${clock(elapsed)}` : "Generate ideas"}
            </button>
            <div className="grid gap-1.5 text-[11px] leading-relaxed text-muted" aria-live="polite">
              {status && !status.configured ? <p className="text-warn">{status.note ?? providerNote ?? "The Ideas model is not connected yet."}</p> : null}
              {status?.configured ? (
                <p>
                  Model: <span className="font-medium text-paper/85">{status.model ?? "server default"}</span>
                  {status.weekly ? " · a weekly idea bank is written every Monday" : ""}
                </p>
              ) : null}
              {status?.configured ? (
                <p>
                  <button type="button" className="font-medium text-gold-ink underline-offset-2 hover:underline disabled:opacity-50" onClick={() => void checkConnection()} disabled={probing}>
                    {probing ? "Checking…" : "Check connection"}
                  </button>
                  {probe ? (
                    <span className={`ml-2 ${probe.reachable ? "text-success" : "text-danger"}`}>
                      {probe.reachable ? `The model answered in ${probe.ms} ms: ${probe.detail}` : probe.detail}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          </Fieldset>
        </div>

        <div className="min-w-0">
          <ErrorBanner error={error} title="Ideas" onDismiss={() => setError(null)} className="mb-4" />

          {generating ? (
            <div className="card flex items-start gap-3 p-5 text-sm">
              <Spinner className="mt-1" />
              <div className="min-w-0">
                <p className="font-medium text-paper">The model is brainstorming ({clock(elapsed)})</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  This usually takes one to three minutes. {elapsed > 120 ? "It is taking longer than usual: the model may have been loading, or the server is busy with another job. " : ""}You can switch tabs; the result appears here.
                </p>
              </div>
            </div>
          ) : null}

          {result && !generating ? (
            <div className="grid gap-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span className="font-semibold text-paper">
                  {result.batch.ideas.length} ideas for {result.batch.brandName} · {optionLabel("platforms", result.batch.params.platform)}
                </span>
                <span>
                  {result.batch.model ?? "model"} · {Math.round(result.durationMs / 1000)} s
                </span>
                {result.dropped ? <span title="Near-copies of hooks that already exist were removed">{result.dropped} near-copies removed</span> : null}
                {result.attempts > 1 ? <span>second attempt needed</span> : null}
              </div>
              {result.warnings.filter((w) => !w.startsWith("repaired_json")).map((w, i) => (
                <p key={i} className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-paper/85">
                  {w}
                </p>
              ))}
              {result.batch.ideas.map((idea, i) => (
                <IdeaCard key={i} idea={idea} index={i} onUse={() => onUseIdea(idea, originOf(result.batch.params))} />
              ))}
            </div>
          ) : null}

          {!result && !generating && !error ? (
            <div className="card p-6 text-sm text-muted">
              <p className="font-medium text-paper">No ideas yet</p>
              <p className="mt-1 text-xs leading-relaxed">
                Choose a brand and a platform on the left, optionally give a direction, and press Generate ideas. The model sees the brand&apos;s profile, its best and worst researched posts and everything it has already proposed, so it does
                not repeat itself.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div role="tablist" aria-label="Idea history" className="flex items-center gap-0.5 rounded-lg border border-subtle bg-ink-2 p-0.5">
            {(
              [
                ["manual", "My batches"],
                ["weekly", "Weekly idea bank"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={historyTab === id}
                onClick={() => changeHistoryTab(id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${historyTab === id ? "bg-ink-3 text-paper" : "text-muted hover:text-paper"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={allBrands} onChange={(e) => setAllBrands(e.target.checked)} /> All brands
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={reloadHistory} disabled={history === null && !historyError}>
              Reload
            </button>
          </div>
        </div>

        <ErrorBanner error={historyError ? { message: historyError.message, hint: historyError.hint } : null} title="Could not load the history" className="mb-3" />
        {history === null && !historyError ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        ) : null}
        {history && !shownHistory.length ? (
          <div className="card p-6 text-center text-sm text-muted">
            {historyTab === "weekly"
              ? status?.weekly
                ? "The weekly idea bank fills overnight, from Monday 03:00 (SCHEDULER_TIMEZONE, default Europe/Berlin; enable with IDEAS_WEEKLY=on; a missed week is made up on a later night, between 03:00 and 07:00). Nothing has been written for this brand yet."
                : "The weekly idea bank is off: it needs the Ideas model connected (and IDEAS_WEEKLY not set to off)."
              : "No batches for this brand yet."}
          </div>
        ) : null}
        <div className="grid gap-2.5">
          {shownHistory.map((b, i) => (
            <BatchRow
              key={b.id}
              batch={b}
              open={openId === b.id || (openId === null && i === 0 && historyTab === "weekly")}
              onToggle={() => setOpenId((id) => (id === b.id ? "" : b.id))}
              onUse={(idea) => onUseIdea(idea, originOf(b.params))}
              onDelete={() => void remove(b)}
              deleting={deletingId === b.id}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
