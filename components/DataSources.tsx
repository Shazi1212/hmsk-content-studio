"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, toApiError } from "./api";
import type { BrandOption, ConnectionRow, ConnectionsResponse, ConnectorInfo } from "./types";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Spinner } from "./ui/Field";

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok" };
/**
 * The social account each brand is expected to connect. Instagram and TikTok connect whichever account is logged in in the browser at
 * that moment, and an account that is not a tester of the (development-mode) app is refused ("Insufficient developer role"), so the
 * expected login is spelled out next to the button.
 */
const EXPECTED_ACCOUNT: Record<string, Partial<Record<string, string>>> = {};
/** `reauth` makes the platform show its login screen, which is how a second or another account gets connected from one browser. */
const startUrl = (platform: string, brandSlug: string, reauth: boolean): string =>
  `/api/connect/${platform}/start?brand=${encodeURIComponent(brandSlug)}${reauth ? "&reauth=1" : ""}`;
/** While a first sync is running the panel re-reads the list this often, for at most POLL_MAX_MS. */
const POLL_MS = 4000;
const POLL_MAX_MS = 120_000;

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const STATUS_STYLE: Record<string, string> = {
  ok: "border-success/40 text-success",
  needs_reconnect: "border-warn/50 text-warn",
  error: "border-danger/40 text-danger",
};
const STATUS_LABEL: Record<string, string> = { ok: "Connected", needs_reconnect: "Reconnect needed", error: "Sync error" };

