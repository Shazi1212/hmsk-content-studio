"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, toApiError } from "./api";
import { optionLabel } from "./brief";
import type { BrandOption, PerformanceBucket, ReferenceRow } from "./types";
import { DataSources } from "./DataSources";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Select, Spinner, TextInput, type SelectOption } from "./ui/Field";

type SortKey = "performance" | "newest" | "views";

const SORT_OPTIONS: SelectOption[] = [
  { id: "performance", label: "Best performing first" },
  { id: "newest", label: "Newest first" },
  { id: "views", label: "Most views first" },
];

const BUCKET_ORDER: PerformanceBucket[] = ["exceptional", "high", "typical", "mixed", "low", "unknown"];

const BUCKET_LABEL: Record<PerformanceBucket, string> = {
  exceptional: "Exceptional",
  high: "High",
  typical: "Typical",
  mixed: "Mixed (reach without interaction)",
  low: "Low",
  unknown: "Unknown",
};

const BUCKET_BADGE: Record<PerformanceBucket, string> = {
  exceptional: "Exceptional",
  high: "High",
  typical: "Typical",
  mixed: "Mixed",
  low: "Low",
  unknown: "Unknown",
};

const BUCKET_STYLE: Record<PerformanceBucket, string> = {
  exceptional: "border-success/50 bg-success/10 text-success",
  high: "border-success/40 text-success",
  typical: "border-subtle text-muted",
  mixed: "border-warn/50 text-warn",
  low: "border-danger/40 text-danger",
  unknown: "border-subtle text-faint",
};

const LINKEDIN_SUFFIX: Record<string, string> = {
  company: "company page",
  showcase: "showcase page",
  founder: "founder",
  personal: "personal profile",
};

/** "linkedin-founder" → "LinkedIn · founder"; plain platforms use the catalog label. */
function platformLabel(raw: string): string {
  const [base, ...rest] = raw.split("-");
  const label = optionLabel("platforms", base);
  const suffix = rest.join("-");
  return suffix ? `${label} · ${LINKEDIN_SUFFIX[suffix] ?? suffix}` : label;
}

/** Metrics are free text from the research ("N/A", "Not publicly available", "Not shown"): hide the ones that say nothing. */
function metricText(value: string | null): string | null {
  const s = (value ?? "").trim();
  return !s || /^(n\/?a|not (publicly )?(available|shown)|hidden|unknown)\b/i.test(s) ? null : s;
}

/** "12.3K" / "1,204" / "1.2M" → number; -1 when there is no figure. */
function metricNumber(value: string | null): number {
  const m = (value ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return -1;
  const n = Number(m[1]);
  return m[2] ? n * (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000) : n;
}

/** The research stores dates as "2026-09-17 (3d)": sort on the ISO part. */
function dateValue(value: string | null): number {
  const t = Date.parse((value ?? "").slice(0, 10));
  return Number.isNaN(t) ? 0 : t;
}

type Indexed = { row: ReferenceRow; haystack: string; time: number; views: number };

function indexRow(row: ReferenceRow): Indexed {
  const haystack = [
    row.hook,
    row.topic,
    row.product,
    row.mainMessage,
    row.cta,
    row.pillar,
    row.format,
    row.hookType,
    row.emotionalDriver,
    row.contentMechanism,
    row.observations,
    row.brandName,
    platformLabel(row.platform),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return { row, haystack, time: dateValue(row.date), views: metricNumber(row.views) };
}

function compare(sort: SortKey) {
  return (a: Indexed, b: Indexed): number => {
    if (sort === "newest") return b.time - a.time;
    if (sort === "views") return b.views - a.views || b.time - a.time;
    return BUCKET_ORDER.indexOf(a.row.bucket) - BUCKET_ORDER.indexOf(b.row.bucket) || b.time - a.time;
  };
}

function uniqueSorted(values: (string | null)[], label: (v: string) => string = (v) => v): SelectOption[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))]
    .sort((a, b) => label(a).localeCompare(label(b)))
    .map((v) => ({ id: v, label: label(v) }));
}

type TextField =
  | "mainMessage"
  | "topic"
  | "product"
  | "hookType"
  | "emotionalDriver"
  | "storytelling"
  | "trendReference"
  | "cta"
  | "ctaType"
  | "visualConcept"
  | "visualStyle"
  | "colors"
  | "typography"
  | "people"
  | "productPlacement"
  | "captionStyle"
  | "captionStructure"
  | "performanceLevel"
  | "performanceEvidence"
  | "audienceReaction"
  | "engagementIndicators"
  | "contentMechanism"
  | "replicability"
  | "observations"
  | "confidence"
  | "sourceEvidence";

