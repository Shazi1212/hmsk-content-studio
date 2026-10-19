"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BriefSchema, type Brief } from "@/lib/types";
import type { Idea } from "@/lib/ideas/types";
import { checkLanguageSafety } from "@/lib/language-safety";
import { ApiError, api, toApiError } from "./api";
import { AssetsView } from "./AssetsView";
import { BrandAssetsProvider } from "./BrandAssets";
import { BrandsView } from "./BrandsView";
import { BriefForm } from "./BriefForm";
import { CUSTOM_PILLAR, DEFAULT_BRIEF, normalizeBrief } from "./brief";
import { downloadJson, downloadMarkdown } from "./download";
import { HistoryDrawer } from "./HistoryDrawer";
import { IdeasView, type IdeaOrigin } from "./IdeasView";
import { ResearchView } from "./ResearchView";
import { ResultPanel } from "./ResultPanel";
import { CRITICAL_LINT } from "./StrategyCard";
import { loadHistoryFilter, loadStoredBrief, saveHistoryFilter, saveStoredBrief, type HistoryFilter } from "./storage";
import { TopBar } from "./TopBar";
import type { BusyAction, DraftGeneration, GenerateResponse, GenerationStatus, HistoryItem, OptionsResponse, StudioView, ToastKind, ToastMessage, Voice } from "./types";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Spinner } from "./ui/Field";
import { ToastStack } from "./ui/Toast";

const TOAST_MS = 4200;