function AccountLine({
  row,
  busy,
  onSync,
  onDisconnect,
}: {
  row: ConnectionRow;
  busy: boolean;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const waiting = row.status === "ok" && !row.lastSyncAt;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-semibold text-paper">{row.handle ? (row.platform === "instagram" ? `@${row.handle}` : row.handle) : row.externalId}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[row.status] ?? "border-subtle text-muted"}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
        <span className="text-faint">
          {waiting ? "first sync running…" : row.lastSyncAt ? `synced ${timeAgo(row.lastSyncAt)}${row.lastSyncCount !== null ? ` · ${row.lastSyncCount} posts` : ""}` : "not synced yet"}
        </span>
      </div>
      {row.lastError ? (
        <p className={`break-words text-[11px] leading-snug ${row.status === "ok" ? "text-muted" : "text-danger"}`} title={row.lastError}>
          {row.lastError.length > 220 ? `${row.lastError.slice(0, 219)}…` : row.lastError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {row.status !== "needs_reconnect" ? (
          <button type="button" className="btn btn-sm" onClick={onSync} disabled={busy}>
            {busy ? <Spinner /> : null}
            Sync now
          </button>
        ) : null}
        <a className="btn btn-sm btn-ghost" href={`/api/connect/${row.platform}/start?brand=${encodeURIComponent(row.brandSlug)}&reauth=1`}>
          Reconnect
        </a>
        <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onDisconnect} disabled={busy}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

function Cell({
  brand,
  platform,
  rows,
  connector,
  busyId,
  onSync,
  onDisconnect,
}: {
  brand: BrandOption;
  platform: string;
  rows: ConnectionRow[];
  connector: ConnectorInfo | undefined;
  busyId: string | null;
  onSync: (id: string) => void;
  onDisconnect: (row: ConnectionRow) => void;
}) {
  const label = PLATFORM_LABEL[platform] ?? platform;
  const listed = brand.platforms.some((p) => p.split("-")[0] === platform);
  const expected = EXPECTED_ACCOUNT[brand.slug]?.[platform];
  // A brand can have an account on a platform its research list does not mention yet .
  if (!rows.length && !listed && !expected) return <div className="text-xs text-faint">–</div>;
  const unconfigured = connector && !connector.configured;
  const at = platform === "instagram" ? "@" : "";
  return (
    <div className="grid content-start gap-3">
      {rows.map((row) => (
        <AccountLine key={row.id} row={row} busy={busyId === row.id} onSync={() => onSync(row.id)} onDisconnect={() => onDisconnect(row)} />
      ))}
      {unconfigured ? (
        !rows.length ? (
          <span className="text-xs text-muted" title={`Set ${connector.missingEnv.join(" and ")} in the environment first`}>
            Not set up yet
          </span>
        ) : null
      ) : (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a className="btn btn-sm" href={startUrl(platform, brand.slug, rows.length > 0)}>
              {rows.length ? `Add another ${label} account` : `Connect ${label}`}
            </a>
            {!rows.length ? (
              <a
                className="text-[11px] text-muted underline decoration-subtle underline-offset-2 hover:text-paper"
                href={startUrl(platform, brand.slug, true)}
                title={`Shows ${label}'s login screen first, for when this browser is logged in as another account`}
              >
                Use another login
              </a>
            ) : null}
          </div>
          {!rows.length ? (
            <p className="text-[11px] leading-snug text-faint">
              Connects the {label} account that is logged in in this browser{expected ? <>: for this brand {at}{expected}</> : null}.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function DataSources({ brands, onSynced, onToast }: { brands: BrandOption[]; onSynced: () => void; onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pollUntil, setPollUntil] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .connections()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // A fresh connection starts its first sync in the background: keep looking until it reports.
        if (d.connections.some((c) => c.status === "ok" && !c.lastSyncAt)) setPollUntil((t) => (t > Date.now() ? t : Date.now() + POLL_MAX_MS));
      })
      .catch((e) => {
        if (!cancelled) setError(toApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const waiting = !!data?.connections.some((c) => c.status === "ok" && !c.lastSyncAt);
  useEffect(() => {
    if (!waiting || pollUntil <= Date.now()) return;
    const timer = window.setTimeout(() => {
      setReloadKey((k) => k + 1);
      onSynced();
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, pollUntil, data, onSynced]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const runSync = async (connectionId?: string) => {
    if (connectionId) setBusyId(connectionId);
    else setSyncingAll(true);
    setError(null);
    try {
      const reports = await api.sync(connectionId);
      const ok = reports.filter((r) => r.ok);
      const failed = reports.filter((r) => !r.ok);
      const created = ok.reduce((n, r) => n + r.created, 0);
      const updated = ok.reduce((n, r) => n + r.updated, 0);
      if (!reports.length) onToast("info", "Nothing to sync: no account is connected.");
      else if (failed.length) onToast("error", `${failed.length} of ${reports.length} accounts failed: ${failed[0].error ?? "see the list"}`);
      else onToast("success", `Synced ${ok.length} account${ok.length === 1 ? "" : "s"}: ${created} new posts, ${updated} updated.`);
      onSynced();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusyId(null);
      setSyncingAll(false);
      reload();
    }
  };

  const disconnect = async (row: ConnectionRow) => {
    if (!window.confirm(`Disconnect ${row.handle ?? row.platform} from ${row.brandName}? The stored access is deleted; posts already imported stay in the research data.`)) return;
    setBusyId(row.id);
    try {
      await api.disconnect(row.id);
      onToast("info", "Disconnected.");
    } catch (e) {
      onToast("error", toApiError(e).message);
    } finally {
      setBusyId(null);
      reload();
    }
  };

  const connected = data?.connections.length ?? 0;
  const unconfigured = (data?.connectors ?? []).filter((c) => !c.configured);

  return (
    <section className="card mb-4 p-4 sm:p-5" aria-label="Data sources">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="eyebrow">Data sources</div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
            Posts and numbers straight from the platforms&apos; official APIs. Connect each account once; the app refreshes them every Monday and the strategist learns from
            the current figures. LinkedIn&apos;s APIs are closed to this use, so LinkedIn stays on the research export.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={() => void runSync()} disabled={syncingAll || busyId !== null || connected === 0}>
            {syncingAll ? <Spinner /> : null}
            Sync all now
          </button>
        </div>
      </div>

      <ErrorBanner error={error ? { message: error.message, hint: error.hint } : null} title="Data sources" onDismiss={() => setError(null)} className="mb-3" />

      {!data && !error ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner /> Loading…
        </div>
      ) : null}

      {data ? (
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="hidden text-[11px] font-semibold uppercase tracking-wide text-muted md:block">Brand</div>
          <div className="hidden text-[11px] font-semibold uppercase tracking-wide text-muted md:block">Instagram</div>
          <div className="hidden text-[11px] font-semibold uppercase tracking-wide text-muted md:block">TikTok</div>
          {brands.map((brand) => (
            <div key={brand.slug} className="contents">
              <div className="border-t border-subtle pt-3 text-sm font-semibold text-paper md:text-[13px]">{brand.name.replace(/\s*\(.*\)$/, "")}</div>
              {(["instagram", "tiktok"] as const).map((platform) => (
                <div key={platform} className="md:border-t md:border-subtle md:pt-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted md:hidden">{PLATFORM_LABEL[platform]}</div>
                  <Cell
                    brand={brand}
                    platform={platform}
                    rows={data.connections.filter((c) => c.brandSlug === brand.slug && c.platform === platform)}
                    connector={data.connectors.find((c) => c.platform === platform)}
                    busyId={busyId}
                    onSync={(id) => void runSync(id)}
                    onDisconnect={(row) => void disconnect(row)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {unconfigured.length ? (
        <div className="mt-4 rounded-lg border border-subtle bg-ink px-3 py-2.5 text-xs leading-relaxed text-muted">
          <p className="font-medium text-paper/85">One-time setup still open</p>
          <ul className="mt-1 grid gap-1">
            {unconfigured.map((c) => (
              <li key={c.platform}>
                <span className="font-semibold text-paper/85">{c.label}:</span> create the developer app (docs/CONNECTORS.md), register <code className="break-all rounded bg-ink-3 px-1">{c.redirectUri}</code> as redirect URI and set{" "}
                {c.missingEnv.join(" and ")} in the environment (.env).
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