type DetailField = { key: TextField; label: string; wide?: boolean };

const DETAIL_SECTIONS: { title: string; fields: DetailField[] }[] = [
  {
    title: "Message",
    fields: [
      { key: "mainMessage", label: "Main message", wide: true },
      { key: "topic", label: "Topic" },
      { key: "product", label: "Product / service" },
      { key: "hookType", label: "Hook type" },
      { key: "emotionalDriver", label: "Emotional driver" },
      { key: "storytelling", label: "Storytelling" },
      { key: "trendReference", label: "Trend / reference" },
      { key: "cta", label: "Call to action" },
      { key: "ctaType", label: "CTA type" },
    ],
  },
  {
    title: "Format and visuals",
    fields: [
      { key: "visualConcept", label: "Visual concept", wide: true },
      { key: "visualStyle", label: "Visual style" },
      { key: "colors", label: "Colours" },
      { key: "typography", label: "Typography" },
      { key: "people", label: "People" },
      { key: "productPlacement", label: "Product placement" },
      { key: "captionStyle", label: "Caption style" },
      { key: "captionStructure", label: "Caption structure", wide: true },
    ],
  },
  {
    title: "Performance and learning",
    fields: [
      { key: "performanceLevel", label: "Research rating" },
      { key: "confidence", label: "Confidence" },
      { key: "performanceEvidence", label: "Performance evidence", wide: true },
      { key: "audienceReaction", label: "Audience reaction", wide: true },
      { key: "engagementIndicators", label: "Engagement indicators", wide: true },
      { key: "contentMechanism", label: "Why it works (mechanism)", wide: true },
      { key: "replicability", label: "How to reuse the mechanism", wide: true },
      { key: "observations", label: "What we observed", wide: true },
      { key: "sourceEvidence", label: "Source evidence", wide: true },
    ],
  },
];

