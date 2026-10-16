"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

type LoginError = { message: string; hint?: string };

const LOCKED_ERRORS: Record<string, LoginError> = {
  config: {
    message: "Access is locked: APP_PASSWORD is not configured on this deployment.",
    hint: "Set APP_PASSWORD (at least 16 characters) and AUTH_SECRET in the app's environment variables (.env file or the container environment), then restart the app.",
  },
  short: {
    message: "Access is locked: APP_PASSWORD is shorter than 16 characters.",
    hint: "Use a passphrase of at least 16 characters. Set APP_PASSWORD and AUTH_SECRET in the app's environment variables (.env file or the container environment), then restart the app.",
  },
};

function LoginForm() {
  const searchParams = useSearchParams();
  const lockedReason = searchParams.get("reason");
  const locked = lockedReason ? LOCKED_ERRORS[lockedReason] ?? null : null;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<LoginError | null>(null);
  const error = submitError ?? locked;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      if (!res.ok) {
        setSubmitError({ message: data.error ?? `Login failed (${res.status})`, hint: data.hint });
        return;
      }
      const next = searchParams.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      window.location.assign(target);
    } catch {
      setSubmitError({ message: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm rounded-2xl border border-subtle bg-ink-2 p-8 shadow-sm"
      aria-describedby={error ? "login-error" : undefined}
    >
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.2em] text-gold-ink">
          <span className="inline-block h-2 w-2 rounded-sm bg-gold" aria-hidden="true" />
          Content Studio
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Enter the shared password (APP_PASSWORD) to continue.</p>
      </div>

      <label htmlFor="password" className="block text-xs font-medium uppercase tracking-wide text-muted">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-2 w-full rounded-lg border border-line bg-ink-2 px-3 py-2.5 text-base text-paper outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/30"
      />

      {error && (
        <div id="login-error" role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p>{error.message}</p>
          {error.hint && <p className="mt-1 text-xs text-danger/80">{error.hint}</p>}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="mt-6 w-full rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-paper transition hover:bg-gold-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-ink text-paper flex items-center justify-center px-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
