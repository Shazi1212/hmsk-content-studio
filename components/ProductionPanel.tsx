"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Brief, Variant } from "@/lib/types";
import { api, toApiError } from "./api";
import { defaultAspectRatio, pickDefaultVoice } from "./brief";
import { downloadBlob } from "./download";
import { ReferencePicker, useReferenceSelection } from "./ReferencePicker";
import type { AspectRatio, ProviderStatus, VideoAspectRatio, Voice } from "./types";
import { CopyButton } from "./ui/CopyButton";
import { Field, Select, Spinner, TextArea, TextInput } from "./ui/Field";
import { ErrorBanner, type BannerError } from "./ui/ErrorBanner";

const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_ASPECTS: { id: VideoAspectRatio; label: string }[] = [
  { id: "9:16", label: "9:16 vertical (Reels, TikTok, Stories)" },
  { id: "1:1", label: "1:1 square (feed, LinkedIn)" },
  { id: "16:9", label: "16:9 landscape (YouTube, ads)" },
];
const IMAGE_ASPECTS: { id: AspectRatio; label: string }[] = [
  { id: "9:16", label: "9:16 vertical (Reels, TikTok, Stories)" },
  { id: "4:5", label: "4:5 portrait (Instagram and Facebook feed, carousels)" },
  { id: "1:1", label: "1:1 square (feed, LinkedIn)" },
  { id: "16:9", label: "16:9 landscape (YouTube, LinkedIn, ads)" },
];
const SLIDE_POST_TYPES = ["carousel", "linkedin_document", "story_sequence"];

