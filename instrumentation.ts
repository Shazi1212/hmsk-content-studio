/**
 * Runs once when the Node server boots (Next.js instrumentation). Starts the scheduler for the weekly idea bank and the
 * weekly platform sync (lib/scheduler.ts). The edge runtime has nothing to schedule.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
