"use client";

import type { Variant } from "@/lib/types";

export function ShotsTable({ shots, slides }: { shots: Variant["shots"]; slides: boolean }) {
  if (!shots.length) return null;
  const hasDuration = shots.some((s) => s.duration);
  const hasAudio = shots.some((s) => s.audio);
  return (
    <div className="overflow-x-auto rounded-lg border border-subtle">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <thead className="bg-ink text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">#</th>
            {hasDuration ? <th className="px-3 py-2 font-medium">{slides ? "Timing" : "Duration"}</th> : null}
            <th className="px-3 py-2 font-medium">{slides ? "Slide visual" : "Visual"}</th>
            <th className="px-3 py-2 font-medium">{slides ? "Headline / copy" : "On-screen text"}</th>
            {hasAudio ? <th className="px-3 py-2 font-medium">Audio / VO</th> : null}
          </tr>
        </thead>
        <tbody>
          {shots.map((s, i) => (
            <tr key={`${s.order}-${i}`} className="border-t border-subtle align-top">
              <td className="px-3 py-2 tabular-nums text-muted">{s.order}</td>
              {hasDuration ? <td className="px-3 py-2 whitespace-nowrap text-muted">{s.duration}</td> : null}
              <td className="px-3 py-2 text-paper/90">{s.visual}</td>
              <td className="px-3 py-2 text-paper/90 whitespace-pre-wrap">{s.text}</td>
              {hasAudio ? <td className="px-3 py-2 text-paper/80 whitespace-pre-wrap">{s.audio}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
