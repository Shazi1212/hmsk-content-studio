"use client";

export type BannerError = { message: string; hint?: string; raw?: string; status?: number };

export function ErrorBanner({
  error,
  title,
  onDismiss,
  className = "",
}: {
  error: BannerError | null;
  title?: string;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className={`rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title ? <div className="eyebrow mb-1 text-danger">{title}</div> : null}
          <p className="font-medium text-paper break-words">{error.message}</p>
          {error.hint ? <p className="mt-1 text-xs text-paper/75 break-words">{error.hint}</p> : null}
          {error.raw ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted hover:text-paper">Show raw model output</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-ink p-3 text-[11px] leading-relaxed text-muted whitespace-pre-wrap break-words">
                {error.raw}
              </pre>
            </details>
          ) : null}
        </div>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="btn btn-sm btn-ghost shrink-0" aria-label="Dismiss error">
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
