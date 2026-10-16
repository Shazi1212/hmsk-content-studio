"use client";

import { useEffect, useRef, useState } from "react";

export function DownloadMenu({
  onDownload,
  disabled,
  size = "md",
  align = "right",
}: {
  onDownload: (kind: "json" | "md") => void;
  disabled?: boolean;
  size?: "sm" | "md";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`btn ${size === "sm" ? "btn-sm" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Download
        <span aria-hidden="true" className="text-muted">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-40 mt-1 min-w-44 overflow-hidden rounded-lg border border-subtle bg-ink-2 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm hover:bg-ink-3"
            onClick={() => {
              setOpen(false);
              onDownload("md");
            }}
          >
            Markdown (.md)
            <span className="block text-[11px] text-muted">Readable script, caption, shot list</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm hover:bg-ink-3"
            onClick={() => {
              setOpen(false);
              onDownload("json");
            }}
          >
            JSON (.json)
            <span className="block text-[11px] text-muted">Brief, output, references, repetition</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
