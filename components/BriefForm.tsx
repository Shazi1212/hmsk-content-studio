"use client";

import { useId } from "react";
import type { Brief, Option, TextProviderId } from "@/lib/types";
import { CUSTOM_PILLAR, brandPlatformIds, pickDefaultVoice, postTypesFor, providerLabel } from "./brief";
import type { OptionsResponse, Voice } from "./types";
import { CharCount, Field, Fieldset, Select, Spinner, TextArea, TextInput, type SelectOption } from "./ui/Field";

const toSelect = (opts: Option[]): SelectOption[] => opts.map((o) => ({ id: o.id, label: o.label }));

export function BriefForm({
  options,
  brief,
  onChange,
  onGenerate,
  generating,
  voices,
  validationError,
}: {
  options: OptionsResponse;
  brief: Brief;
  onChange: (patch: Partial<Brief>) => void;
  onGenerate: () => void;
  generating: boolean;
  voices: Voice[];
  validationError: string | null;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const { options: cat, providers, brands } = options;
  const brand = brands.find((b) => b.slug === brief.brandSlug);

  // Every platform stays selectable ("any kind of post"); platforms without research data for this brand are
  // only marked, and retrieval backfills references from the brand's other channels.
  const platformIds = brandPlatformIds(brand);
  const platformOptions: SelectOption[] = cat.platforms.map((p) => ({
    id: p.id,
    label: p.label,
    hint: platformIds.includes(p.id) ? undefined : "no research data for this brand yet",
  }));
  const platformHint = platformIds.includes(brief.platform)
    ? undefined
    : `No researched ${cat.platforms.find((p) => p.id === brief.platform)?.label ?? brief.platform} posts for ${brand?.name ?? "this brand"} yet; references come from its other channels.`;
  const postTypeOptions = postTypesFor(brief.platform);
  const postTypeHint = postTypeOptions.find((p) => p.id === brief.postType)?.hint;
  const videoHint = cat.videoOptions.find((o) => o.id === brief.video)?.hint;

  const pillars = brand?.pillars ?? [];
  const pillarIsCustom = !pillars.includes(brief.pillar);
  const pillarOptions: SelectOption[] = [...pillars.map((p) => ({ id: p, label: p })), { id: CUSTOM_PILLAR, label: "Custom…" }];

  const audienceSuggestions = brand?.audienceSuggestions ?? [];
  const audienceSelectValue = audienceSuggestions.includes(brief.audience) ? brief.audience : "";

  const providerOptions: SelectOption[] = cat.textProviders.map((p) => {
    const st = providers.text[p.id as keyof typeof providers.text];
    const configured = !!st?.configured;
    return {
      id: p.id,
      label: configured ? providerLabel(p.id as TextProviderId, p.label, st?.model) : p.label,
      disabled: !configured,
      hint: configured ? undefined : st?.note || "not configured",
    };
  });
  const noProvider = !cat.textProviders.some((p) => providers.text[p.id as keyof typeof providers.text]?.configured);

  const audioReady = providers.audio.elevenlabs.configured;
  const videoReady = providers.video.higgsfield.configured;
  const imageReady = providers.image.configured;
  const audioOptions: SelectOption[] = cat.audioOptions.map((o) => ({
    id: o.id,
    label: o.label,
    disabled: o.id !== "none" && !audioReady,
    hint: o.id !== "none" && !audioReady ? "set ELEVENLABS_API_KEY" : undefined,
  }));
  const videoOptions: SelectOption[] = cat.videoOptions.map((o) => ({
    id: o.id,
    label: o.label,
    disabled: o.id !== "none" && !videoReady,
    hint: o.id !== "none" && !videoReady ? "set HIGGSFIELD_API_KEY + SECRET" : undefined,
  }));
  const imageOptions: SelectOption[] = cat.imageOptions.map((o) => ({
    id: o.id,
    label: o.label,
    disabled: o.id !== "none" && !imageReady,
    hint: o.id !== "none" && !imageReady ? "set OPENAI_API_KEY" : undefined,
  }));
  const voiceOptions: SelectOption[] = voices.map((v) => ({ id: v.voiceId, label: v.name }));
  const defaultVoiceId = providers.audio.elevenlabs.voiceId ? "" : pickDefaultVoice(voices, brief.language);
  const languageHint =
    brief.language === "de_en" ? "German main version plus an English altVersion per variant." : undefined;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!generating) onGenerate();
      }}
    >
      <Fieldset title="Brand & platform" description={brand?.tagline ?? undefined}>
        <Field label="Brand" htmlFor={id("brand")}>
          <Select id={id("brand")} value={brief.brandSlug} onChange={(v) => onChange({ brandSlug: v })} options={brands.map((b) => ({ id: b.slug, label: b.name }))} />
        </Field>
        <div className="grid gap-3.5 sm:grid-cols-2 sm:items-start">
          <Field label="Platform" htmlFor={id("platform")} hint={platformHint}>
            <Select id={id("platform")} value={brief.platform} onChange={(v) => onChange({ platform: v as Brief["platform"] })} options={platformOptions} />
          </Field>
          <Field label="Post type" htmlFor={id("postType")} hint={postTypeHint}>
            <Select id={id("postType")} value={brief.postType} onChange={(v) => onChange({ postType: v as Brief["postType"] })} options={toSelect(postTypeOptions)} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset title="Strategy">
        <Field label="Content pillar" htmlFor={id("pillar")}>
          <Select
            id={id("pillar")}
            value={pillarIsCustom ? CUSTOM_PILLAR : brief.pillar}
            onChange={(v) => onChange({ pillar: v === CUSTOM_PILLAR ? CUSTOM_PILLAR : v })}
            options={pillarOptions}
          />
          {pillarIsCustom ? (
            <TextInput
              value={brief.pillar === CUSTOM_PILLAR ? "" : brief.pillar}
              onChange={(v) => onChange({ pillar: v.trim() ? v : CUSTOM_PILLAR })}
              placeholder="Describe the custom pillar, e.g. Behind the scenes: packaging day"
              maxLength={120}
            />
          ) : null}
        </Field>
        <div className="grid gap-3.5 sm:grid-cols-2 sm:items-start">
          <Field label="Goal" htmlFor={id("goal")}>
            <Select id={id("goal")} value={brief.goal} onChange={(v) => onChange({ goal: v as Brief["goal"] })} options={toSelect(cat.goals)} />
          </Field>
          <Field label="Hook type" htmlFor={id("hookType")}>
            <Select id={id("hookType")} value={brief.hookType} onChange={(v) => onChange({ hookType: v as Brief["hookType"] })} options={toSelect(cat.hookTypes)} />
          </Field>
          <Field label="Emotional driver" htmlFor={id("driver")}>
            <Select id={id("driver")} value={brief.emotionalDriver} onChange={(v) => onChange({ emotionalDriver: v as Brief["emotionalDriver"] })} options={toSelect(cat.emotionalDrivers)} />
          </Field>
          <Field label="Reference strategy" htmlFor={id("refs")}>
            <Select id={id("refs")} value={brief.referenceStrategy} onChange={(v) => onChange({ referenceStrategy: v as Brief["referenceStrategy"] })} options={toSelect(cat.referenceStrategies)} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset title="Voice">
        <div className="grid gap-3.5 sm:grid-cols-2 sm:items-start">
          <Field label="Tone" htmlFor={id("tone")}>
            <Select id={id("tone")} value={brief.tone} onChange={(v) => onChange({ tone: v as Brief["tone"] })} options={toSelect(cat.tones)} />
          </Field>
          <Field label="Language" htmlFor={id("lang")} hint={languageHint}>
            <Select id={id("lang")} value={brief.language} onChange={(v) => onChange({ language: v as Brief["language"] })} options={toSelect(cat.languages)} />
          </Field>
          <Field label="Register" htmlFor={id("register")}>
            <Select id={id("register")} value={brief.register} onChange={(v) => onChange({ register: v as Brief["register"] })} options={toSelect(cat.registers)} />
          </Field>
          <Field label="Length" htmlFor={id("length")}>
            <Select id={id("length")} value={brief.length} onChange={(v) => onChange({ length: v as Brief["length"] })} options={toSelect(cat.lengths)} />
          </Field>
        </div>
        <Field label="Audience" htmlFor={id("audienceSel")} hint="Pick a persona from the brand research or describe one. Empty = brand default audience.">
          {audienceSuggestions.length ? (
            <Select
              id={id("audienceSel")}
              value={audienceSelectValue}
              onChange={(v) => onChange({ audience: v })}
              options={audienceSuggestions.map((a) => ({ id: a, label: a }))}
              placeholder="Choose a persona…"
            />
          ) : null}
          <TextInput value={brief.audience} onChange={(v) => onChange({ audience: v })} placeholder="e.g. skeptical first-time buyers, 30–45, research before purchase" maxLength={500} />
        </Field>
        <Field label="Visual style" htmlFor={id("visual")}>
          <Select id={id("visual")} value={brief.visualStyle} onChange={(v) => onChange({ visualStyle: v as Brief["visualStyle"] })} options={toSelect(cat.visualStyles)} />
        </Field>
      </Fieldset>

      <Fieldset title="Content inputs">
        <Field label="Topic / brief" htmlFor={id("topic")} right={<CharCount value={brief.topic} max={2000} />} hint="Subject, angle, campaign or offer. The more specific, the less generic the result.">
          <TextArea id={id("topic")} value={brief.topic} onChange={(v) => onChange({ topic: v })} rows={4} maxLength={2000} placeholder="e.g. Why the resin gets hard in winter and the 10-second fix with warm water" />
        </Field>
        {brief.postType === "blog_to_social" ? (
          <Field label="Source text (article or URL)" htmlFor={id("source")} right={<CharCount value={brief.sourceText} max={20000} />} hint="Source of truth for the repurposed posts. Paste the full article text; a bare URL is passed through as-is.">
            <TextArea id={id("source")} value={brief.sourceText} onChange={(v) => onChange({ sourceText: v })} rows={8} maxLength={20000} placeholder="Paste the article…" />
          </Field>
        ) : null}
        <div className="grid gap-3.5 sm:grid-cols-2 sm:items-start">
          <Field label="Must include" htmlFor={id("include")} right={<CharCount value={brief.mustInclude} max={1500} />}>
            <TextArea id={id("include")} value={brief.mustInclude} onChange={(v) => onChange({ mustInclude: v })} rows={3} maxLength={1500} placeholder="Facts, links, product names, exact prices…" />
          </Field>
          <Field label="Must avoid" htmlFor={id("avoid")} right={<CharCount value={brief.mustAvoid} max={1500} />}>
            <TextArea id={id("avoid")} value={brief.mustAvoid} onChange={(v) => onChange({ mustAvoid: v })} rows={3} maxLength={1500} placeholder="Claims, words, angles, competitors…" />
          </Field>
        </div>
        <Field label="CTA override" htmlFor={id("cta")} hint="Exact call to action or link to use. Empty = strategist picks one that fits the goal.">
          <TextInput id={id("cta")} value={brief.ctaOverride} onChange={(v) => onChange({ ctaOverride: v })} maxLength={300} placeholder="e.g. Order beans: northwind-coffee.example/shop" />
        </Field>
      </Fieldset>

      <Fieldset title="Production" description="Text runs now. Voice-over, video and key visual are produced from the result with the buttons on the right.">
        <Field label="Text provider" htmlFor={id("provider")} hint={noProvider ? "No text provider is configured. Add a key in the app's environment variables (.env file or the container environment): ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or LOCAL_LLM_BASE_URL, or remove MOCK_LLM=0 to use the keyless mock." : undefined}>
          <Select id={id("provider")} value={brief.textProvider} onChange={(v) => onChange({ textProvider: v as Brief["textProvider"] })} options={providerOptions} />
        </Field>
        <div className="grid gap-3.5 sm:grid-cols-2 sm:items-start">
          <Field label="Variants" htmlFor={id("variants")}>
            <Select id={id("variants")} value={brief.variants} onChange={(v) => onChange({ variants: v as Brief["variants"] })} options={toSelect(cat.variantCounts)} />
          </Field>
          <Field label="Audio" htmlFor={id("audio")}>
            <Select id={id("audio")} value={brief.audio} onChange={(v) => onChange({ audio: v as Brief["audio"] })} options={audioOptions} />
          </Field>
          {brief.audio !== "none" ? (
            <Field label="Voice" htmlFor={id("voice")} hint={voiceOptions.length ? undefined : "No voices listed; the default ELEVENLABS_VOICE_ID is used. You can paste a voice id."}>
              {voiceOptions.length ? (
                <Select id={id("voice")} value={brief.voiceId || defaultVoiceId} onChange={(v) => onChange({ voiceId: v })} options={voiceOptions} placeholder={`Default voice${providers.audio.elevenlabs.voiceId ? ` (${providers.audio.elevenlabs.voiceId.slice(0, 8)}…)` : ""}`} />
              ) : (
                <TextInput id={id("voice")} value={brief.voiceId} onChange={(v) => onChange({ voiceId: v })} placeholder="ElevenLabs voice id (optional)" maxLength={100} />
              )}
            </Field>
          ) : null}
          <Field label="Video" htmlFor={id("video")} hint={videoHint}>
            <Select id={id("video")} value={brief.video} onChange={(v) => onChange({ video: v as Brief["video"] })} options={videoOptions} />
          </Field>
          <Field label="Key visual" htmlFor={id("image")}>
            <Select id={id("image")} value={brief.image} onChange={(v) => onChange({ image: v as Brief["image"] })} options={imageOptions} />
          </Field>
        </div>
      </Fieldset>

      {validationError ? (
        <p role="alert" className="text-sm text-danger">
          {validationError}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary w-full py-3 text-sm" disabled={generating || noProvider}>
        {generating ? (
          <>
            <Spinner /> Generating… this can take up to two minutes
          </>
        ) : (
          "Generate"
        )}
      </button>
    </form>
  );
}
