/**
 * The Monday platform sync (scheduler task "sync-weekly"): refreshes every connected account's posts and numbers. A run where an
 * account failed for a transient reason (network, rate limit, 5xx) throws, so the scheduler retries it in an hour; accounts that
 * need a reconnect are only reported (nothing a retry can fix).
 */
import { prisma } from "@/lib/db";
import { syncAll } from "@/lib/sync";
import { clip } from "@/lib/text";

export async function hasSyncableConnections(): Promise<boolean> {
  return (await prisma.platformConnection.count({ where: { status: { in: ["ok", "error"] } } })) > 0;
}

export async function runWeeklySync(): Promise<Record<string, unknown>> {
  const reports = await syncAll();
  const detail = {
    accounts: reports.length,
    synced: reports.filter((r) => r.ok).length,
    posts: reports.reduce((n, r) => n + r.fetched, 0),
    created: reports.reduce((n, r) => n + r.created, 0),
    updated: reports.reduce((n, r) => n + r.updated, 0),
    failed: reports.filter((r) => !r.ok).map((r) => clip(`${r.brandSlug}/${r.platform}: ${r.error ?? "failed"}`, 300)),
  };
  if (reports.some((r) => !r.ok && r.retryable)) throw new Error(`Platform sync incomplete (${detail.synced}/${detail.accounts} accounts): ${detail.failed.join(" | ")}`);
  return detail;
}
