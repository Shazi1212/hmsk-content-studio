"use client";

import type { GenerationOutput } from "@/lib/types";

export function SelfReviewCard({ review }: { review: GenerationOutput["selfReview"] }) {
  const score = Math.max(0, Math.min(10, Number(review.score) || 0));
  const tone = score >= 8 ? "text-success" : score >= 6 ? "text-gold-ink" : "text-danger";
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="eyebrow">Strategist self-review</div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
            <span className={`block h-full ${score >= 8 ? "bg-success" : score >= 6 ? "bg-gold" : "bg-danger"}`} style={{ width: `${score * 10}%` }} />
          </span>
          <span className={`text-sm font-semibold tabular-nums ${tone}`}>{score}/10</span>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {review.strengths.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-success">Strengths</div>
            <ul className="grid gap-1 text-sm text-paper/85">
              {review.strengths.map((s, i) => (
                <li key={i}>• {s}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {review.risks.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-danger">Risks</div>
            <ul className="grid gap-1 text-sm text-paper/85">
              {review.risks.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {review.complianceCheck ? (
        <div className="mt-4 rounded-lg border border-subtle bg-ink px-3 py-2.5">
          <div className="eyebrow mb-1">Compliance check</div>
          <p className="text-sm text-paper/85 whitespace-pre-wrap">{review.complianceCheck}</p>
        </div>
      ) : null}
    </section>
  );
}
