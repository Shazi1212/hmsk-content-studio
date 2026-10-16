"use client";

import { useEffect, useRef, useState } from "react";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!text}
      className={`btn btn-sm btn-ghost ${className}`}
      aria-live="polite"
      title={/^copy\b/i.test(label) ? label : `Copy ${label.toLowerCase()}`}
    >
      {state === "copied" ? <span className="text-success">Copied</span> : state === "failed" ? <span className="text-danger">Copy failed</span> : label}
    </button>
  );
}