type Slide = {
  busy: boolean;
  blob: Blob | null;
  blobUrl: string | null;
  hosted: string | null;
  references: number | null;
  done: boolean;
};
const EMPTY_SLIDE: Slide = {
  busy: false,
  blob: null,
  blobUrl: null,
  hosted: null,
  references: null,
  done: false,
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Image prompt for the first frame of a clip: the (possibly edited) video prompt, framed as one still, with the product rule. */
function startFramePrompt(videoPrompt: string): string {
  const shot = videoPrompt.trim();
  return [
    `First frame of this shot as one photorealistic still: ${shot}${/[.!?]$/.test(shot) ? "" : "."}`,
    "The product from the reference photo appears exactly as photographed. No words, numbers or prices in the image apart from the printed label and logo on the product.",
  ].join(" ");
}

function refsLabel(n: number | null): string | null {
  if (n === null) return null;
  return n > 0 ? `with ${n} reference photo${n === 1 ? "" : "s"}` : "without reference photos";
}
const DURATIONS = ["3", "5", "8", "10", "12", "15"].map((s) => ({
  id: s,
  label: `${s} s`,
}));

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function HostedLink({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
      <span>{label}</span>
      <a href={url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-paper/85 underline decoration-subtle underline-offset-2 hover:decoration-gold" title={url}>
        {url}
      </a>
      <CopyButton text={url} label="Copy URL" />
    </div>
  );
}

export function ProductionPanel({
  variant,
  index,
  brief,
  providers,
  productPhotos,
  voices,
  baseName,
  onVideoUrl,
  onImageUrl,
  onAudioUrl,
  initialVideoUrl,
  initialImageUrl,
  initialImageUrls,
  initialAudioUrl,
}: {
  variant: Variant;
  index: number;
  brief: Brief;
  providers: ProviderStatus | null;
  /** Default product / packaging photos the server reports for this brand; used for the start-frame option until the brand's photos have loaded. */
  productPhotos: number;
  voices: Voice[];
  baseName: string;
  onVideoUrl: (url: string) => void;
  onImageUrl: (url: string, provider?: string | null, urls?: string[]) => void;
  onAudioUrl: (url: string) => void;
  initialVideoUrl?: string | null;
  initialImageUrl?: string | null;
  initialImageUrls?: string[] | null;
  initialAudioUrl?: string | null;
}) {
  const audioReady = !!providers?.audio.elevenlabs.configured;
  const videoReady = !!providers?.video.higgsfield.configured;
  const imageReady = !!providers?.image.configured;
  const imageLabel = providers?.image.provider === "gemini" ? "Gemini image" : "OpenAI image";
  const hostingReady = !!providers?.storage?.media.configured;
  const defaultAspect = defaultAspectRatio(brief);

  /* ---------------- voice-over ---------------- */
  const [voText, setVoText] = useState(variant.voiceoverText || variant.script || variant.caption || "");
  const [pickedVoiceId, setVoiceId] = useState(brief.voiceId || "");
  const voiceId = pickedVoiceId || (providers?.audio.elevenlabs.voiceId ? "" : pickDefaultVoice(voices, brief.language));
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioErr, setAudioErr] = useState<BannerError | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [hostedAudioUrl, setHostedAudioUrl] = useState<string | null>(initialAudioUrl ?? null);

  /* ---------------- video ---------------- */
  const [videoPrompt, setVideoPrompt] = useState(variant.videoPrompt || "");
  const [videoImageUrl, setVideoImageUrl] = useState(initialImageUrl ?? "");
  const [videoAspect, setVideoAspect] = useState<VideoAspectRatio>(defaultAspect === "4:5" ? "1:1" : defaultAspect);
  const [videoDuration, setVideoDuration] = useState("5");
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoErr, setVideoErr] = useState<BannerError | null>(null);
  const [videoStatus, setVideoStatus] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(initialVideoUrl ?? null);
  const [elapsed, setElapsed] = useState(0);
  const [fromProduct, setFromProduct] = useState(true);
  const [startFrame, setStartFrame] = useState<{ blobUrl: string; hosted: string } | null>(null);
  const startFrameBlob = useRef<string | null>(null);
  const [videoNotice, setVideoNotice] = useState<string | null>(null);
  const runId = useRef(0);
  const pollTimer = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);
  const startedAt = useRef(0);
  const cancelled = useRef(false);
  // Reference photos of the brand: defaults unless the user picks others; the choice goes with every image call of this panel.
  const refs = useReferenceSelection(brief.brandSlug, productPhotos);
  const productCount = refs.productCount;
  const refParams = refs.params;
  // The start frame is made with the image model, so it needs the image provider as well as the video provider.
  const useProductFrame = productCount > 0 && fromProduct && imageReady;

  /* ---------------- key visual ---------------- */
  const [imagePrompt, setImagePrompt] = useState(variant.imagePrompt || "");
  const [imageAspect, setImageAspect] = useState<AspectRatio>(defaultAspect);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageErr, setImageErr] = useState<BannerError | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [hostedImageUrl, setHostedImageUrl] = useState<string | null>(initialImageUrl ?? null);
  const [imageRefs, setImageRefs] = useState<number | null>(null);

  /* ---------------- slides (carousel, document, story) ---------------- */
  const shots = variant.shots ?? [];
  const isSlides = SLIDE_POST_TYPES.includes(brief.postType) && shots.length > 0;
  const [slides, setSlides] = useState<Slide[]>(() =>
    shots.map((_, i) => {
      const u = initialImageUrls?.[i] ?? (i === 0 ? initialImageUrl : null) ?? null;
      return { ...EMPTY_SLIDE, hosted: u, done: !!u };
    }),
  );
  const [slidePrompts, setSlidePrompts] = useState<Record<number, string>>({});
  const [slideErr, setSlideErr] = useState<BannerError | null>(null);
  const [batch, setBatch] = useState<{ at: number; total: number } | null>(null);
  const slidesRef = useRef<Slide[]>(slides);
  slidesRef.current = slides;
  const stopBatch = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    if (tickTimer.current) window.clearInterval(tickTimer.current);
    pollTimer.current = null;
    tickTimer.current = null;
  }, []);

  useEffect(() => {
    cancelled.current = false; // React StrictMode (dev) mounts, unmounts and re-mounts: the first cleanup must not stick
    return () => {
      cancelled.current = true;
      stopPolling();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (startFrameBlob.current) URL.revokeObjectURL(startFrameBlob.current);
      stopBatch.current = true;
      for (const s of slidesRef.current) if (s.blobUrl) URL.revokeObjectURL(s.blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kept in refs so a poll or upload that finishes after an approve still patches the saved generation.
  const onVideoUrlRef = useRef(onVideoUrl);
  const onImageUrlRef = useRef(onImageUrl);
  const onAudioUrlRef = useRef(onAudioUrl);
  useEffect(() => {
    onVideoUrlRef.current = onVideoUrl;
    onImageUrlRef.current = onImageUrl;
    onAudioUrlRef.current = onAudioUrl;
  }, [onVideoUrl, onImageUrl, onAudioUrl]);

  const runAudio = async () => {
    if (!voText.trim()) return;
    setAudioBusy(true);
    setAudioErr(null);
    try {
      const { blob, url } = await api.audio(voText.trim(), voiceId || undefined);
      if (cancelled.current) return;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioBlob(blob);
      setAudioUrl(URL.createObjectURL(blob));
      setHostedAudioUrl(url);
      if (url) onAudioUrlRef.current(url);
    } catch (e) {
      setAudioErr(toApiError(e));
    } finally {
      if (!cancelled.current) setAudioBusy(false);
    }
  };

  async function pollVideo(jobId: string): Promise<void> {
    if (cancelled.current) return;
    try {
      const s = await api.videoStatus(jobId);
      if (cancelled.current) return;
      setVideoStatus(s.status);
      if (s.status === "completed") {
        stopPolling();
        setVideoBusy(false);
        if (s.url) {
          setVideoUrl(s.url);
          onVideoUrlRef.current(s.url);
        } else {
          setVideoErr({
            message: "The video job completed but no URL was returned.",
            hint: "Check the Higgsfield dashboard for the output.",
          });
        }
        return;
      }
      if (s.status === "failed") {
        stopPolling();
        setVideoBusy(false);
        setVideoErr({
          message: s.error || "The video job failed.",
          hint: "Adjust the prompt or try again.",
        });
        return;
      }
    } catch (e) {
      // A transient status error should not kill the job; surface it and keep polling until the timeout.
      setVideoErr(toApiError(e));
    }
    if (Date.now() - startedAt.current > POLL_TIMEOUT_MS) {
      stopPolling();
      setVideoBusy(false);
      setVideoErr({
        message: "Timed out after 10 minutes waiting for the video.",
        hint: `Job ${jobId} may still finish; check the provider dashboard.`,
      });
      return;
    }
    pollTimer.current = window.setTimeout(() => void pollVideo(jobId), POLL_MS);
  }

  const runVideo = async () => {
    if (!videoPrompt.trim()) return;
    let startImage = videoImageUrl.trim();
    if (startImage && !/^https:\/\/\S+$/i.test(startImage)) {
      setVideoErr({
        message: "The start image must be a public https URL.",
        hint: "A local file or a blob: preview cannot be fetched by Higgsfield. Generate the key visual below (the app hosts it and fills this in), paste the https URL of an image you host, or leave the field empty for text-to-video.",
      });
      return;
    }
    const run = ++runId.current;
    setVideoBusy(true);
    setVideoErr(null);
    setVideoNotice(null);
    setVideoUrl(null);
    setVideoStatus("submitting");
    setElapsed(0);
    try {
      if (!startImage && useProductFrame) {
        // No start image yet: render a still of the real product first, so the video model animates the real product instead of inventing one.
        setVideoStatus("frame");
        let problem: string | null = null;
        try {
          // The video model takes 9:16, 1:1 and 16:9, all of which the image route accepts, and image-to-video keeps the picture's own ratio.
          const frame = await api.image(startFramePrompt(videoPrompt), videoAspect, { brandSlug: brief.brandSlug, ...refParams });
          if (cancelled.current) return;
          if (frame.productReferences === 0 || (frame.productReferences === null && frame.references === 0)) {
            problem = "The server could not load the product photo, so the start frame would not show the real product.";
          } else if (!frame.url) {
            problem = "The start frame was made but the server could not host it (no database connection), so Higgsfield cannot fetch it.";
          } else if (!/^https:\/\/\S+$/i.test(frame.url)) {
            problem = "The start frame is hosted at an address that is not public https (a local server), so Higgsfield cannot fetch it.";
          } else {
            const hosted = frame.url;
            const blobUrl = URL.createObjectURL(frame.blob);
            if (startFrameBlob.current) URL.revokeObjectURL(startFrameBlob.current);
            startFrameBlob.current = blobUrl;
            setStartFrame({ blobUrl, hosted });
            setVideoImageUrl((prev) => (prev.trim() ? prev : hosted));
            startImage = hosted;
          }
        } catch (e) {
          if (cancelled.current) return;
          problem = `The start frame failed: ${toApiError(e).message}`;
        }
        if (run !== runId.current) return; // "Stop waiting" was pressed while the frame was being made; keep the frame, skip the video
        if (problem) setVideoNotice(`${problem} Generating the video from the text prompt only, so the product may not look like the real one.`);
        setVideoStatus("submitting");
      }
      const { jobId } = await api.createVideo({
        prompt: videoPrompt.trim(),
        imageUrl: startImage || undefined,
        durationSeconds: Number(videoDuration) || undefined,
        aspectRatio: videoAspect,
      });
      if (cancelled.current) return;
      if (!jobId) throw new Error("The video endpoint did not return a job id.");
      startedAt.current = Date.now();
      setVideoStatus("queued");
      tickTimer.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
      pollTimer.current = window.setTimeout(() => void pollVideo(jobId), POLL_MS);
    } catch (e) {
      setVideoBusy(false);
      setVideoStatus("");
      setVideoErr(toApiError(e));
    }
  };

  const cancelVideo = () => {
    runId.current++;
    stopPolling();
    setVideoBusy(false);
    setVideoStatus("");
  };

  const runImage = async () => {
    if (!imagePrompt.trim()) return;
    setImageBusy(true);
    setImageErr(null);
    try {
      const { blob, url, provider, references } = await api.image(imagePrompt.trim(), imageAspect, { brandSlug: brief.brandSlug, ...refParams });
      if (cancelled.current) return;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      setImageBlob(blob);
      setImageUrl(URL.createObjectURL(blob));
      setHostedImageUrl(url);
      setImageRefs(references);
      if (url) {
        // The hosted key visual is the natural start frame for image-to-video.
        setVideoImageUrl((prev) => (prev.trim() ? prev : url));
        onImageUrlRef.current(url, provider);
      }
    } catch (e) {
      setImageErr(toApiError(e));
    } finally {
      if (!cancelled.current) setImageBusy(false);
    }
  };

  const slidePromptFor = (i: number): string => {
    if (slidePrompts[i] !== undefined) return slidePrompts[i];
    const shot = shots[i];
    const parts = [shot.visual.trim()];
    if (shot.text?.trim()) {
      parts.push(`Render this on-slide text exactly, in the language given, legible at phone size: "${shot.text.trim()}"`);
      parts.push(
        "Text rule: the quoted on-slide text and the logo are the ONLY words, numbers or prices in the image. Add no other headline, label, price tag, badge, icon list, footer, URL, fine print, crossed-out or strike-through price, or claim.",
      );
    } else {
      parts.push("Text rule: no words, numbers or prices in the image apart from the logo.");
    }
    if (variant.visualDirection?.trim()) parts.push(`Style for the whole set (look, colours and layout only; it adds no text): ${variant.visualDirection.trim()}`);
    parts.push(`Aspect ratio ${imageAspect}; slide ${i + 1} of ${shots.length}, same look as the other slides in the set.`);
    return parts.join("\n\n");
  };

  const patchSlide = (i: number, patch: Partial<Slide>) => setSlides((prev) => prev.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  const hostedList = (list: Slide[]) => list.map((s) => s.hosted).filter((u): u is string => !!u);

  const runSlide = async (i: number): Promise<boolean> => {
    const prompt = slidePromptFor(i).trim();
    if (!prompt) return false;
    patchSlide(i, { busy: true });
    setSlideErr(null);
    try {
      const { blob, url, provider, references } = await api.image(prompt, imageAspect, { brandSlug: brief.brandSlug, ...refParams });
      if (cancelled.current) return false;
      const old = slidesRef.current[i]?.blobUrl;
      if (old) URL.revokeObjectURL(old);
      const next: Slide = {
        busy: false,
        blob,
        blobUrl: URL.createObjectURL(blob),
        hosted: url,
        references,
        done: true,
      };
      const merged = slidesRef.current.map((s, k) => (k === i ? next : s));
      slidesRef.current = merged;
      setSlides(merged);
      if (i === 0 && url) {
        // The hook slide is the cover: it doubles as the video start image.
        setHostedImageUrl(url);
        setVideoImageUrl((prev) => (prev.trim() ? prev : url));
      }
      const urls = hostedList(merged);
      if (urls.length) onImageUrlRef.current(urls[0], provider, urls);
      return true;
    } catch (e) {
      if (!cancelled.current) {
        patchSlide(i, { busy: false });
        setSlideErr(toApiError(e));
      }
      return false;
    }
  };

  const runAllSlides = async () => {
    stopBatch.current = false;
    for (let i = 0; i < shots.length; i++) {
      if (stopBatch.current || cancelled.current) break;
      setBatch({ at: i + 1, total: shots.length });
      const ok = await runSlide(i);
      if (!ok) break;
    }
    if (!cancelled.current) setBatch(null);
  };

  const downloadSlide = async (i: number) => {
    const s = slides[i];
    const name = (blob: Blob) => `${baseName}_${vTag}_slide-${pad2(i + 1)}.${extFromMime(blob.type)}`;
    if (s.blob) return downloadBlob(s.blob, name(s.blob));
    if (!s.hosted) return;
    try {
      const blob = await (await fetch(s.hosted)).blob();
      downloadBlob(blob, name(blob));
    } catch {
      window.open(s.hosted, "_blank", "noopener,noreferrer");
    }
  };

  const downloadAllSlides = async () => {
    for (let i = 0; i < slides.length; i++) {
      if (!slides[i].blob && !slides[i].hosted) continue;
      await downloadSlide(i);
      await wait(500);
    }
  };

  const slidesDone = slides.filter((s) => s.done).length;
  const anySlideBusy = slides.some((s) => s.busy);
  const slideProvider = refsLabel(slides.find((s) => s.references !== null)?.references ?? null);
  const unhostedSlides = slides.some((s) => s.done && !s.hosted);

  const voiceOptions = voices.map((v) => ({ id: v.voiceId, label: v.name }));
  const vTag = `v${index + 1}`;
  const wantsImageToVideo = brief.video === "higgsfield_image2video";
  const startImageHint = useProductFrame
    ? "Leave empty and the app makes the start frame from the product photo. Or paste a public https URL (or generate a key visual below) to animate that picture instead."
    : hostingReady
      ? "Public https URL for image-to-video. Generating a key visual below fills this in automatically; leave empty for text-to-video."
      : "Public https URL for image-to-video; leave empty for text-to-video. This server cannot host the generated key visual (no database connection), so paste the URL of an image you host.";
  const shownImage = imageUrl ?? hostedImageUrl;
  const shownAudio = audioUrl ?? hostedAudioUrl;

  return (
    <section className="grid gap-3">
      <div className="eyebrow">Production</div>

      {/* Reference photos for every image call below (key visual, slides, video start frame) */}
      <ReferencePicker selection={refs} />

      {/* Voice-over */}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Voice-over</div>
          <span className="text-[11px] text-muted">ElevenLabs · {audioReady ? "ready" : "not configured"}</span>
        </div>
        <div className="grid gap-3">
          <Field label="Text to speak" hint="Clean text without emojis or stage directions. Edit before generating.">
            <TextArea value={voText} onChange={setVoText} rows={4} maxLength={5000} disabled={!audioReady} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Voice">
              {voiceOptions.length ? (
                <Select value={voiceId} onChange={setVoiceId} options={voiceOptions} placeholder="Default voice" disabled={!audioReady} />
              ) : (
                <TextInput value={voiceId} onChange={setVoiceId} placeholder="Voice id (optional, default from env)" disabled={!audioReady} maxLength={100} />
              )}
            </Field>
            <button
              type="button"
              className="btn"
              onClick={() => void runAudio()}
              disabled={!audioReady || audioBusy || !voText.trim()}
              title={audioReady ? "Synthesize with ElevenLabs" : "Set ELEVENLABS_API_KEY in the environment (.env)"}
            >
              {audioBusy ? <Spinner /> : null}
              {audioBusy ? "Synthesizing…" : "Generate voice-over"}
            </button>
          </div>
          {!audioReady ? <p className="text-[11px] text-muted">Set ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID) in the environment (.env) to enable.</p> : null}
          <ErrorBanner error={audioErr} onDismiss={() => setAudioErr(null)} />
          {shownAudio ? (
            <div className="grid gap-2 rounded-lg border border-subtle bg-ink p-3">
              <div className="flex flex-wrap items-center gap-3">
                <audio controls src={shownAudio} className="min-w-0 flex-1" />
                {audioBlob ? (
                  <button type="button" className="btn btn-sm" onClick={() => downloadBlob(audioBlob, `${baseName}_${vTag}_voiceover.mp3`)}>
                    Download MP3
                  </button>
                ) : (
                  <a href={shownAudio} download={`${baseName}_${vTag}_voiceover.mp3`} className="btn btn-sm">
                    Download MP3
                  </a>
                )}
              </div>
              {hostedAudioUrl ? (
                <HostedLink url={hostedAudioUrl} label="Hosted by this app (attached to the generation on approve):" />
              ) : (
                <p className="text-[11px] text-muted">Download-only: the server could not host this MP3, so it lives in this browser and is not stored with the generation.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Video */}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Video</div>
          <span className="text-[11px] text-muted">Higgsfield · {videoReady ? "ready" : "not configured"}</span>
        </div>
        <div className="grid gap-3">
          <Field label="Video prompt" hint="English, with camera and motion, up to 2,500 characters. Edit before generating.">
            <TextArea value={videoPrompt} onChange={setVideoPrompt} rows={4} maxLength={2500} disabled={!videoReady} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Aspect ratio">
              <Select value={videoAspect} onChange={(v) => setVideoAspect(v as VideoAspectRatio)} options={VIDEO_ASPECTS} disabled={!videoReady} />
            </Field>
            <Field label="Duration">
              <Select value={videoDuration} onChange={setVideoDuration} options={DURATIONS} disabled={!videoReady} />
            </Field>
          </div>
          <Field label={wantsImageToVideo ? "Start image URL (image-to-video)" : "Start image URL (optional)"} hint={startImageHint}>
            <TextInput value={videoImageUrl} onChange={setVideoImageUrl} placeholder="https://…" disabled={!videoReady} maxLength={2000} />
          </Field>
          {startFrame && videoImageUrl.trim() === startFrame.hosted ? (
            <div className="flex items-center gap-3 rounded-lg border border-subtle bg-ink p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={startFrame.blobUrl} alt="Start frame from the product photo" className="h-24 w-auto max-w-[120px] shrink-0 rounded object-contain" />
              <div className="grid min-w-0 justify-items-start gap-1.5">
                <span className="text-xs font-medium text-paper/85">Start frame from the product photo</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVideoImageUrl("")} disabled={videoBusy}>
                  Remove
                </button>
              </div>
            </div>
          ) : null}
          {productCount > 0 ? (
            <label className="flex items-start gap-2 text-xs text-paper/85">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fromProduct && imageReady}
                onChange={(e) => setFromProduct(e.target.checked)}
                disabled={!videoReady || !imageReady || videoBusy}
              />
              <span className="grid gap-0.5">
                <span>Start from the product photo (recommended)</span>
                <span className="text-[11px] leading-snug text-muted">
                  {imageReady
                    ? "With the start image empty, the app first makes a still of the real product (one image generation), then animates it. Off: text-to-video, where the model invents the product."
                    : "Needs the image provider (OPENAI_API_KEY); until it is set the video runs as text-to-video."}
                </span>
              </span>
            </label>
          ) : null}
          {wantsImageToVideo && !videoImageUrl.trim() && !useProductFrame ? (
            <p className="text-[11px] text-warn">
              The brief asked for video from image.{" "}
              {hostingReady ? "Generate the key visual below first; its hosted URL is filled in here." : "Paste a public https image URL above, or the job runs as text-to-video."}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn"
              onClick={() => void runVideo()}
              disabled={!videoReady || videoBusy || !videoPrompt.trim()}
              title={videoReady ? "Create a Higgsfield job and poll until done" : "Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in the environment (.env)"}
            >
              {videoBusy ? <Spinner /> : null}
              {videoBusy ? (videoStatus === "frame" ? "Making start frame…" : "Rendering…") : videoImageUrl.trim() ? "Generate video from image" : "Generate video"}
            </button>
            {videoBusy ? (
              <>
                <span className="text-xs text-muted">
                  {videoStatus === "frame"
                    ? "Making the start frame from the product photo…"
                    : `${videoStatus || "queued"} · ${mmss(elapsed)} elapsed · polling every 5 s, up to 10 min`}
                </span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={cancelVideo}>
                  Stop waiting
                </button>
              </>
            ) : null}
          </div>
          {!videoReady ? <p className="text-[11px] text-muted">Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in the environment (.env) to enable.</p> : null}
          {videoNotice ? <p className="text-[11px] text-warn">{videoNotice}</p> : null}
          <ErrorBanner error={videoErr} onDismiss={() => setVideoErr(null)} />
          {videoUrl ? (
            <div className="grid gap-2 rounded-lg border border-subtle bg-ink p-3">
              <video controls src={videoUrl} className="max-h-[420px] w-full rounded bg-black" preload="metadata" />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <a href={videoUrl} target="_blank" rel="noreferrer noopener" className="btn btn-sm">
                  Open video
                </a>
                <a href={videoUrl} download={`${baseName}_${vTag}.mp4`} className="btn btn-sm">
                  Download
                </a>
                <span className="min-w-0 truncate text-muted" title={videoUrl}>
                  {videoUrl}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Slides */}
      {isSlides ? (
        <div className="card p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">Slides</div>
            <span className="text-[11px] text-muted">
              {imageLabel} · {imageReady ? "ready" : "not configured"} · hosting {hostingReady ? "on" : "off"} · {slidesDone} of {shots.length} generated
            </span>
          </div>
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Aspect ratio (whole set)" hint="Applies to every slide. Generate the set in one go so the look stays consistent.">
                <Select value={imageAspect} onChange={(v) => setImageAspect(v as AspectRatio)} options={IMAGE_ASPECTS} disabled={!imageReady} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runAllSlides()}
                  disabled={!imageReady || anySlideBusy}
                  title={imageReady ? "Generate every slide, one after the other" : "Set OPENAI_API_KEY in the environment (.env)"}
                >
                  {batch ? <Spinner /> : null}
                  {batch ? `Generating slide ${batch.at} of ${batch.total}…` : "Generate all slides"}
                </button>
                {batch ? (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => (stopBatch.current = true)}>
                    Stop after this slide
                  </button>
                ) : null}
              </div>
            </div>
            {!imageReady ? <p className="text-[11px] text-muted">Set OPENAI_API_KEY (or GEMINI_API_KEY with IMAGE_PROVIDER=gemini) in the environment (.env) to enable.</p> : null}
            <ErrorBanner error={slideErr} onDismiss={() => setSlideErr(null)} />
            {slideProvider ? <p className="text-[11px] text-muted">{slideProvider}</p> : null}

            <div className="grid gap-3">
              {shots.map((shot, i) => {
                const s = slides[i] ?? EMPTY_SLIDE;
                return (
                  <div key={i} className="grid gap-2 rounded-lg border border-subtle bg-ink p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold">Slide {shot.order || i + 1}</div>
                      <button type="button" className="btn btn-sm" onClick={() => void runSlide(i)} disabled={!imageReady || anySlideBusy || !slidePromptFor(i).trim()}>
                        {s.busy ? <Spinner /> : null}
                        {s.busy ? "Generating…" : s.done ? "Regenerate" : "Generate"}
                      </button>
                    </div>
                    {shot.text ? <p className="text-xs text-paper/85">{shot.text}</p> : null}
                    <p className="text-[11px] text-muted">{shot.visual}</p>
                    <Field label="Slide prompt">
                      <TextArea value={slidePromptFor(i)} onChange={(v) => setSlidePrompts((p) => ({ ...p, [i]: v }))} rows={5} maxLength={4000} disabled={!imageReady} />
                    </Field>
                  </div>
                );
              })}
            </div>

            {slidesDone > 0 ? (
              <div className="grid gap-2 rounded-lg border border-subtle bg-ink p-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {slides.map((s, i) => {
                    const src = s.blobUrl ?? s.hosted;
                    return (
                      <div key={i} className="grid content-start gap-1">
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt={`Slide ${i + 1}`} className="w-full rounded object-contain" />
                        ) : (
                          <div className="flex aspect-[4/5] items-center justify-center rounded border border-dashed border-subtle text-[11px] text-faint">
                            {s.busy ? <Spinner /> : `Slide ${i + 1}`}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-1 text-[11px] text-muted">
                          <span>{i + 1}</span>
                          {src ? (
                            <button type="button" className="btn btn-sm" onClick={() => void downloadSlide(i)}>
                              Download
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn btn-sm" onClick={() => void downloadAllSlides()} disabled={anySlideBusy}>
                    Download all
                  </button>
                </div>
                {unhostedSlides || !hostingReady ? (
                  <p className="text-[11px] text-warn">
                    Download-only: the server could not host some slides, so they live in this browser and are not stored with the generation. Download them before leaving.
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">Hosted by this app: slide 1 is the cover and video start image; all hosted slides are attached on approve.</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Key visual */}
      {!isSlides ? (
        <div className="card p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">Key visual</div>
            <span className="text-[11px] text-muted">
              {imageLabel} · {imageReady ? "ready" : "not configured"} · hosting {hostingReady ? "on" : "off"}
              {refsLabel(imageRefs) ? ` · ${refsLabel(imageRefs)}` : ""}
            </span>
          </div>
          <div className="grid gap-3">
            <Field label="Image prompt" hint="English. Describe subject, composition, lighting, palette and where text will sit.">
              <TextArea value={imagePrompt} onChange={setImagePrompt} rows={4} maxLength={4000} disabled={!imageReady} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Aspect ratio">
                <Select value={imageAspect} onChange={(v) => setImageAspect(v as AspectRatio)} options={IMAGE_ASPECTS} disabled={!imageReady} />
              </Field>
              <button
                type="button"
                className="btn"
                onClick={() => void runImage()}
                disabled={!imageReady || imageBusy || !imagePrompt.trim()}
                title={imageReady ? `Generate with the ${imageLabel.toLowerCase()} model` : "Set OPENAI_API_KEY in the environment (.env)"}
              >
                {imageBusy ? <Spinner /> : null}
                {imageBusy ? "Generating…" : "Generate key visual"}
              </button>
            </div>
            {!imageReady ? <p className="text-[11px] text-muted">Set OPENAI_API_KEY (or GEMINI_API_KEY with IMAGE_PROVIDER=gemini) in the environment (.env) to enable.</p> : null}
            <ErrorBanner error={imageErr} onDismiss={() => setImageErr(null)} />
            {shownImage ? (
              <div className="grid gap-2 rounded-lg border border-subtle bg-ink p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shownImage} alt="Generated key visual" className="max-h-[520px] w-full rounded object-contain" />
                <div className="flex flex-wrap items-center gap-2">
                  {imageBlob ? (
                    <button type="button" className="btn btn-sm" onClick={() => downloadBlob(imageBlob, `${baseName}_${vTag}_keyvisual.${extFromMime(imageBlob.type)}`)}>
                      Download image
                    </button>
                  ) : (
                    <a href={shownImage} download={`${baseName}_${vTag}_keyvisual`} className="btn btn-sm">
                      Download image
                    </a>
                  )}
                  {hostedImageUrl && videoReady && videoImageUrl.trim() !== hostedImageUrl ? (
                    <button type="button" className="btn btn-sm" onClick={() => setVideoImageUrl(hostedImageUrl)}>
                      Use as video start image
                    </button>
                  ) : null}
                </div>
                {hostedImageUrl ? (
                  <HostedLink url={hostedImageUrl} label="Hosted by this app (start image for image-to-video, attached on approve):" />
                ) : (
                  <p className="text-[11px] text-muted">
                    Download-only: the server could not host this image, so the preview is a browser blob URL and cannot be the video start image. Host the file yourself and paste its https URL above.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
