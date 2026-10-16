"use client";

export function StatusDot({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        ok ? "border-success/30 text-paper/85" : "border-subtle text-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success" : "bg-faint"}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = (status ?? "").toLowerCase();
  const cls =
    s === "approved"
      ? "border-success/40 text-success"
      : s === "rejected"
        ? "border-danger/40 text-danger"
        : s === "draft"
          ? "border-gold/40 text-gold-ink"
          : "border-subtle text-muted";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {s || "unsaved"}
    </span>
  );
}