export default function ContentStudio() {
  const router = useRouter();
  const [options, setOptions] = useState<OptionsResponse | null>(null);
  const optionsRef = useRef<OptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<ApiError | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);

  // The Create view stays mounted while another tab is open (an in-progress voice-over or video must survive a tab
  // switch); the Ideas, Brand assets and Research views mount on their first visit and then stay too, so a running
  // brainstorm, queued uploads, their filters and scroll persist.
  const [view, setView] = useState<StudioView>("create");
  const [ideasOpened, setIdeasOpened] = useState(false);
  const [assetsOpened, setAssetsOpened] = useState(false);
  const [researchOpened, setResearchOpened] = useState(false);
  const [brandsOpened, setBrandsOpened] = useState(false);
  const changeView = useCallback((next: StudioView) => {
    setView(next);
    if (next === "brands") setBrandsOpened(true);
    if (next === "ideas") setIdeasOpened(true);
    if (next === "assets") setAssetsOpened(true);
    if (next === "research") setResearchOpened(true);
  }, []);
  /** "Manage" in the Create view's reference photos row. */
  const openAssets = useCallback(() => {
    changeView("assets");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [changeView]);

  const [brief, setBrief] = useState<Brief>(DEFAULT_BRIEF);
  const briefReady = useRef(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [resultKey, setResultKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<ApiError | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<GenerationStatus | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>({ brandSlug: "", status: "" });
  const historyFilterRef = useRef(historyFilter);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);

  const pushToast = useCallback((kind: ToastKind, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  /* ---------------- bootstrap: options, stored brief, voices ---------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await api.options();
        if (cancelled) return;
        if (!opts || !Array.isArray(opts.brands) || !opts.options || !opts.providers) {
          throw new ApiError("The options endpoint returned an unexpected shape.", 500, "Check GET /api/options.");
        }
        optionsRef.current = opts;
        setOptions(opts);
        setBrief(normalizeBrief(loadStoredBrief() ?? {}, opts.brands, opts.providers));
        briefReady.current = true;
        const f = loadHistoryFilter();
        if (f) {
          setHistoryFilter(f);
          historyFilterRef.current = f;
        }
        if (opts.elevenlabsVoices?.length) setVoices(opts.elevenlabsVoices);
        else if (opts.providers.audio.elevenlabs.configured) {
          api
            .voices()
            .then((v) => {
              if (!cancelled) setVoices(v);
            })
            .catch(() => {
              /* voices are optional; the default voice id still works */
            });
        }
      } catch (e) {
        if (!cancelled) setOptionsError(toApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (briefReady.current) saveStoredBrief(brief);
  }, [brief]);

  /** After a brand was created, edited or deleted in the Brands tab: reload the catalog and keep the brief consistent. */
  const reloadOptions = useCallback(async (selectSlug: string | null) => {
    try {
      const opts = await api.options();
      optionsRef.current = opts;
      setOptions(opts);
      setBrief((b) => normalizeBrief(selectSlug ? { ...b, brandSlug: selectSlug } : b, opts.brands, opts.providers));
    } catch (e) {
      setOptionsError(toApiError(e));
    }
  }, []);

  // Back from a platform's consent screen: /api/connect/<platform>/callback redirects to /?connect=<result>&platform=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const result = q.get("connect");
    if (!result) return;
    const platform = q.get("platform") ?? "";
    const label = platform === "instagram" ? "Instagram" : platform === "tiktok" ? "TikTok" : platform;
    const handle = q.get("handle") ?? "";
    const reason = q.get("reason") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    // No cleanup on purpose: React StrictMode (dev) runs this effect twice and the second run no longer sees the parameters.
    window.setTimeout(() => {
      changeView("research");
      if (result === "ok") pushToast("success", `${label}${handle ? ` ${platform === "instagram" ? "@" : ""}${handle}` : ""} connected. The first sync is running; its posts appear under Research data.`);
      else if (result === "denied") pushToast("info", `${label} connection cancelled${reason ? `: ${reason}` : "."}`);
      else pushToast("error", `${label} connection failed${reason ? `: ${reason}` : "."}`);
    }, 0);
  }, [changeView, pushToast]);

  const updateBrief = useCallback((patch: Partial<Brief>) => {
    setBrief((prev) => {
      const next: Brief = { ...prev, ...patch };
      const opts = optionsRef.current;
      if (patch.brandSlug && patch.brandSlug !== prev.brandSlug && opts) {
        const b = opts.brands.find((x) => x.slug === patch.brandSlug);
        if (b) {
          next.pillar = b.pillars[0] ?? CUSTOM_PILLAR;
          next.audience = "";
        }
      }
      return opts ? normalizeBrief(next, opts.brands, opts.providers) : next;
    });
    setValidationError(null);
  }, []);

  /** "Use in Create": loads an idea into the brief and switches to the Create tab; the strategist writes it on Generate. */
  const useIdea = useCallback(
    (idea: Idea, origin: IdeaOrigin) => {
      // Two steps: switching the brand resets the pillar, so the rest of the brief is patched afterwards.
      updateBrief({ brandSlug: origin.brandSlug });
      const pillar = idea.pillar || origin.pillar;
      updateBrief({
        platform: origin.platform,
        ...(idea.format ? { postType: idea.format } : {}),
        ...(pillar ? { pillar } : {}),
        ...(origin.goal !== "any" ? { goal: origin.goal } : {}),
        language: origin.language,
        ...(idea.hookType ? { hookType: idea.hookType } : {}),
        topic: [`Hook idea: ${idea.hook}`, idea.angle && `Angle: ${idea.angle}`].filter(Boolean).join("\n").slice(0, 2000),
      } as Partial<Brief>);
      changeView("create");
      pushToast("success", "Idea loaded into the brief. Check it and press Generate.");
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [updateBrief, changeView, pushToast],
  );

  const scrollToResult = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  /* ---------------- generate ---------------- */
  const runGenerate = useCallback(async () => {
    const parsed = BriefSchema.safeParse(brief);
    if (!parsed.success) {
      setValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "brief"}: ${i.message}`).join("; "));
      return;
    }
    const b = parsed.data;
    if (b.pillar === CUSTOM_PILLAR && !b.topic.trim()) {
      setValidationError("Name the custom pillar or describe the topic so the strategist has something to work with.");
      return;
    }
    if (b.postType === "blog_to_social" && !b.sourceText.trim()) {
      setValidationError("Paste the source article (or its URL) to repurpose it.");
      return;
    }
    setValidationError(null);
    setGenerating(true);
    setGenError(null);
    try {
      const res = await api.generate(b);
      if (!res?.draft?.output?.variants?.length) {
        throw new ApiError("The strategist returned no variants.", 502, "Try again, or switch the text provider.", res?.raw);
      }
      setResult({
        ...res,
        references: Array.isArray(res.references) ? res.references : [],
        priorApproved: Array.isArray(res.priorApproved) ? res.priorApproved : [],
        repetition: res.repetition ?? { warnings: [], maxSimilarity: 0 },
      });
      setResultKey((k) => k + 1);
      setActiveVariant(0);
      setSavedId(null);
      setSavedStatus(null);
      setNotes("");
      const repWarn = res.repetition?.warnings?.length ?? 0;
      const critical = (res.lint ?? []).filter((w) => CRITICAL_LINT.test(w)).length;
      const truncated = (res.warnings ?? []).some((w) => w.startsWith("truncated_output"));
      if (truncated) pushToast("error", "The model hit its output limit; parts of the result may be incomplete (see Quality lint).");
      if (critical) pushToast("error", `Compliance lint flagged ${critical} finding${critical > 1 ? "s" : ""}; review before approving.`);
      else if (repWarn) pushToast("info", `Generated with ${repWarn} repetition warning${repWarn > 1 ? "s" : ""}.`);
      scrollToResult();
    } catch (e) {
      const err = toApiError(e);
      setGenError(err);
      pushToast("error", err.message);
    } finally {
      setGenerating(false);
    }
  }, [brief, pushToast, scrollToResult]);

  /* ---------------- history ---------------- */
  const loadHistory = useCallback(async (filter: HistoryFilter = historyFilterRef.current) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items = await api.listGenerations({ brandSlug: filter.brandSlug || undefined, status: filter.status || undefined, limit: 50 });
      setHistory(items.filter((i) => i && typeof i.id === "string"));
    } catch (e) {
      setHistoryError(toApiError(e));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      if (!open) void loadHistory();
      return !open;
    });
  }, [loadHistory]);

  const changeHistoryFilter = useCallback(
    (f: HistoryFilter) => {
      setHistoryFilter(f);
      historyFilterRef.current = f;
      saveHistoryFilter(f);
      void loadHistory(f);
    },
    [loadHistory],
  );

  /* ---------------- persist / approve / reject ---------------- */
  const persist = useCallback(
    async (status: "draft" | "approved") => {
      if (!result) return;
      if (status === "approved") {
        // Gate 1: mock output is template text; it is saved but excluded from future references (server side).
        if (result.draft.provider === "mock") {
          const ok = window.confirm("This is mock output (no real strategist). Approve anyway? It will be saved for testing but never used as a reference for future generations.");
          if (!ok) return;
        }
        // Gate 2: compliance lint (health-claim terms, forbidden strings) needs a deliberate yes.
        const critical = (result.lint ?? []).filter((w) => CRITICAL_LINT.test(w));
        if (critical.length) {
          const ok = window.confirm(
            `The compliance lint flagged ${critical.length} finding${critical.length > 1 ? "s" : ""}:\n\n${critical.slice(0, 6).join("\n")}${critical.length > 6 ? "\n…" : ""}\n\nApprove anyway?`,
          );
          if (!ok) return;
        }
      }
      setBusy(status === "approved" ? "approve" : "draft");
      setGenError(null);
      try {
        let saved: HistoryItem | undefined;
        if (savedId) saved = await api.patchGeneration(savedId, { status, notes: notes || undefined });
        else saved = await api.saveGeneration(result.draft, status, notes);
        const id = saved?.id ?? savedId;
        if (!id) throw new ApiError("Saved, but the server did not return an id.", 500);
        setSavedId(id);
        setSavedStatus(status);
        pushToast(
          "success",
          status !== "approved"
            ? "Saved as draft."
            : result.draft.provider === "mock"
              ? "Approved and saved (mock output is never used as a reference)."
              : "Approved and saved. Future briefs for this brand will reference it.",
        );
        if (historyOpen) void loadHistory();
      } catch (e) {
        const err = toApiError(e);
        setGenError(err);
        pushToast("error", err.message);
      } finally {
        setBusy(null);
      }
    },
    [result, savedId, notes, pushToast, historyOpen, loadHistory],
  );

  const reject = useCallback(async () => {
    if (!result) return;
    const ok = window.confirm(savedId ? "Mark this generation as rejected and clear it from the panel?" : "Discard this result? It has not been saved.");
    if (!ok) return;
    setBusy("reject");
    try {
      if (savedId) await api.patchGeneration(savedId, { status: "rejected", notes: notes || undefined });
      setResult(null);
      setSavedId(null);
      setSavedStatus(null);
      setNotes("");
      setGenError(null);
      pushToast("info", savedId ? "Marked as rejected." : "Result discarded.");
      if (savedId && historyOpen) void loadHistory();
    } catch (e) {
      const err = toApiError(e);
      setGenError(err);
      pushToast("error", err.message);
    } finally {
      setBusy(null);
    }
  }, [result, savedId, notes, pushToast, historyOpen, loadHistory]);

  const onVideoUrl = useCallback(
    (url: string) => {
      setResult((prev) => (prev ? { ...prev, draft: { ...prev.draft, videoUrl: url, videoProvider: "higgsfield" } } : prev));
      if (savedId) {
        api.patchGeneration(savedId, { videoUrl: url }).catch((e) => pushToast("error", `Video ready, but saving its URL failed: ${toApiError(e).message}`));
      }
      pushToast("success", "Video ready.");
    },
    [savedId, pushToast],
  );

  // Hosted key visual / voice-over (the app hosts them itself, lib/media.ts): attach to the draft so an
  // approve stores them, and patch the saved row when the result was already saved.
  const onImageUrl = useCallback(
    (url: string, provider?: string | null, urls?: string[]) => {
      const all = urls && urls.length ? urls : undefined;
      setResult((prev) => (prev ? { ...prev, draft: { ...prev.draft, imageUrl: url, imageUrls: all ?? prev.draft.imageUrls ?? null, imageProvider: provider || null } } : prev));
      if (savedId) {
        api.patchGeneration(savedId, { imageUrl: url, imageUrls: all, imageProvider: provider || undefined }).catch((e) => pushToast("error", `Key visual hosted, but saving its URL failed: ${toApiError(e).message}`));
      }
    },
    [savedId, pushToast],
  );

  const onAudioUrl = useCallback(
    (url: string) => {
      setResult((prev) => (prev ? { ...prev, draft: { ...prev.draft, audioUrl: url, audioProvider: "elevenlabs" } } : prev));
      if (savedId) {
        api.patchGeneration(savedId, { audioUrl: url }).catch((e) => pushToast("error", `Voice-over hosted, but saving its URL failed: ${toApiError(e).message}`));
      }
    },
    [savedId, pushToast],
  );

  const brandNameFor = useCallback((slug: string) => options?.brands.find((b) => b.slug === slug)?.name ?? slug, [options]);

  const download = useCallback(
    (kind: "json" | "md") => {
      if (!result) return;
      const extra = { savedId, brandName: brandNameFor(result.draft.brief.brandSlug) };
      if (kind === "json") downloadJson(result, result.draft.brief, extra);
      else downloadMarkdown(result, result.draft.brief, extra);
    },
    [result, savedId, brandNameFor],
  );

  const openHistoryItem = useCallback(
    (item: HistoryItem) => {
      const opts = optionsRef.current;
      if (!item.output?.variants?.length || !item.output.strategy || !item.output.selfReview) {
        pushToast("error", "This entry has no readable output.");
        return;
      }
      const itemBrief = item.brief && opts ? normalizeBrief(item.brief, opts.brands, opts.providers) : brief;
      const draft: DraftGeneration = {
        brandId: item.brandId ?? "",
        platform: item.platform,
        postType: item.postType,
        status: item.status,
        brief: itemBrief,
        systemPrompt: item.systemPrompt ?? "",
        userPrompt: item.userPrompt ?? "",
        provider: item.provider ?? "",
        model: item.model ?? null,
        output: item.output,
        outputText: item.outputText ?? "",
        referenceIds: item.referenceIds ?? [],
        priorGenIds: item.priorGenIds ?? [],
        audioUrl: item.audioUrl ?? null,
        videoUrl: item.videoUrl ?? null,
        imageUrl: item.imageUrl ?? null,
        imageUrls: item.imageUrls ?? null,
        score: item.score ?? null,
        inputTokens: item.inputTokens ?? null,
        outputTokens: item.outputTokens ?? null,
        cacheReadTokens: item.cacheReadTokens ?? null,
        notes: item.notes ?? null,
        approvedAt: item.approvedAt ?? null,
      };
      // The language safety check is pure, so a reopened draft is checked again with the brand's current settings.
      const brandOpt = opts?.brands.find((b) => b.slug === itemBrief.brandSlug);
      let safety: string[] = [];
      try {
        safety = checkLanguageSafety(item.output, {
          language: itemBrief.language,
          platform: itemBrief.platform,
          postType: itemBrief.postType,
          tone: itemBrief.tone,
          bannedPhrases: brandOpt?.bannedPhrases ?? [],
          aiPhraseCheck: brandOpt?.aiPhraseCheck ?? true,
        });
      } catch {
        // Rows saved by older versions may miss fields; the check is advisory, so skip it rather than fail the reopen.
      }
      setResult({ draft, references: [], priorApproved: [], repetition: { warnings: [], maxSimilarity: 0 }, safety });
      setResultKey((k) => k + 1);
      setActiveVariant(0);
      setSavedId(item.id);
      const st = item.status as GenerationStatus;
      setSavedStatus(st === "approved" || st === "draft" || st === "rejected" ? st : null);
      setNotes(item.notes ?? "");
      setGenError(null);
      if (item.brief) setBrief(itemBrief);
      setHistoryOpen(false);
      scrollToResult();
    },
    [brief, pushToast, scrollToResult],
  );

  const deleteHistoryItem = useCallback(
    async (item: HistoryItem) => {
      if (!window.confirm("Delete this generation permanently? It will no longer be used as a reference.")) return;
      setDeletingId(item.id);
      try {
        await api.deleteGeneration(item.id);
        setHistory((h) => h.filter((x) => x.id !== item.id));
        if (savedId === item.id) {
          setSavedId(null);
          setSavedStatus(null);
        }
        pushToast("info", "Deleted.");
      } catch (e) {
        pushToast("error", toApiError(e).message);
      } finally {
        setDeletingId(null);
      }
    },
    [savedId, pushToast],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the cookie may already be gone; go to login regardless */
    }
    router.push("/login");
    router.refresh();
  }, [router]);

  const currentBrandName = brandNameFor(result ? result.draft.brief.brandSlug : brief.brandSlug);

  return (
    <BrandAssetsProvider onManage={openAssets}>
      <div className="flex min-h-screen flex-col">
        <TopBar
          view={view}
          onViewChange={changeView}
          brands={options?.brands ?? []}
          brandSlug={brief.brandSlug}
          onBrandChange={(slug) => updateBrief({ brandSlug: slug })}
          providers={options?.providers ?? null}
          hasResult={!!result}
          savedStatus={savedStatus}
          busy={busy}
          generating={generating}
          onApprove={() => void persist("approved")}
          onDownload={download}
          onRegenerate={() => void runGenerate()}
          onToggleHistory={toggleHistory}
          historyOpen={historyOpen}
          onLogout={() => void logout()}
        />

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6">
          {optionsError ? (
            <ErrorBanner
              error={{ message: `Could not load the option catalog: ${optionsError.message}`, hint: optionsError.hint ?? "Check DATABASE_URL and that GET /api/options responds, then reload." }}
              title="Setup"
              className="mb-4"
            />
          ) : null}

          {!options && !optionsError ? (
            <div className="flex items-center gap-2 py-16 text-sm text-muted">
              <Spinner /> Loading brands and provider status…
            </div>
          ) : null}

          {options ? (
            <div
              className={`grid gap-5 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,480px)_minmax(0,1fr)] ${view === "create" ? "" : "hidden"}`}
            >
              <div className="min-w-0">
                <BriefForm options={options} brief={brief} onChange={updateBrief} onGenerate={() => void runGenerate()} generating={generating} voices={voices} validationError={validationError} />
              </div>
              <div ref={resultRef} className="min-w-0 scroll-mt-20">
                <ResultPanel
                  result={result}
                  resultKey={resultKey}
                  brandName={currentBrandName}
                  providers={options.providers}
                  brands={options.brands}
                  voices={voices}
                  activeVariant={activeVariant}
                  onVariantChange={setActiveVariant}
                  savedId={savedId}
                  savedStatus={savedStatus}
                  busy={busy}
                  generating={generating}
                  notes={notes}
                  onNotesChange={setNotes}
                  onApprove={() => void persist("approved")}
                  onReject={() => void reject()}
                  onSaveDraft={() => void persist("draft")}
                  onDownload={download}
                  onVideoUrl={onVideoUrl}
                  onImageUrl={onImageUrl}
                  onAudioUrl={onAudioUrl}
                  error={genError}
                  onDismissError={() => setGenError(null)}
                  pendingBrief={brief}
                />
              </div>
            </div>
          ) : null}

          {options && ideasOpened ? (
            <div className={view === "ideas" ? "" : "hidden"}>
              <IdeasView brands={options.brands} initialBrandSlug={brief.brandSlug} providerNote={options.providers.ideas?.note} onUseIdea={useIdea} onToast={pushToast} />
            </div>
          ) : null}

          {options && brandsOpened ? (
            <div className={view === "brands" ? "" : "hidden"}>
              <BrandsView initialBrandSlug={brief.brandSlug} onChanged={(slug) => void reloadOptions(slug)} onToast={pushToast} />
            </div>
          ) : null}

          {options && assetsOpened ? (
            <div className={view === "assets" ? "" : "hidden"}>
              <AssetsView brands={options.brands} brandSlug={brief.brandSlug} onToast={pushToast} />
            </div>
          ) : null}

          {options && researchOpened ? (
            <div className={view === "research" ? "" : "hidden"}>
              <ResearchView brands={options.brands} initialBrandSlug={brief.brandSlug} onToast={pushToast} />
            </div>
          ) : null}
        </main>

        <footer className="border-t border-subtle px-4 py-3 text-center text-[11px] text-faint sm:px-6">
          Content Studio · self-hosted · nothing here is published automatically
        </footer>

        <HistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          brands={options?.brands ?? []}
          items={history}
          loading={historyLoading}
          error={historyError}
          filter={historyFilter}
          onFilterChange={changeHistoryFilter}
          onReload={() => void loadHistory()}
          onOpen={openHistoryItem}
          onDelete={(item) => void deleteHistoryItem(item)}
          currentId={savedId}
          deletingId={deletingId}
        />

        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </BrandAssetsProvider>
  );
}
