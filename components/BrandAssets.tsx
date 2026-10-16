"use client";

/**
 * One shared cache of the brands' reference photos. The Brand assets tab edits it, the Create view's reference picker reads
 * it, so a change in the tab shows up in Create at once. Each brand is fetched once, on first use.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, toApiError } from "./api";
import { sortAssets } from "./assets";
import type { BrandAsset } from "./types";

export type AssetsStatus = "idle" | "loading" | "ready" | "error";
type Entry = { items: BrandAsset[]; status: AssetsStatus; error: ApiError | null };

export type BrandAssetStore = {
  entries: Record<string, Entry>;
  /** Fetches a brand's photos unless that already happened. */
  ensure: (slug: string) => void;
  /** Fetches again; `quiet` keeps the current list on screen meanwhile. */
  reload: (slug: string, opts?: { quiet?: boolean }) => Promise<void>;
  /** Changes a brand's loaded list (optimistic updates, results of uploads); ignored until that list has loaded. */
  setItems: (slug: string, updater: (prev: BrandAsset[]) => BrandAsset[]) => void;
  /** Switches the studio to the Brand assets tab. */
  openManager: () => void;
};

const StoreContext = createContext<BrandAssetStore | null>(null);
const NO_ASSETS: BrandAsset[] = [];

export function BrandAssetsProvider({ onManage, children }: { onManage: () => void; children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const requested = useRef(new Set<string>());
  const generation = useRef<Record<string, number>>({});

  const load = useCallback(async (slug: string) => {
    const mine = (generation.current[slug] = (generation.current[slug] ?? 0) + 1);
    try {
      const items = await api.assets.list(slug);
      if (generation.current[slug] !== mine) return;
      setEntries((prev) => ({ ...prev, [slug]: { items: sortAssets(items), status: "ready", error: null } }));
    } catch (e) {
      if (generation.current[slug] !== mine) return;
      setEntries((prev) => ({ ...prev, [slug]: { items: prev[slug]?.items ?? NO_ASSETS, status: "error", error: toApiError(e) } }));
    }
  }, []);

  const ensure = useCallback(
    (slug: string) => {
      if (requested.current.has(slug)) return;
      requested.current.add(slug);
      void load(slug);
    },
    [load],
  );

  const reload = useCallback(
    (slug: string, opts?: { quiet?: boolean }) => {
      requested.current.add(slug);
      if (!opts?.quiet) {
        setEntries((prev) => {
          const e = prev[slug];
          return e ? { ...prev, [slug]: { ...e, status: "loading", error: null } } : prev;
        });
      }
      return load(slug);
    },
    [load],
  );

  const setItems = useCallback((slug: string, updater: (prev: BrandAsset[]) => BrandAsset[]) => {
    setEntries((prev) => {
      const e = prev[slug];
      if (!e || e.status !== "ready") return prev;
      return { ...prev, [slug]: { ...e, items: sortAssets(updater(e.items)) } };
    });
  }, []);

  const value = useMemo<BrandAssetStore>(() => ({ entries, ensure, reload, setItems, openManager: onManage }), [entries, ensure, reload, setItems, onManage]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** The whole store, for code that works on a brand other than the one on screen (an upload that finishes after a brand switch). */
export function useBrandAssetStore(): BrandAssetStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useBrandAssetStore must be used inside <BrandAssetsProvider>.");
  return store;
}

/** The photos of one brand; the first use of a brand triggers its fetch. */
export function useBrandAssets(slug: string) {
  const store = useBrandAssetStore();
  const { ensure } = store;
  useEffect(() => {
    if (slug) ensure(slug);
  }, [slug, ensure]);
  const entry = slug ? store.entries[slug] : undefined;
  return {
    assets: entry?.items ?? NO_ASSETS,
    /** "loading" covers the time before the first answer arrives. */
    status: (slug ? (entry?.status ?? "loading") : "idle") as AssetsStatus,
    error: entry?.error ?? null,
    reload: () => store.reload(slug),
    openManager: store.openManager,
  };
}
