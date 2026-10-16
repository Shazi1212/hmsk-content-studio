"use client";

import type { ToastMessage } from "../types";

export function ToastStack({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`toast-in pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-xl backdrop-blur ${
            t.kind === "success"
              ? "border-success/40 bg-ink-2/95 text-paper"
              : t.kind === "error"
                ? "border-danger/40 bg-ink-2/95 text-paper"
                : "border-subtle bg-ink-2/95 text-paper"
          }`}
        >
          <span
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
              t.kind === "success" ? "bg-success" : t.kind === "error" ? "bg-danger" : "bg-gold"
            }`}
          />
          <span className="min-w-0 break-words">{t.text}</span>
          <button type="button" className="btn btn-sm btn-ghost -mr-2 -my-1" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
