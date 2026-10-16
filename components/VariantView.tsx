"use client";

import type { ReactNode } from "react";
import type { Brief, Variant } from "@/lib/types";
import { hashtagsToText } from "./download";
import { ProductionPanel } from "./ProductionPanel";
import { ShotsTable } from "./ShotsTable";
import type { ProviderStatus, Voice } from "./types";
import { CopyButton } from "./ui/CopyButton";

function Section({
  title,
  copyText,
  children,
  meta,
}: {
  title: string;
  copyText?: string;
  children: ReactNode;
  meta?: string;
}) {
  return (
    <div className="min-w-0 border-t border-subtle pt-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <div className="eyebrow">{title}</div>
          {meta ? <span className="text-[11px] text-faint">{meta}</span> : null}
        </div>
        {copyText ? <CopyButton text={copyText} label="Copy" /> : null}
      </div>
      {children}
    </div>
  );
}

export function VariantView({
  variant,
  index,
  brief,
  hidden,
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
  hidden: boolean;
  providers: ProviderStatus | null;
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
  const isSlides = ["carousel", "linkedin_document", "story_sequence"].includes(brief.postType);
  const isTextPost = ["linkedin_text", "static_post", "blog_to_social"].includes(brief.postType);
  const hashtags = hashtagsToText(variant.hashtags);
  const captionWithTags = [variant.caption, hashtags].filter(Boolean).join("\n\n");
  const fullText = [
    variant.hook,
    variant.script,
    variant.onScreenText.length ? `On-screen:\n${variant.onScreenText.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "",
    captionWithTags,
    variant.cta,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className={hidden ? "hidden" : "grid min-w-0 gap-4"} aria-hidden={hidden} role="tabpanel">
      <section className="card grid gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="eyebrow">Variant {index + 1}</div>
            <h3 className="mt-0.5 text-base font-semibold tracking-tight">{variant.title || "Untitled"}</h3>
          </div>
          <CopyButton text={fullText} label="Copy everything" className="!border-subtle" />
        </div>

        <Section title="Hook" copyText={variant.hook} meta={variant.hookType || undefined}>
          <p className="text-lg font-semibold leading-snug tracking-tight text-gold-ink">{variant.hook}</p>
        </Section>

        {variant.script ? (
          <Section title={isTextPost ? "Body" : "Script / voice-over"} copyText={variant.script}>
            <p className="prose-block">{variant.script}</p>
          </Section>
        ) : null}

        {variant.onScreenText.length ? (
          <Section title="On-screen text" copyText={variant.onScreenText.join("\n")}>
            <ol className="grid gap-1 text-sm">
              {variant.onScreenText.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-5 shrink-0 tabular-nums text-faint">{i + 1}.</span>
                  <span className="text-paper/90">{t}</span>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {variant.shots.length ? (
          <Section title={isSlides ? "Slides" : "Shot list"} meta={`${variant.shots.length} ${isSlides ? "slides" : "shots"}`}>
            <ShotsTable shots={variant.shots} slides={isSlides} />
          </Section>
        ) : null}

        {variant.caption ? (
          <Section title="Caption" copyText={captionWithTags} meta={`${variant.caption.length} chars`}>
            <p className="prose-block rounded-lg border border-subtle bg-ink p-3">{variant.caption}</p>
          </Section>
        ) : null}

        {variant.hashtags.length ? (
          <Section title="Hashtags" copyText={hashtags} meta={`${variant.hashtags.length}`}>
            <div className="flex flex-wrap gap-1.5">
              {variant.hashtags.map((h, i) => (
                <span key={i} className="rounded-full border border-subtle px-2 py-0.5 text-xs text-paper/80">
                  {h.startsWith("#") ? h : `#${h}`}
                </span>
              ))}
            </div>
          </Section>
        ) : null}

        {variant.cta ? (
          <Section title="CTA" copyText={variant.cta} meta={variant.ctaType || undefined}>
            <p className="text-sm font-medium">{variant.cta}</p>
          </Section>
        ) : null}

        {variant.thumbnailText ? (
          <Section title="Thumbnail / cover text" copyText={variant.thumbnailText}>
            <p className="text-sm font-semibold uppercase tracking-wide">{variant.thumbnailText}</p>
          </Section>
        ) : null}

        {variant.visualDirection || variant.audioDirection ? (
          <Section title="Direction">
            <div className="grid gap-3 sm:grid-cols-2">
              {variant.visualDirection ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Visual</div>
                  <p className="text-sm text-paper/85 whitespace-pre-wrap">{variant.visualDirection}</p>
                </div>
              ) : null}
              {variant.audioDirection ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Audio</div>
                  <p className="text-sm text-paper/85 whitespace-pre-wrap">{variant.audioDirection}</p>
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {variant.imagePrompt || variant.videoPrompt ? (
          <Section title="Generation prompts">
            <div className="grid gap-3">
              {variant.imagePrompt ? (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Image prompt</span>
                    <CopyButton text={variant.imagePrompt} />
                  </div>
                  <p className="prose-block rounded-lg border border-subtle bg-ink p-3 text-xs text-paper/85">{variant.imagePrompt}</p>
                </div>
              ) : null}
              {variant.videoPrompt ? (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Video prompt</span>
                    <CopyButton text={variant.videoPrompt} />
                  </div>
                  <p className="prose-block rounded-lg border border-subtle bg-ink p-3 text-xs text-paper/85">{variant.videoPrompt}</p>
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {variant.voiceoverText ? (
          <Section title="Voice-over text (TTS-ready)" copyText={variant.voiceoverText}>
            <p className="prose-block text-paper/85">{variant.voiceoverText}</p>
          </Section>
        ) : null}

        {variant.altVersion ? (
          <Section title={brief.language === "de_en" ? "English version" : "Alternate language version"} copyText={variant.altVersion}>
            <p className="prose-block rounded-lg border border-subtle bg-ink p-3">{variant.altVersion}</p>
          </Section>
        ) : null}
      </section>

      <ProductionPanel
        variant={variant}
        index={index}
        brief={brief}
        providers={providers}
        productPhotos={productPhotos}
        voices={voices}
        baseName={baseName}
        onVideoUrl={onVideoUrl}
        onImageUrl={onImageUrl}
        onAudioUrl={onAudioUrl}
        initialVideoUrl={initialVideoUrl}
        initialImageUrl={initialImageUrl}
        initialImageUrls={initialImageUrls}
        initialAudioUrl={initialAudioUrl}
      />
    </div>
  );
}
