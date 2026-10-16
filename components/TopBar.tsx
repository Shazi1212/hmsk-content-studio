"use client";

import type { BrandOption, BusyAction, GenerationStatus, ProviderStatus, StudioView } from "./types";
import { Spinner } from "./ui/Field";
import { StatusDot } from "./ui/StatusDot";
import { DownloadMenu } from "./ui/DownloadMenu";

const VIEW_TABS: { id: StudioView; label: string }[] = [
  { id: "create", label: "Create" },
  { id: "ideas", label: "Ideas" },
  { id: "brands", label: "Brands" },
  { id: "assets", label: "Brand assets" },
  { id: "research", label: "Research data" },
];

export function TopBar({
  view,
  onViewChange,
  brands,
  brandSlug,
  onBrandChange,
  providers,
  hasResult,
  savedStatus,
  busy,
  generating,
  onApprove,
  onDownload,
  onRegenerate,
  onToggleHistory,
  historyOpen,
  onLogout,
}: {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  brands: BrandOption[];
  brandSlug: string;
  onBrandChange: (slug: string) => void;
  providers: ProviderStatus | null;
  hasResult: boolean;
  savedStatus: GenerationStatus | null;
  busy: BusyAction | null;
  generating: boolean;
  onApprove: () => void;
  onDownload: (kind: "json" | "md") => void;
  onRegenerate: () => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
  onLogout: () => void;
}) {
  const textConfigured = providers ? Object.values(providers.text).filter((t) => t.configured).length : 0;
  const textTotal = providers ? Object.keys(providers.text).length : 0;
  const textTitle = providers
    ? Object.entries(providers.text)
        .map(([id, t]) => `${id}: ${t.configured ? `ready${t.model ? ` (${t.model})` : ""}` : t.note || "not configured"}`)
        .join("\n")
    : "Loading provider status";
  const approved = savedStatus === "approved";

  return (
    <header className="sticky top-0 z-30 border-b border-subtle bg-ink/85 backdrop-blur supports-[backdrop-filter]:bg-ink/70">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-gold" aria-hidden="true" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Content</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted">Studio</div>
          </div>
        </div>

        <div role="tablist" aria-label="Views" className="flex items-center gap-0.5 rounded-lg border border-subtle bg-ink-2 p-0.5">
          {VIEW_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              onClick={() => onViewChange(t.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${view === t.id ? "bg-ink-3 text-paper" : "text-muted hover:text-paper"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {view === "create" || view === "assets" ? (
          <div className="flex items-center gap-2">
            <label htmlFor="topbar-brand" className="sr-only">
              Brand
            </label>
            <select
              id="topbar-brand"
              className="ctl !w-auto max-w-[min(58vw,20rem)] truncate !py-1.5 text-xs"
              value={brandSlug}
              onChange={(e) => onBrandChange(e.target.value)}
              disabled={!brands.length}
            >
              {brands.length ? (
                brands.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.name}
                  </option>
                ))
              ) : (
                <option value="">Loading brands…</option>
              )}
            </select>
          </div>
        ) : null}

        <div className="hidden items-center gap-1.5 md:flex" aria-label="Provider status">
          <StatusDot ok={textConfigured > 0} label={`Text ${textConfigured}/${textTotal}`} title={textTitle} />
          <StatusDot
            ok={!!providers?.audio.elevenlabs.configured}
            label="Audio"
            title={providers?.audio.elevenlabs.configured ? "ElevenLabs ready" : "ElevenLabs: set ELEVENLABS_API_KEY"}
          />
          <StatusDot
            ok={!!providers?.video.higgsfield.configured}
            label="Video"
            title={providers?.video.higgsfield.configured ? "Higgsfield ready" : "Higgsfield: set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET"}
          />
          <StatusDot
            ok={!!providers?.ideas?.configured}
            label="Ideas"
            title={providers?.ideas?.configured ? `Ideas model ready${providers.ideas.model ? ` (${providers.ideas.model})` : ""}` : providers?.ideas?.note || "Ideas model: set IDEAS_LLM_BASE_URL"}
          />
          <StatusDot
            ok={!!providers?.image.configured}
            label="Image"
            title={providers?.image.configured ? `${providers.image.provider === "gemini" ? "Gemini" : "OpenAI"} image ready${providers.image.model ? ` (${providers.image.model})` : ""}` : providers?.image.note || "Image model: set OPENAI_API_KEY"}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={`btn btn-sm ${historyOpen ? "border-gold/50 text-gold-ink" : ""}`} onClick={onToggleHistory} aria-pressed={historyOpen}>
            History
          </button>
          {view === "create" && hasResult ? (
            <>
              <button type="button" className="btn btn-sm hidden sm:inline-flex" onClick={onRegenerate} disabled={generating || busy !== null}>
                {generating ? <Spinner /> : null}
                Regenerate
              </button>
              <DownloadMenu size="sm" onDownload={onDownload} />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onApprove}
                disabled={busy !== null || generating || approved}
                title={approved ? "This generation is already approved" : "Approve and save to history"}
              >
                {busy === "approve" ? <Spinner /> : null}
                {approved ? "Approved" : "Approve"}
              </button>
            </>
          ) : null}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onLogout} title="Sign out">
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
