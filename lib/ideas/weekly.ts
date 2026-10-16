/**
 * The Monday idea bank: a batch of ideas for each brand's first platforms, written by the Ideas model while nobody is
 * waiting for it (scheduled by lib/scheduler.ts, task "ideas-weekly"). The batches appear in the Ideas tab under "Weekly
 * idea bank". Free to run, so it is on by default once the model is connected (IDEAS_WEEKLY=off disables it).
 *
 * IDEAS_WEEKLY_PLATFORMS_PER_BRAND (default 2) and IDEAS_WEEKLY_COUNT (default 8) tune the size.
 */
import { prisma } from "@/lib/db";
import { ProviderNotConfiguredError, ProviderRequestError, env } from "@/lib/providers/config";
import { PLATFORMS } from "@/lib/types";
import { runIdeas } from "./run";
import { clip } from "@/lib/text";

const intEnv = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(env(name) ?? "", 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Base platform ids of a brand ("linkedin-showcase" → "linkedin"), in the brand's own order. */
export function brandPlatforms(platforms: string[]): string[] {
  const known = new Set(PLATFORMS.map((p) => p.id));
  return [...new Set(platforms.map((p) => p.split("-")[0]).filter((p) => known.has(p)))];
}

export async function runWeeklyIdeas(): Promise<Record<string, unknown>> {
  const perBrand = intEnv("IDEAS_WEEKLY_PLATFORMS_PER_BRAND", 2, 1, 4);
  const count = intEnv("IDEAS_WEEKLY_COUNT", 6, 3, 12);
  const since = new Date(Date.now() - 6 * 86_400_000);
  const brands = await prisma.brand.findMany({ orderBy: { createdAt: "asc" } });

  let made = 0;
  let skipped = 0;
  const problems: string[] = [];
  for (const brand of brands) {
    for (const platform of brandPlatforms(brand.platforms).slice(0, perBrand)) {
      // A retry after a partial failure only fills the gaps.
      const exists = await prisma.ideaBatch.findFirst({
        where: { brandId: brand.id, source: "weekly", createdAt: { gte: since }, params: { path: ["platform"], equals: platform } },
        select: { id: true },
      });
      if (exists) {
        skipped++;
        continue;
      }
      try {
        await runIdeas(
          { brandSlug: brand.slug, platform, pillar: "", goal: "any", language: brand.languages[0] === "en" ? "en" : "de", count, direction: "" },
          { source: "weekly" },
        );
        made++;
      } catch (err) {
        const message = `${brand.slug}/${platform}: ${clip(err instanceof Error ? err.message : String(err), 200)}`;
        // Ideas model unreachable or not configured: the remaining combinations would fail the same way, so stop and retry later.
        const unreachable = err instanceof ProviderNotConfiguredError || (err instanceof ProviderRequestError && (err.status === 0 || err.status >= 500));
        if (unreachable) throw new Error(`Idea bank stopped (${made} batches made): ${message}`);
        // The model answered but the batch was unusable (unreadable reply, only near-copies): note it and carry on; a retry would not change it.
        problems.push(message);
      }
    }
  }
  return { made, skipped, count, perBrand, ...(problems.length ? { problems } : {}) };
}
