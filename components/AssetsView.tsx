"use client";

import { useRef, useState } from "react";
import { ApiError, api, toApiError } from "./api";
import { ASSET_KIND_OPTIONS, MAX_SENT_REFERENCES, formatBytes, kindLabel } from "./assets";
import { AssetUploader } from "./AssetUploader";
import { useBrandAssetStore, useBrandAssets } from "./BrandAssets";
import type { AssetKind, AssetPatch, BrandAsset, BrandOption } from "./types";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Select, Spinner, TextInput } from "./ui/Field";

function AssetCard({ asset, onPatch, onDelete }: { asset: BrandAsset; onPatch: (patch: AssetPatch) => void; onDelete: () => void }) {
  // The label is edited in place and saved when the field loses focus; null = not editing.
  const [draft, setDraft] = useState<string | null>(null);
  const escaped = useRef(false);
  const commitLabel = () => {
    const cancelled = escaped.current;
    escaped.current = false;
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    // An empty label is not allowed (the server requires 1..200 characters): the old one stays.
    if (!cancelled && next && next !== asset.label) onPatch({ label: next });
  };
  return (
    <article className="card flex min-w-0 flex-col overflow-hidden">
      <div className="relative aspect-square overflow-hidden bg-ink-3">
        {/* The label sits right below in an input, so the image itself is decorative (and a broken one must not spill its alt text). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset.url} alt="" loading="lazy" className="h-full w-full object-contain" />
        <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          {asset.source === "website" ? (
            <span className="rounded-full border border-subtle bg-ink-2/95 px-2 py-0.5 text-[10px] font-medium text-muted" title="Imported from the brand's website">
              from website
            </span>
          ) : (
            <span />
          )}
          {asset.isDefault ? <span className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-semibold text-white">Default</span> : null}
        </div>
      </div>
      <div className="grid gap-2 p-3">
        <Select ariaLabel={`Kind of ${asset.label}`} value={asset.kind} onChange={(v) => onPatch({ kind: v as AssetKind })} options={ASSET_KIND_OPTIONS} className="!py-1.5 text-xs" />
        <TextInput
          value={draft ?? asset.label}
          onChange={setDraft}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              escaped.current = true;
              e.currentTarget.blur();
            }
          }}
          ariaLabel="Label"
          maxLength={200}
          placeholder="Label"
          className="!py-1.5 text-xs"
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-paper/85" title="Sent to the image model for every key visual, slide and video start frame unless a post picks others">
            <input type="checkbox" checked={asset.isDefault} onChange={(e) => onPatch({ isDefault: e.target.checked })} />
            Default
          </label>
          <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
        <div className="text-[10px] leading-snug text-faint">
          {kindLabel(asset.kind)} · {formatBytes(asset.size)}
        </div>
      </div>
    </article>
  );
}

export function AssetsView({
  brands,
  brandSlug,
  onToast,
}: {
  brands: BrandOption[];
  /** The brand chosen in the header selector. */
  brandSlug: string;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const brand = brands.find((b) => b.slug === brandSlug);
  const brandName = brand?.name ?? brandSlug;
  const { assets, status, error, reload } = useBrandAssets(brandSlug);
  const { setItems, reload: reloadBrand } = useBrandAssetStore();
  const [actionError, setActionError] = useState<ApiError | null>(null);
  // Edits in flight per photo: the server's answer is applied only when the last one has landed, so a quick second click is not undone.
  const inflight = useRef<Record<string, number>>({});

  const patchAsset = async (asset: BrandAsset, patch: AssetPatch) => {
    const slug = brandSlug;
    setActionError(null);
    inflight.current[asset.id] = (inflight.current[asset.id] ?? 0) + 1;
    setItems(slug, (prev) => prev.map((a) => (a.id === asset.id ? { ...a, ...patch } : a)));
    try {
      const saved = await api.assets.update(slug, asset.id, patch);
      if (inflight.current[asset.id] === 1) setItems(slug, (prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
    } catch (e) {
      const back: Partial<BrandAsset> = {};
      if (patch.kind !== undefined) back.kind = asset.kind;
      if (patch.label !== undefined) back.label = asset.label;
      if (patch.isDefault !== undefined) back.isDefault = asset.isDefault;
      if (patch.position !== undefined) back.position = asset.position;
      setItems(slug, (prev) => prev.map((a) => (a.id === asset.id ? { ...a, ...back } : a)));
      const err = toApiError(e);
      setActionError(err);
      if (err.status === 404) void reloadBrand(slug, { quiet: true }); // deleted elsewhere: drop it from the list
    } finally {
      inflight.current[asset.id] = Math.max(0, (inflight.current[asset.id] ?? 1) - 1);
    }
  };

  const deleteAsset = async (asset: BrandAsset) => {
    if (!window.confirm(`Delete "${asset.label}"? It will no longer be used as a reference photo.`)) return;
    const slug = brandSlug;
    setActionError(null);
    setItems(slug, (prev) => prev.filter((a) => a.id !== asset.id));
    try {
      await api.assets.remove(slug, asset.id);
      onToast("info", "Photo deleted.");
    } catch (e) {
      const err = toApiError(e);
      if (err.status === 404) {
        void reloadBrand(slug, { quiet: true }); // already gone: nothing to restore
        return;
      }
      setItems(slug, (prev) => [...prev.filter((a) => a.id !== asset.id), asset]);
      setActionError(err);
    }
  };

  const defaults = assets.filter((a) => a.isDefault).length;

  return (
    <section aria-label="Brand assets">
      <div className="mb-4 min-w-0">
        <h1 className="text-2xl font-medium">
          Brand assets <span className="font-normal text-muted">· {brandName}</span>
        </h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
          Photos here are sent to the image model as references. Default photos are used for every key visual, slide and video start frame of this brand; you can also pick
          others per post in Create. Up to {MAX_SENT_REFERENCES} are sent per image.
        </p>
        <p className="mt-1 text-[11px] text-faint">Change the brand with the selector at the top.</p>
      </div>

      <div className="grid gap-5">
        <ErrorBanner error={actionError} title="Could not save the change" onDismiss={() => setActionError(null)} />

        <AssetUploader brandSlug={brandSlug} brandName={brandName} onToast={onToast} />

        <div className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="eyebrow">Photos of {brandName}</div>
            {status === "ready" && assets.length ? (
              <span className="text-[11px] text-muted">
                {assets.length} photo{assets.length === 1 ? "" : "s"} · {defaults} default
              </span>
            ) : null}
          </div>

          {status === "loading" ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> Loading photos…
            </div>
          ) : null}

          {status === "error" ? (
            <div className="grid justify-items-start gap-2">
              <ErrorBanner error={error ?? { message: "Could not load the photos." }} title="Brand assets" className="w-full" />
              <button type="button" className="btn btn-sm" onClick={() => void reload()}>
                Try again
              </button>
            </div>
          ) : null}

          {status === "ready" && !assets.length ? (
            <div className="card px-5 py-8 text-center">
              <div className="text-sm font-semibold">No photos for {brandName} yet</div>
              <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-muted">
                Without reference photos the image model invents the product. Upload the logo, real product photos from several angles, the packaging, the people who appear in
                posts (only with their consent) and a few mood images that show the look you want.
              </p>
            </div>
          ) : null}

          {status === "ready" && defaults > MAX_SENT_REFERENCES ? (
            <p className="text-[11px] text-warn">
              {defaults} photos are set as default, but only {MAX_SENT_REFERENCES} are sent per image (product photos first, then packaging, people, logo, mood). Untick Default on
              the ones you want left out.
            </p>
          ) : null}

          {assets.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(190px,230px))]">
              {assets.map((a) => (
                <AssetCard key={a.id} asset={a} onPatch={(patch) => void patchAsset(a, patch)} onDelete={() => void deleteAsset(a)} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
