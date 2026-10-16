/**
 * Recurring background work without an external cron: the weekly idea bank and (later) the weekly platform sync.
 *
 * Two triggers run the same `tick()`: a timer that instrumentation.ts starts when the server boots, and a catch-up "kick"
 * from frequently used routes, so a process that was restarted or idled still runs the week's jobs as soon as someone
 * opens the app. Tasks run at most once per ISO week (Europe/Berlin), from Monday 03:00.
 *
 * The lock is a database row: ScheduledRun has a unique (task, period), so when several Node processes or instances are
 * alive, exactly one inserts the row and runs the task. A failed run is retried after an hour (up to 3 attempts); a run
 * that vanished mid-way (process restarted) is re-claimed after 90 minutes.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { clip } from "@/lib/text";

export type TaskId = "ideas-weekly" | "sync-weekly";

type Task = {
  id: TaskId;
  /** False when the task has nothing to do in this deployment (model or accounts not connected). May be async. */
  enabled: () => boolean | Promise<boolean>;
  /** Runs the task for `period`; the returned object is stored in ScheduledRun.detail. Throw to mark the run failed. */
  run: (ctx: { period: string }) => Promise<Record<string, unknown>>;
  /** When set, the task only starts while this is true: heavy Ideas-model jobs wait for the night so interactive Ideas runs never queue behind them. */
  startsWhen?: (now: Date) => boolean;
};

const TIMEZONE = process.env.SCHEDULER_TIMEZONE?.trim() || "Europe/Berlin";
const TICK_MS = 15 * 60_000;
const KICK_MIN_GAP_MS = 10 * 60_000;
const RETRY_AFTER_MS = 60 * 60_000;
const STALE_RUNNING_MS = 90 * 60_000;
const MAX_ATTEMPTS = 3;

/** ISO week key ("2026-W40") and whether the weekly window (Monday 03:00 in SCHEDULER_TIMEZONE onwards) is open. */
export function weekInfo(now: Date = new Date()): { period: string; due: boolean } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const dayNumber = date.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber); // the Thursday of this ISO week decides the year
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return {
    period: `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    due: !(parts.weekday === "Mon" && Number(parts.hour) < 3),
  };
}

/** Hour of the day (0-23) in Europe/Berlin. */
function berlinHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(now));
}

async function loadTasks(): Promise<Task[]> {
  const { ideasConfigured, ideasWeeklyEnabled } = await import("@/lib/ideas/config");
  const { runWeeklyIdeas } = await import("@/lib/ideas/weekly");
  const { runWeeklySync, hasSyncableConnections } = await import("@/lib/sync-weekly");
  return [
    {
      id: "ideas-weekly",
      enabled: () => ideasConfigured() && ideasWeeklyEnabled(),
      run: runWeeklyIdeas,
      // a small local model writes about 13 tokens per second and handles one request at a time: a batch takes minutes and eight of them half an
      // hour, so the bank starts between 03:00 and 07:00 only (Monday 03:00 is the agreed window; a missed week is made up on a later night).
      startsWhen: (now) => berlinHour(now) >= 3 && berlinHour(now) < 7,
    },
    { id: "sync-weekly", enabled: hasSyncableConnections, run: runWeeklySync },
  ];
}

/**
 * Takes the run for (task, period). No row yet: insert it (the unique key decides a race, the loser gets false). A row that
 * failed at least an hour ago with attempts left, or one that has been "running" for 90 minutes (its process is gone), is
 * re-claimed with one atomic UPDATE. True = this process now owns the run.
 */
async function claim(task: TaskId, period: string, exists: boolean): Promise<boolean> {
  if (!exists) {
    try {
      await prisma.scheduledRun.create({ data: { task, period } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false; // another process inserted it first
      throw err;
    }
  }
  const now = Date.now();
  const { count } = await prisma.scheduledRun.updateMany({
    where: {
      task,
      period,
      OR: [
        { status: "failed", attempts: { lt: MAX_ATTEMPTS }, finishedAt: { lt: new Date(now - RETRY_AFTER_MS) } },
        { status: "running", startedAt: { lt: new Date(now - STALE_RUNNING_MS) } },
      ],
    },
    data: { status: "running", attempts: { increment: 1 }, startedAt: new Date(now), finishedAt: null, error: null },
  });
  return count === 1;
}

let ticking = false;
let lastTick = 0;

/**
 * Tasks this process knows need nothing more in a period: done, out of attempts, or disabled. The 15-minute timer skips them
 * without touching the database, so an idle app lets a serverless database suspend instead of waking it every quarter hour (it used to keep the
 * compute awake about a third of the time). Kicks come from people using the app, when the database is awake anyway, so they
 * re-check disabled tasks (an account connected mid-week still syncs that week).
 */
const settled = new Map<TaskId, { period: string; disabled: boolean }>();

/** Runs every task that is enabled, due and not yet done this week. Never throws. */
export async function tick(source: "timer" | "kick" = "timer"): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTick = Date.now();
  try {
    const { period, due } = weekInfo();
    if (!due) return;
    for (const task of await loadTasks()) {
      const known = settled.get(task.id);
      if (known?.period === period && (source === "timer" || !known.disabled)) continue;
      if (!(await task.enabled())) {
        settled.set(task.id, { period, disabled: true });
        continue;
      }
      if (task.startsWhen && !task.startsWhen(new Date())) continue;
      const existing = await prisma.scheduledRun.findUnique({ where: { task_period: { task: task.id, period } }, select: { status: true, attempts: true } });
      if (existing?.status === "done" || (existing?.status === "failed" && existing.attempts >= MAX_ATTEMPTS)) {
        settled.set(task.id, { period, disabled: false });
        continue;
      }
      if (!(await claim(task.id, period, existing !== null))) continue;
      const started = Date.now();
      try {
        const detail = await task.run({ period });
        await prisma.scheduledRun.update({
          where: { task_period: { task: task.id, period } },
          data: { status: "done", finishedAt: new Date(), detail: { ...detail, seconds: Math.round((Date.now() - started) / 1000) } as Prisma.InputJsonValue, error: null },
        });
        settled.set(task.id, { period, disabled: false });
        console.log(`[scheduler] ${task.id} ${period}: done in ${Math.round((Date.now() - started) / 1000)} s`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] ${task.id} ${period}: failed: ${message}`);
        await prisma.scheduledRun
          .update({ where: { task_period: { task: task.id, period } }, data: { status: "failed", finishedAt: new Date(), error: clip(message, 2000) } })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

/** Catch-up trigger for routes people hit every time they open the app; does nothing more than once per 10 minutes per process. */
export function kickScheduler(): Promise<void> {
  if (Date.now() - lastTick < KICK_MIN_GAP_MS) return Promise.resolve();
  return tick("kick");
}

/** Starts the timer once per process (instrumentation.ts). The first tick waits a minute so boot stays quiet. */
export function startScheduler(): void {
  const g = globalThis as { __contentStudioScheduler?: boolean };
  if (g.__contentStudioScheduler) return;
  g.__contentStudioScheduler = true;
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), TICK_MS).unref();
}
