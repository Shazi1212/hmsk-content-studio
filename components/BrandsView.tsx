"use client";

import { useCallback, useEffect, useState } from "react";
import { PLATFORMS } from "@/lib/types";
import { ApiError, api, toApiError } from "./api";
import type { BrandInput, BrandRecord, ToastKind } from "./types";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Field, Fieldset, Spinner, TextArea, TextInput } from "./ui/Field";

const EMPTY: BrandInput = {
  name: "",
  tagline: "",
  websiteUrl: "",
  description: "",
  audience: "",
  voice: "",
  visual: "",
  offers: "",
  guardrails: "",
  categoryRules: "",
  languages: ["en"],
  platforms: ["instagram"],
  pillars: [],
  forbiddenTerms: [],
  claimTerms: [],
  claimSensitive: false,
  complianceReview: true,
};

const LANGUAGE_CHOICES = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
];

function toInput(b: BrandRecord): BrandInput {
  return {
    name: b.name,
    tagline: b.tagline ?? "",
    websiteUrl: b.websiteUrl ?? "",
    description: b.description,
    audience: b.audience,
    voice: b.voice,
    visual: b.visual,
    offers: b.offers,
    guardrails: b.guardrails,
    categoryRules: b.categoryRules ?? "",
    languages: b.languages,
    platforms: b.platforms,
    pillars: b.pillars,
    forbiddenTerms: b.forbiddenTerms ?? [],
    claimTerms: b.claimTerms ?? [],
    claimSensitive: b.claimSensitive ?? false,
    complianceReview: b.complianceReview ?? true,
  };
}

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** One-item-per-line editor for string lists; keeps the raw text while typing so blank lines do not vanish mid-edit. */
function ListField({ id, label, hint, value, onChange, rows = 4 }: { id: string; label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  // Initialised once; the form remounts the field (key) whenever another brand is loaded.
  const [raw, setRaw] = useState(() => value.join("\n"));
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <TextArea
        id={id}
        rows={rows}
        value={raw}
        onChange={(v) => {
          setRaw(v);
          onChange(lines(v));
        }}
      />
    </Field>
  );
}

