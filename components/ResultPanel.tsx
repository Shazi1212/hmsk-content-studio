"use client";

import type { Brief } from "@/lib/types";
import { optionLabel } from "./brief";
import { exportBaseName } from "./download";
import { SelfReviewCard } from "./SelfReviewCard";
import { StrategyCard, formatTokens } from "./StrategyCard";
import type { BrandOption, BusyAction, GenerateResponse, GenerationStatus, ProviderStatus, Voice } from "./types";
import { DownloadMenu } from "./ui/DownloadMenu";
import { ErrorBanner, type BannerError } from "./ui/ErrorBanner";
import { Spinner, TextArea } from "./ui/Field";
import { StatusPill } from "./ui/StatusDot";
import { VariantView } from "./VariantView";

export function ResultPanel({
  result,
  resultKey,
  brandName,
  providers,
  brands,
  voices,
  activeVariant,
  onVariantChange,
  savedId,
  savedStatus,
  busy,
  generating,
  notes,
  onNotesChange,
  onApprove,
  onReject,
  onSaveDraft,
  onDownload,
  onVideoUrl,
  onImageUrl,
  onAudioUrl,
  error,
  onDismissError,
  pendingBrief,
}: {
  result: GenerateResponse | null;
  resultKey: number;
  brandName: string;
  providers: ProviderStatus | null;
  brands: BrandOption[];
  voices: Voice[];
  activeVariant: number;
  onVariantChange: (i: number) => void;
  savedId: string | null;
  savedStatus: GenerationStatus | null;
  busy: BusyAction | null;
  generating: boolean;
  notes: string;
  onNotesChange: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onSaveDraft: () => void;
  onDownload: (kind: "json" | "md") => void;
  onVideoUrl: (url: string) => void;
  onImageUrl: (url: string, provider?: string | null, urls?: string[]) => void;
  onAudioUrl: (url: string) => void;
  error: BannerError | null;
  onDismissError: () => void;
  pendingBrief: Brief;
}) {
  if (!result) {
    return (
      <div className="grid gap-4">
        <ErrorBanner error={error} title="Generation failed" onDismiss={onDismissError} />
        <div className="card flex min-h-[420px] flex-col items-center justify-center p-8 text-center">
          {generating ? (
            <>
              <Spinner className="mb-4 !h-6 !w-6 text-gold" />
              <div className="text-base font-semibold">Briefing the strategist…</div>
              <p className="mt-2 max-w-md text-sm text-muted">
                Pulling {optionLabel("referenceStrategies", pendingBrief.referenceStrategy).toLowerCase()} for {brandName}, building the prompt and waiting for{" "}
                {optionLabel("textProviders", pendingBrief.textProvider).split(" (")[0]}. Larger briefs and three variants take longer.
              </p>
            </>
          ) : (
            <>
              <div className="mb-3 h-2.5 w-2.5 rounded-sm bg-gold" aria-hidden="true" />
              <div className="text-base font-semibold">Your result appears here</div>
              <ol className="mt-3 grid max-w-md gap-1.5 text-left text-sm text-muted">
                <li>1. Pick the brand, platform and post type. The post types adapt to the platform.</li>
                <li>2. Set the strategy and voice, then describe the topic as concretely as you can.</li>
                <li>3. Generate. Review the strategy, variants and self-review; produce voice, video or a key visual.</li>
                <li>4. Approve to save it. Approved posts become references so the next brief does not repeat them.</li>
              </ol>
            </>
          )}
        </div>
      </div>
    );
  }

  const { draft } = result;
  const output = draft.output;
  const brief = draft.brief;
  const variants = output.variants;
  const active = Math.min(activeVariant, variants.length - 1);
  const baseName = exportBaseName(brief);
  const productPhotos = brands.find((b) => b.slug === brief.brandSlug)?.productReferenceCount ?? 0;
  const approved = savedStatus === "approved";
  const usage = result.usage ?? { inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, cacheReadTokens: draft.cacheReadTokens };
  const tokens = formatTokens(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens);
  const took = typeof result.durationMs === "number" ? `${Math.max(1, Math.round(result.durationMs / 1000))} s` : "";

  return (
    <div className="grid min-w-0 gap-4">
      {generating ? (
        <div className="flex items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-sm">
          <Spinner className="text-gold" /> Regenerating… the current result stays visible until the new one arrives.
        </div>
      ) : null}
      <ErrorBanner error={error} title="Something went wrong" onDismiss={onDismissError} />

      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold">{brandName}</span>
          <span className="text-faint">·</span>
          <span className="text-paper/85">{optionLabel("platforms", brief.platform)}</span>
          <span className="text-faint">·</span>
          <span className="text-paper/85">{optionLabel("postTypes", brief.postType).split(" — ")[0]}</span>
          <span className="text-faint">·</span>
          <span className="text-muted">
            {draft.provider}
            {draft.model ? ` / ${draft.model}` : ""}
          </span>
          {tokens ? (
            <>
              <span className="text-faint">·</span>
              <span className="tabular-nums text-muted" title="Summed over the first attempt and any retry">
                {tokens}
                {took ? ` · ${took}` : ""}
              </span>
            </>
          ) : null}
          {draft.provider === "mock" ? (
            <span
              className="rounded-full border border-warn/60 bg-warn/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warn"
              title="Mock strategist output: template text for testing the pipeline. Never used as a reference for real generations."
            >
              mock
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={savedStatus} />
          {savedId ? (
            <span className="text-[11px] text-faint" title={savedId}>
              #{savedId.slice(-6)}
            </span>
          ) : null}
        </div>
      </div>

      <StrategyCard
        strategy={output.strategy}
        references={result.references}
        priorApproved={result.priorApproved}
        repetition={result.repetition}
        retrievalNotes={result.retrievalNotes}
        lint={result.lint}
        safety={result.safety}
        warnings={result.warnings}
        repaired={result.repaired}
      />

      {variants.length > 1 ? (
        <div role="tablist" aria-label="Variants" className="flex min-w-0 gap-1 rounded-lg border border-subtle bg-ink-2 p-1">
          {variants.map((v, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => onVariantChange(i)}
              className={`min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-sm transition-colors ${
                i === active ? "bg-ink-3 font-semibold text-paper" : "text-muted hover:text-paper"
              }`}
              title={v.title}
            >
              Variant {i + 1}
              {v.title ? <span className="hidden font-normal text-muted sm:inline"> · {v.title}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {variants.map((v, i) => (
        <VariantView
          key={`${resultKey}-${i}`}
          variant={v}
          index={i}
          brief={brief}
          hidden={i !== active}
          providers={providers}
          productPhotos={productPhotos}
          voices={voices}
          baseName={baseName}
          onVideoUrl={onVideoUrl}
          onImageUrl={onImageUrl}
          onAudioUrl={onAudioUrl}
          initialVideoUrl={i === 0 ? draft.videoUrl : null}
          initialImageUrl={i === 0 ? draft.imageUrl : null}
          initialImageUrls={i === 0 ? draft.imageUrls : null}
          initialAudioUrl={i === 0 ? draft.audioUrl : null}
        />
      ))}

      <SelfReviewCard review={output.selfReview} />

      <section className="card grid gap-3 p-4 sm:p-5">
        <div className="eyebrow">Decision</div>
        <TextArea value={notes} onChange={onNotesChange} rows={2} maxLength={2000} placeholder="Notes for the record (optional): what you changed, why it was approved, where it was posted…" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={onApprove} disabled={busy !== null || generating || approved}>
            {busy === "approve" ? <Spinner /> : null}
            {approved ? "Approved" : "Approve & save"}
          </button>
          {!approved ? (
            <button type="button" className="btn" onClick={onSaveDraft} disabled={busy !== null || generating || savedStatus === "draft"}>
              {busy === "draft" ? <Spinner /> : null}
              {savedStatus === "draft" ? "Draft saved" : "Save as draft"}
            </button>
          ) : null}
          <DownloadMenu onDownload={onDownload} align="left" />
          <button type="button" className="btn btn-danger ml-auto" onClick={onReject} disabled={busy !== null || generating}>
            {busy === "reject" ? <Spinner /> : null}
            {savedId ? "Reject" : "Discard"}
          </button>
        </div>
        <p className="text-[11px] text-muted">
          {draft.provider === "mock"
            ? "Mock output can be saved for testing the flow, but it is never shown to the strategist as a reference. "
            : "Approved generations are stored with their brief, prompts and output; the next brief for this brand sees them and steers away from the same hooks and angles. "}
          Downloads are built in the browser and do not need a save.
        </p>
      </section>
    </div>
  );
}
