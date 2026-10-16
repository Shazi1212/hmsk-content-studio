"use client";

import { useMemo, useState } from "react";
import type { ApiError } from "./api";
import { MAX_SENT_REFERENCES, isProductAsset, kindLabel } from "./assets";
import { useBrandAssets, type AssetsStatus } from "./BrandAssets";
import type { BrandAsset } from "./types";
import { Spinner } from "./ui/Field";

/** What to add to an api.image call: nothing = the brand's default photos, referenceIds = exactly those, references:false = none. */
export type ReferenceParams = { referenceIds?: string[]; references?: boolean };

export type ReferenceSelection = {
  assets: BrandAsset[];
  status: AssetsStatus;
  error: ApiError | null;
  selectedIds: Set<string>;
  /** The selection differs from the brand's default photos. */
  changed: boolean;
  params: ReferenceParams;
  /** Product and packaging photos in the selection; before the photos have loaded, the server's count of default ones. */
  productCount: number;
  toggle: (id: string) => void;
  reset: () => void;
  retry: () => void;
  openManager: () => void;
};

/**
 * The reference photos picked for one production panel. Untouched, the brand's default photos apply and nothing is sent, so the
 * server keeps using the defaults; once the user ticks or unticks something the explicit list is sent with every image call.
 */
export function useReferenceSelection(brandSlug: string, fallbackProductCount: number): ReferenceSelection {
  const { assets, status, error, reload, openManager } = useBrandAssets(brandSlug);
  const [picked, setPicked] = useState<string[] | null>(null);
  const loaded = status === "ready";

  const defaultIds = useMemo(() => assets.filter((a) => a.isDefault).map((a) => a.id), [assets]);
  // Only photos that still exist count (one may have been deleted in the Brand assets tab since).
  const selectedIds = useMemo(() => {
    const wanted = new Set(picked ?? defaultIds);
    return new Set(assets.filter((a) => wanted.has(a.id)).map((a) => a.id));
  }, [assets, picked, defaultIds]);

  const changed = loaded && picked !== null && (selectedIds.size !== defaultIds.length || defaultIds.some((id) => !selectedIds.has(id)));
  const params: ReferenceParams = !changed ? {} : selectedIds.size === 0 ? { references: false } : { referenceIds: assets.filter((a) => selectedIds.has(a.id)).map((a) => a.id) };
  const productCount = loaded ? assets.filter((a) => selectedIds.has(a.id) && isProductAsset(a)).length : fallbackProductCount;

  return {
    assets,
    status,
    error,
    selectedIds,
    changed,
    params,
    productCount,
    toggle: (id) =>
      setPicked((prev) => {
        const next = new Set(prev ?? defaultIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return [...next];
      }),
    reset: () => setPicked(null),
    retry: () => void reload(),
    openManager,
  };
}

/** "Reference photos" row at the top of the production section: tick the photos the image model gets for this post. */
export function ReferencePicker({ selection }: { selection: ReferenceSelection }) {
  const { assets, status, error, selectedIds, changed, toggle, reset, retry, openManager } = selection;
  const count = selectedIds.size;
  const over = count > MAX_SENT_REFERENCES;

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="text-sm font-semibold">Reference photos</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {status === "ready" && assets.length ? (
            <span className={over ? "font-medium text-warn" : "text-muted"} aria-live="polite">
              {count} selected (max {MAX_SENT_REFERENCES} sent)
            </span>
          ) : null}
          {changed ? (
            <button type="button" className="font-medium text-muted underline underline-offset-2 hover:text-paper" onClick={reset}>
              Back to defaults
            </button>
          ) : null}
          <button type="button" className="font-medium text-gold-ink underline underline-offset-2 hover:text-paper" onClick={openManager}>
            Manage
          </button>
        </div>
      </div>

      {status === "loading" ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="!h-3 !w-3" /> Loading the reference photos…
        </div>
      ) : null}

      {status === "error" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
          <span>Could not load the reference photos{error ? `: ${error.message}` : ""}. Images still use the default photos of this brand.</span>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {status === "ready" && !assets.length ? (
        <p className="text-xs text-muted">
          No reference photos for this brand yet, so the image model invents the product. Add the logo and real product photos under{" "}
          <button type="button" className="font-medium text-gold-ink underline underline-offset-2 hover:text-paper" onClick={openManager}>
            Brand assets
          </button>
          .
        </p>
      ) : null}

      {status === "ready" && assets.length ? (
        <div className="grid gap-2">
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto p-1">
            {assets.map((a) => {
              const checked = selectedIds.has(a.id);
              return (
                <label
                  key={a.id}
                  title={`${kindLabel(a.kind)}: ${a.label}${a.isDefault ? " (default)" : ""}`}
                  className={`relative block w-[76px] shrink-0 cursor-pointer overflow-hidden rounded-lg border transition-colors ${
                    checked ? "border-gold ring-2 ring-gold/40" : "border-subtle opacity-75 hover:opacity-100"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt="" loading="lazy" className="h-[76px] w-full bg-ink-3 object-contain" />
                  <input
                    type="checkbox"
                    className="absolute left-1 top-1 h-4 w-4"
                    checked={checked}
                    onChange={() => toggle(a.id)}
                    aria-label={`${kindLabel(a.kind)}: ${a.label}`}
                  />
                  <span className="block truncate bg-ink-2 px-1 py-0.5 text-[10px] leading-tight text-muted">{a.label}</span>
                </label>
              );
            })}
          </div>
          <p className={`text-[11px] leading-snug ${over || count === 0 ? "text-warn" : "text-muted"}`}>
            {count === 0
              ? "No photo selected: images are made without references, so the product may not look like the real one."
              : over
                ? `Only ${MAX_SENT_REFERENCES} photos are sent per image. Untick some so the ones you want are included.`
                : changed
                  ? "Your selection applies to the key visual, every slide and the video start frame in this panel."
                  : "The brand's default photos are used for the key visual, every slide and the video start frame. Tick others to use them instead."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