function CheckGroup({ options, value, onChange }: { options: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {options.map((o) => {
        const on = value.some((v) => v.split("-")[0] === o.id);
        return (
          <label key={o.id} className="flex items-center gap-1.5 text-xs text-paper/85">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((v) => v.split("-")[0] !== o.id))}
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

export function BrandsView({
  initialBrandSlug,
  onChanged,
  onToast,
}: {
  initialBrandSlug: string;
  /** Called after a create, update or delete so the rest of the studio reloads its brand list. */
  onChanged: (selectSlug: string | null) => void;
  onToast: (kind: ToastKind, text: string) => void;
}) {
  const [brands, setBrands] = useState<BrandRecord[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  /** Slug being edited, or "new" for the create form. */
  const [selected, setSelected] = useState<string>(initialBrandSlug);
  const [form, setForm] = useState<BrandInput>(EMPTY);
  /** Bumped whenever the form is (re)loaded, so uncontrolled list fields remount with the new values. */
  const [formVersion, setFormVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  /** Selects a brand (or "new") from a list and loads its values into the form. */
  const applySelection = useCallback((list: BrandRecord[], slug: string) => {
    const b = slug === "new" ? undefined : (list.find((x) => x.slug === slug) ?? list[0]);
    setSelected(b ? b.slug : "new");
    setForm(b ? toInput(b) : EMPTY);
    setFormVersion((v) => v + 1);
    setDirty(false);
    setSaveError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await api.brands.list();
      setBrands(list);
      setLoadError(null);
      return list;
    } catch (e) {
      setLoadError(toApiError(e));
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.brands
      .list()
      .then((list) => {
        if (cancelled) return;
        setBrands(list);
        applySelection(list, initialBrandSlug);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(toApiError(e));
      });
    return () => {
      cancelled = true;
    };
    // Only on mount: later reloads go through load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<BrandInput>) => {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
  };

  const pick = (slug: string) => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    applySelection(brands ?? [], slug);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = selected === "new" ? await api.brands.create(form) : await api.brands.update(selected, form);
      const list = await load();
      if (list) applySelection(list, saved.slug);
      onToast("success", selected === "new" ? `Brand "${saved.name}" created` : `Brand "${saved.name}" saved`);
      onChanged(saved.slug);
    } catch (e) {
      setSaveError(toApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const b = brands?.find((x) => x.slug === selected);
    if (!b) return;
    if (!window.confirm(`Delete "${b.name}" with all its reference posts, generations, ideas and reference images? This cannot be undone.`)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.brands.remove(b.slug);
      const list = await load();
      const next = list?.[0]?.slug ?? "new";
      applySelection(list ?? [], next);
      onToast("success", `Brand "${b.name}" deleted`);
      onChanged(next === "new" ? null : next);
    } catch (e) {
      setSaveError(toApiError(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <ErrorBanner error={loadError} title="Brands" />;
  if (!brands) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Spinner /> Loading brands…
      </div>
    );
  }

  const id = (k: string) => `brand-${k}`;
  const isNew = selected === "new";

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="card h-fit p-3">
        <div className="eyebrow mb-2 px-1">Brands</div>
        <ul className="grid gap-0.5">
          {brands.map((b) => (
            <li key={b.slug}>
              <button
                type="button"
                onClick={() => pick(b.slug)}
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${selected === b.slug ? "bg-ink-3 text-paper" : "text-muted hover:text-paper"}`}
              >
                {b.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-sm mt-3 w-full" onClick={() => pick("new")} disabled={isNew}>
          New brand
        </button>
        <p className="mt-3 px-1 text-[11px] leading-snug text-muted">
          Everything here is sent to the text model as the brand&apos;s source of truth. Write facts only: the strategist may quote OFFERS verbatim and must never break GUARDRAILS.
        </p>
      </aside>

      <form
        className="grid min-w-0 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Fieldset title={isNew ? "New brand" : "Identity"} description={isNew ? "Name it; the slug is derived from the name and never changes afterwards." : `Slug: ${selected}`}>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Name" htmlFor={id("name")}>
              <TextInput id={id("name")} value={form.name} onChange={(v) => patch({ name: v })} maxLength={120} placeholder="e.g. Northwind Coffee Roasters" />
            </Field>
            <Field label="Website" htmlFor={id("web")}>
              <TextInput id={id("web")} value={form.websiteUrl} onChange={(v) => patch({ websiteUrl: v })} maxLength={300} placeholder="https://…" />
            </Field>
          </div>
          <Field label="Tagline" htmlFor={id("tagline")}>
            <TextInput id={id("tagline")} value={form.tagline} onChange={(v) => patch({ tagline: v })} maxLength={300} />
          </Field>
          <Field label="Description" hint="What the brand is and sells, market, positioning. Facts only." htmlFor={id("desc")}>
            <TextArea id={id("desc")} rows={4} value={form.description} onChange={(v) => patch({ description: v })} maxLength={8000} />
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Languages">
              <CheckGroup options={LANGUAGE_CHOICES} value={form.languages} onChange={(v) => patch({ languages: v })} />
            </Field>
            <Field label="Platforms">
              <CheckGroup options={PLATFORMS} value={form.platforms} onChange={(v) => patch({ platforms: v })} />
            </Field>
          </div>
        </Fieldset>

        <Fieldset title="Audience, voice and visuals">
          <Field label="Audience" hint="Who the posts are for; the first sentences become the audience suggestions in the brief." htmlFor={id("aud")}>
            <TextArea id={id("aud")} rows={3} value={form.audience} onChange={(v) => patch({ audience: v })} maxLength={8000} />
          </Field>
          <Field label="Voice" hint="Register (du / Sie / you), words used and avoided, sentence style, emoji rules." htmlFor={id("voice")}>
            <TextArea id={id("voice")} rows={3} value={form.voice} onChange={(v) => patch({ voice: v })} maxLength={8000} />
          </Field>
          <Field label="Visual identity" hint="Colours, type, photography style, what to avoid." htmlFor={id("visual")}>
            <TextArea id={id("visual")} rows={3} value={form.visual} onChange={(v) => patch({ visual: v })} maxLength={8000} />
          </Field>
          <ListField key={`pillars-${formVersion}`} id={id("pillars")} label="Content pillars" hint="One per line. They fill the pillar dropdown." value={form.pillars} onChange={(v) => patch({ pillars: v })} />
        </Fieldset>

        <Fieldset title="Offers and rules">
          <Field label="Offers" hint="Products, prices, links, handles and CTAs the model may quote character for character. Nothing else counts as a fact." htmlFor={id("offers")}>
            <TextArea id={id("offers")} rows={4} value={form.offers} onChange={(v) => patch({ offers: v })} maxLength={8000} />
          </Field>
          <Field label="Guardrails" hint="Hard prohibitions: claims never to make, words never to use, legal notes. The compliance review checks every draft against this." htmlFor={id("guard")}>
            <TextArea id={id("guard")} rows={4} value={form.guardrails} onChange={(v) => patch({ guardrails: v })} maxLength={8000} />
          </Field>
          <Field label="Category rules (optional)" hint="Category and default register plus any extra writing rules, e.g. “Category: B2B SaaS. Default register: Sie.”" htmlFor={id("cat")}>
            <TextArea id={id("cat")} rows={2} value={form.categoryRules} onChange={(v) => patch({ categoryRules: v })} maxLength={4000} />
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <ListField key={`forbidden-${formVersion}`} id={id("forbidden")} label="Forbidden strings" hint="One per line, matched exactly. Flagged by the lint and removed by the review." value={form.forbiddenTerms} onChange={(v) => patch({ forbiddenTerms: v })} rows={3} />
            <ListField key={`claims-${formVersion}`} id={id("claims")} label="Claim-check words" hint="One per line, case-insensitive. Flagged for a human look." value={form.claimTerms} onChange={(v) => patch({ claimTerms: v })} rows={3} />
          </div>
          <label className="flex items-start gap-2 text-xs text-paper/85">
            <input type="checkbox" className="mt-0.5" checked={form.complianceReview} onChange={(e) => patch({ complianceReview: e.target.checked })} />
            <span>
              Compliance review: after each generation a second model call checks the text against the guardrails and fixes violations (one extra call per run; never runs with the mock provider).
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-paper/85">
            <input type="checkbox" className="mt-0.5" checked={form.claimSensitive} onChange={(e) => patch({ claimSensitive: e.target.checked })} />
            <span>Regulated product (food supplement, cosmetics …): also check for health and effect claims.</span>
          </label>
        </Fieldset>

        {saveError ? <ErrorBanner error={saveError} title="Brand" /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim() || (!dirty && !isNew)}>
            {saving ? <Spinner /> : null}
            {isNew ? "Create brand" : "Save changes"}
          </button>
          {!isNew ? (
            <button type="button" className="btn btn-danger ml-auto" onClick={() => void remove()} disabled={saving || brands.length <= 1} title={brands.length <= 1 ? "The last brand cannot be deleted" : undefined}>
              Delete brand
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
