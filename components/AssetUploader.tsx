"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, toApiError } from "./api";
import { ASSET_KIND_OPTIONS, formatBytes } from "./assets";
import { useBrandAssetStore } from "./BrandAssets";
import { ACCEPTED_TYPES, MAX_SOURCE_BYTES, prepareImage, type PreparedImage } from "./imagePrep";
import type { AssetKind } from "./types";
import { Select, Spinner, TextInput } from "./ui/Field";

type Pending = {
  key: string;
  /** The brand this file was added for; it stays that brand's upload if the header selector changes meanwhile. */
  brandSlug: string;
  file: File;
  /** Object URL of the original file, for the preview only; revoked when the row goes away. */
  previewUrl: string;
  /** Null while preparing, and for good when the file could not be read. */
  prepared: PreparedImage | null;
  phase: "preparing" | "ready" | "uploading";
  kind: AssetKind;
  label: string;
  isDefault: boolean;
  /** Once the user touched the checkbox, changing the kind no longer flips it. */
  defaultTouched: boolean;
  error: string | null;
};

const LABEL_PLACEHOLDER = "What is in the photo, e.g. coffee bag front, cup on a wooden table";
const FILE_ACCEPT = ACCEPTED_TYPES.join(",");

let counter = 0;
const nextKey = () => `pending-${Date.now()}-${++counter}`;