function PostDetails({ row }: { row: ReferenceRow }) {
  return (
    <div className="grid gap-5 border-t border-subtle bg-ink/60 p-4 sm:p-5">
      {DETAIL_SECTIONS.map((section) => {
        const fields = section.fields.filter((f) => (row[f.key] ?? "").trim());
        if (!fields.length) return null;
        return (
          <section key={section.title}>
            <div className="eyebrow mb-2">{section.title}</div>
            <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              {fields.map((f) => (
                <div key={f.key} className={f.wide ? "md:col-span-2" : ""}>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{f.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-paper">{(row[f.key] ?? "").trim()}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        {row.postUrl ? (
          <a href={row.postUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-gold-ink underline-offset-2 hover:underline">
            Open the original post ↗
          </a>
        ) : null}
        <span>Source: {row.source}</span>
      </div>
    </div>
  );
}

const METRICS: { key: "views" | "likes" | "comments" | "shares" | "saves"; label: string }[] = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "saves", label: "Saves" },
];

function PostRow({ row, open, onToggle, showBrand }: { row: ReferenceRow; open: boolean; onToggle: () => void; showBrand: boolean }) {
  return (
    <article className="card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full gap-x-6 gap-y-3 p-3.5 text-left transition-colors hover:bg-ink-3/60 sm:p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BUCKET_STYLE[row.bucket]}`} title={row.performanceLevel ?? undefined}>
              {BUCKET_BADGE[row.bucket]}
            </span>
            {showBrand ? <span className="font-semibold text-paper">{row.brandName}</span> : null}
            <span className="text-muted">{platformLabel(row.platform)}</span>
            {row.format ? (
              <>
                <span className="text-faint">·</span>
                <span className="text-muted">{row.format}</span>
              </>
            ) : null}
            {row.date ? (
              <>
                <span className="text-faint">·</span>
                <span className="text-faint">{row.date}</span>
              </>
            ) : null}
          </div>
          <p className="mt-1.5 break-words text-sm font-medium leading-snug text-paper">{row.hook || row.topic || "(no hook recorded)"}</p>
          {row.pillar ? <p className="mt-1 text-xs text-muted">{row.pillar}</p> : null}
        </div>
        <dl className="grid grid-cols-5 gap-3 text-center md:w-[21rem]">
          {METRICS.map((m) => {
            const v = metricText(row[m.key]);
            return (
              <div key={m.key} className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wide text-faint">{m.label}</dt>
                <dd className={`mt-0.5 truncate text-xs tabular-nums ${v ? "text-paper" : "text-faint"}`} title={v ?? "not available"}>
                  {v ?? "–"}
                </dd>
              </div>
            );
          })}
        </dl>
      </button>
      {open ? <PostDetails row={row} /> : null}
    </article>
  );
}

export function ResearchView({ brands, initialBrandSlug, onToast }: { brands: BrandOption[]; initialBrandSlug: string; onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const [rows, setRows] = useState<ReferenceRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [brand, setBrand] = useState(initialBrandSlug);
  const [platform, setPlatform] = useState("");
  const [pillar, setPillar] = useState("");
  const [bucket, setBucket] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("performance");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.references();
        if (!cancelled) setRows(data.filter((r) => r && typeof r.id === "string"));
      } catch (e) {
        if (!cancelled) setError(toApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => {
    setRows(null);
    setError(null);
    setReloadKey((k) => k + 1);
  };
  // Re-read without clearing the list (after a sync): the rows update in place.
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const indexed = useMemo(() => (rows ?? []).map(indexRow), [rows]);
  const inBrand = useMemo(() => indexed.filter((i) => !brand || i.row.brandSlug === brand), [indexed, brand]);
  const platformOptions = useMemo(() => uniqueSorted(inBrand.map((i) => i.row.platform), platformLabel), [inBrand]);
  const pillarOptions = useMemo(() => uniqueSorted(inBrand.map((i) => i.row.pillar)), [inBrand]);
  const bucketOptions = useMemo<SelectOption[]>(() => {
    const present = new Set(inBrand.map((i) => i.row.bucket));
    return BUCKET_ORDER.filter((b) => present.has(b)).map((b) => ({ id: b, label: BUCKET_LABEL[b] }));
  }, [inBrand]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return inBrand
      .filter((i) => (!platform || i.row.platform === platform) && (!pillar || i.row.pillar === pillar) && (!bucket || i.row.bucket === bucket))
      .filter((i) => terms.every((t) => i.haystack.includes(t)))
      .sort(compare(sort));
  }, [inBrand, platform, pillar, bucket, query, sort]);

  const hasFilters = !!(platform || pillar || bucket || query.trim());
  const sources = useMemo(() => [...new Set((rows ?? []).map((r) => r.source))].join(", "), [rows]);
  const loading = rows === null && !error;

  return (
    <section aria-label="Research data">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium">Research data</h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
            The posts the strategist learns from when you generate: what each brand published, what worked and what failed. High and Exceptional
            posts are mechanisms to rebuild, Low ones are patterns to avoid. Open a row for the full analysis.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {rows ? (
            <span className="text-xs tabular-nums text-muted">
              {filtered.length} of {rows.length} posts
            </span>
          ) : null}
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload} disabled={loading}>
            {loading ? <Spinner /> : "Reload"}
          </button>
        </div>
      </div>

      <DataSources brands={brands} onSynced={refresh} onToast={onToast} />

      <div className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,1fr))]">
        <TextInput type="search" value={query} onChange={setQuery} placeholder="Search hook, topic, message, CTA…" className="sm:col-span-2 lg:col-span-1" />
        <Select
          ariaLabel="Filter by brand"
          value={brand}
          onChange={(v) => {
            setBrand(v);
            setPlatform("");
            setPillar("");
            setBucket("");
          }}
          options={brands.map((b) => ({ id: b.slug, label: b.name }))}
          placeholder="All brands"
        />
        <Select ariaLabel="Filter by platform" value={platform} onChange={setPlatform} options={platformOptions} placeholder="All platforms" />
        <Select ariaLabel="Filter by content pillar" value={pillar} onChange={setPillar} options={pillarOptions} placeholder="All pillars" />
        <Select ariaLabel="Filter by performance" value={bucket} onChange={setBucket} options={bucketOptions} placeholder="All results" />
        <Select ariaLabel="Sort posts" value={sort} onChange={(v) => setSort(v as SortKey)} options={SORT_OPTIONS} />
      </div>

      <ErrorBanner error={error ? { message: error.message, hint: error.hint } : null} title="Could not load the research data" className="mb-4" />

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted">
          <Spinner /> Loading the research posts…
        </div>
      ) : null}

      {rows && !filtered.length ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center text-sm text-muted">
          <p>{rows.length ? "No posts match these filters." : "No research data is stored yet. Run the seed to load the datasets."}</p>
          {hasFilters ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setPlatform("");
                setPillar("");
                setBucket("");
                setQuery("");
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2.5">
        {filtered.map(({ row }) => (
          <PostRow key={row.id} row={row} open={openId === row.id} onToggle={() => setOpenId((id) => (id === row.id ? null : row.id))} showBrand={!brand} />
        ))}
      </div>

      {sources ? <p className="mt-4 text-center text-[11px] text-faint">Source: {sources}</p> : null}
    </section>
  );
}
