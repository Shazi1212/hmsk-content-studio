"use client";

import { useEffect, useState } from "react";
import { ageInDays, DEFAULT_REFRESH_AFTER_DAYS, refreshDue } from "@/lib/similarity";
import { optionLabel } from "./brief";
import { formatDate, formatTokens } from "./StrategyCard";
import type { HistoryFilter } from "./storage";
import type { BrandOption, HistoryItem } from "./types";
import { ErrorBanner, type BannerError } from "./ui/ErrorBanner";
import { Select, Spinner } from "./ui/Field";
import { StatusPill } from "./ui/StatusDot";

const STATUS_OPTIONS = [
  { id: "approved", label: "Approved" },
  { id: "draft", label: "Drafts" },
  { id: "rejected", label: "Rejected" },
];

export function HistoryDrawer({
  open,
  onClose,
  brands,
  items,
  loading,
  error,
  filter,
  onFilterChange,
  onReload,
  onOpen,
  onDelete,
  currentId,
  deletingId,
}: {
  open: boolean;
  onClose: () => void;
  brands: BrandOption[];
  items: HistoryItem[];
  loading: boolean;
  error: BannerError | null;
  filter: HistoryFilter;
  onFilterChange: (f: HistoryFilter) => void;
  onReload: () => void;
  onOpen: (item: HistoryItem) => void;
  onDelete: (item: HistoryItem) => void;
  currentId: string | null;
  deletingId: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Taken once per mount, so the render stays pure.
  const [now] = useState(() => new Date());

  if (!open) return null;

  const brandOf = (item: HistoryItem) => brands.find((b) => b.slug === item.brandSlug || (b.id !== undefined && b.id === item.brandId));
  /** Approved pieces older than the brand's refresh window: worth bringing back with updated facts. */
  const refreshAge = (item: HistoryItem): number | null => {
    if (item.status !== "approved") return null;
    const date = new Date(item.approvedAt ?? item.createdAt);
    return refreshDue(date, now, brandOf(item)?.refreshAfterDays ?? DEFAULT_REFRESH_AFTER_DAYS) ? ageInDays(date, now) : null;
  };

  const brandName = (item: HistoryItem) =>
    item.brand?.name ?? brandOf(item)?.name ?? "";

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Generation history">
      <button type="button" className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" onClick={onClose} aria-label="Close history" />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l border-subtle bg-ink shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
          <div>
            <div className="text-sm font-semibold">History</div>
            <div className="text-[11px] text-muted">Approved and draft generations; approved ones feed future briefs.</div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onReload} disabled={loading} title="Reload">
              {loading ? <Spinner /> : "Reload"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-subtle px-4 py-3">
          <Select
            ariaLabel="Filter by brand"
            value={filter.brandSlug}
            onChange={(v) => onFilterChange({ ...filter, brandSlug: v })}
            options={brands.map((b) => ({ id: b.slug, label: b.name }))}
            placeholder="All brands"
          />
          <Select ariaLabel="Filter by status" value={filter.status} onChange={(v) => onFilterChange({ ...filter, status: v })} options={STATUS_OPTIONS} placeholder="All statuses" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ErrorBanner error={error} onDismiss={undefined} className="mb-3" />
          {loading && !items.length ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Spinner /> Loading…
            </div>
          ) : null}
          {!loading && !items.length && !error ? (
            <p className="py-8 text-center text-sm text-muted">Nothing saved yet. Approve a generation to start the reference history.</p>
          ) : null}
          <ul className="grid gap-2">
            {items.map((item) => {
              const hook = item.output?.variants?.[0]?.hook ?? "";
              const angle = item.output?.strategy?.angle ?? "";
              const isCurrent = item.id === currentId;
              const tokens = formatTokens(item.inputTokens, item.outputTokens, item.cacheReadTokens);
              return (
                <li key={item.id} className={`card p-3 ${isCurrent ? "border-gold/50" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-semibold text-paper">{brandName(item) || item.brandSlug || "Brand"}</span>
                      <span className="text-faint">·</span>
                      <span className="text-muted">{optionLabel("platforms", item.platform)}</span>
                      <span className="text-faint">·</span>
                      <span className="text-muted">{optionLabel("postTypes", item.postType).split(" — ")[0]}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {refreshAge(item) !== null ? (
                        <span
                          className="rounded-full border border-success/40 px-1.5 py-px text-[10px] uppercase tracking-wide text-success"
                          title={`Approved ${refreshAge(item)} days ago: an evergreen candidate. Reopen it and refresh facts, prices and links before posting it again.`}
                        >
                          Refresh due
                        </span>
                      ) : null}
                      {typeof item.score === "number" ? <span className="text-[11px] tabular-nums text-muted">{item.score}/10</span> : null}
                      <StatusPill status={item.status} />
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug text-paper/90">{hook || angle || "(no hook)"}</p>
                  {hook && angle ? <p className="mt-1 line-clamp-1 text-xs text-muted">{angle}</p> : null}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-faint">
                      {formatDate(item.createdAt)}
                      {item.provider ? ` · ${item.provider}` : ""}
                      {tokens ? ` · ${tokens}` : ""}
                      {item.imageUrls && item.imageUrls.length > 1 ? ` · ${item.imageUrls.length} slides` : item.imageUrl ? " · image" : ""}
                      {item.audioUrl ? " · voice-over" : ""}
                      {item.videoUrl ? " · video" : ""}
                    </span>
                    <div className="flex items-center gap-1">
                      <button type="button" className="btn btn-sm" onClick={() => onOpen(item)} disabled={isCurrent}>
                        {isCurrent ? "Open now" : "Reopen"}
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => onDelete(item)} disabled={deletingId === item.id}>
                        {deletingId === item.id ? <Spinner /> : "Delete"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}