function PendingRow({
  item,
  onChange,
  onKind,
  onUpload,
  onRemove,
  disabled,
}: {
  item: Pending;
  onChange: (patch: Partial<Pending>) => void;
  onKind: (kind: AssetKind) => void;
  onUpload: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const busy = item.phase === "uploading";
  const unusable = item.phase === "ready" && !item.prepared;
  const sizeNote = item.prepared
    ? item.prepared.changed
      ? `${formatBytes(item.prepared.blob.size)} after scaling to ${item.prepared.width}×${item.prepared.height} (was ${formatBytes(item.file.size)})`
      : `${formatBytes(item.prepared.blob.size)}, ${item.prepared.width}×${item.prepared.height}, uploaded as it is`
    : item.phase === "preparing"
      ? "Scaling in the browser…"
      : "";
  return (
    <div className="card grid gap-3 p-3 sm:grid-cols-[88px_minmax(0,1fr)]">
      <div className="flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-lg border border-subtle bg-ink-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.previewUrl} alt="" className="h-full w-full object-contain" />
      </div>
      <div className="grid min-w-0 gap-2.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium text-paper" title={item.file.name}>
              {item.file.name}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
              {item.phase === "preparing" ? <Spinner className="!h-3 !w-3" /> : null}
              <span>{sizeNote}</span>
            </div>
          </div>
          <button type="button" className="btn btn-sm btn-ghost shrink-0" onClick={onRemove} disabled={busy} aria-label={`Remove ${item.file.name} from the queue`}>
            Remove
          </button>
        </div>

        <div className="grid gap-2.5 md:grid-cols-[170px_minmax(0,1fr)]">
          <Select ariaLabel={`Kind of ${item.file.name}`} value={item.kind} onChange={(v) => onKind(v as AssetKind)} options={ASSET_KIND_OPTIONS} disabled={busy || unusable} />
          <TextInput
            value={item.label}
            onChange={(v) => onChange({ label: v, error: null })}
            placeholder={LABEL_PLACEHOLDER}
            maxLength={200}
            disabled={busy || unusable}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-paper/85">
            <input
              type="checkbox"
              checked={item.isDefault}
              onChange={(e) => onChange({ isDefault: e.target.checked, defaultTouched: true })}
              disabled={busy || unusable}
            />
            Use by default
          </label>
          <button type="button" className="btn btn-sm btn-primary" onClick={onUpload} disabled={disabled || busy || !item.prepared || item.phase !== "ready"}>
            {busy ? <Spinner /> : null}
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
        {item.error ? (
          <p role="alert" className="text-xs text-danger">
            {item.error}
          </p>
        ) : null}
        {unusable && !item.error ? <p className="text-xs text-danger">This file could not be prepared.</p> : null}
      </div>
    </div>
  );
}

export function AssetUploader({
  brandSlug,
  brandName,
  onToast,
}: {
  brandSlug: string;
  brandName: string;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const store = useBrandAssetStore();
  const { setItems, reload } = store;
  const [items, setList] = useState<Pending[]>([]);
  const itemsRef = useRef<Pending[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadingAll, setUploadingAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Revoke the preview URLs of whatever is still queued when the tab goes away.
  useEffect(() => {
    return () => {
      for (const p of itemsRef.current) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  const patch = useCallback((key: string, partial: Partial<Pending>) => {
    setList((prev) => prev.map((p) => (p.key === key ? { ...p, ...partial } : p)));
  }, []);

  const drop = useCallback((key: string) => {
    const p = itemsRef.current.find((x) => x.key === key);
    if (p) URL.revokeObjectURL(p.previewUrl);
    setList((prev) => prev.filter((x) => x.key !== key));
  }, []);

  const addFiles = (incoming: File[]) => {
    const skipped: string[] = [];
    const accepted: File[] = [];
    for (const f of incoming) {
      if (!ACCEPTED_TYPES.includes(f.type)) skipped.push(`${f.name} (not PNG, JPEG or WebP)`);
      else if (f.size > MAX_SOURCE_BYTES) skipped.push(`${f.name} (over 50 MB)`);
      else accepted.push(f);
    }
    setNotice(skipped.length ? `Skipped: ${skipped.join(", ")}.` : null);
    if (!accepted.length) return;
    const added: Pending[] = accepted.map((file) => ({
      key: nextKey(),
      brandSlug,
      file,
      previewUrl: URL.createObjectURL(file),
      prepared: null,
      phase: "preparing",
      kind: "product",
      label: "",
      isDefault: true,
      defaultTouched: false,
      error: null,
    }));
    setList((prev) => [...prev, ...added]);
    // One file at a time: decoding several large photos at once can exhaust the memory of a phone.
    for (const p of added) {
      queue.current = queue.current.then(async () => {
        try {
          patch(p.key, { prepared: await prepareImage(p.file), phase: "ready" });
        } catch (e) {
          patch(p.key, { phase: "ready", error: e instanceof Error ? e.message : "This file could not be prepared." });
        }
      });
    }
  };

  const changeKind = (key: string, kind: AssetKind) => {
    const p = itemsRef.current.find((x) => x.key === key);
    patch(key, { kind, ...(p && !p.defaultTouched ? { isDefault: kind !== "mood" } : {}) });
  };

  const uploadOne = async (key: string): Promise<boolean> => {
    const p = itemsRef.current.find((x) => x.key === key);
    if (!p || !p.prepared || p.phase !== "ready") return false;
    const label = p.label.trim();
    if (!label) {
      patch(key, { error: "Add a label that says what is in the photo." });
      return false;
    }
    patch(key, { phase: "uploading", error: null });
    try {
      const asset = await api.assets.upload(p.brandSlug, { file: p.prepared.blob, filename: p.prepared.filename, kind: p.kind, label, isDefault: p.isDefault });
      setItems(p.brandSlug, (prev) => [...prev.filter((a) => a.id !== asset.id), asset]);
      drop(key);
      return true;
    } catch (e) {
      patch(key, { phase: "ready", error: toApiError(e).message });
      return false;
    }
  };

  const uploadSingle = async (key: string) => {
    const p = itemsRef.current.find((x) => x.key === key);
    if (!(await uploadOne(key)) || !p) return;
    void reload(p.brandSlug, { quiet: true }); // pick up positions and defaults as the server stored them
    onToast("success", "Photo uploaded.");
  };

  const mine = items.filter((p) => p.brandSlug === brandSlug);
  const readyKeys = mine.filter((p) => p.phase === "ready" && p.prepared).map((p) => p.key);

  const uploadAll = async () => {
    setUploadingAll(true);
    let ok = 0;
    for (const key of readyKeys) if (await uploadOne(key)) ok++;
    if (ok) void reload(brandSlug, { quiet: true });
    setUploadingAll(false);
    const failed = readyKeys.length - ok;
    if (ok) onToast("success", `${ok} photo${ok === 1 ? "" : "s"} uploaded to ${brandName}.${failed ? ` ${failed} need${failed === 1 ? "s" : ""} attention.` : ""}`);
    else if (failed) onToast("error", "No photo was uploaded. Check the messages below each photo.");
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="grid gap-3">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${dragging ? "border-gold bg-tint" : "border-line bg-ink-2"}`}
      >
        <div className="text-sm font-semibold">Drop photos here</div>
        <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-muted">
          PNG, JPEG or WebP. Each photo is scaled down in your browser (long edge 1600 px, about 1.5 MB at most) before it is uploaded to {brandName}.
        </p>
        <button type="button" className="btn mt-3" onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={FILE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose photos to upload"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {notice ? (
        <p role="status" className="text-xs text-warn">
          {notice}
        </p>
      ) : null}

      {mine.length ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="eyebrow">Ready to upload ({mine.length})</div>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void uploadAll()} disabled={uploadingAll || !readyKeys.length}>
              {uploadingAll ? <Spinner /> : null}
              {uploadingAll ? "Uploading…" : "Upload all"}
            </button>
          </div>
          {mine.map((p) => (
            <PendingRow
              key={p.key}
              item={p}
              onChange={(partial) => patch(p.key, partial)}
              onKind={(kind) => changeKind(p.key, kind)}
              onUpload={() => void uploadSingle(p.key)}
              onRemove={() => drop(p.key)}
              disabled={uploadingAll}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
