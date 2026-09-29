// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@aihot/backend/notify/deliver";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";

// Registered before the first await, so a rejection from anywhere below is logged rather than
// fatal. On Windows a scanner holding a file under pgdata can make the server PANIC while it
// creates a WAL segment; it then replays its log and refuses connections for a while, which
// surfaces here as a terminated connection.
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason).slice(0, 500) }));
});

/**
 * Starting the worker is idempotent, so a database that is briefly away should not be fatal.
 * The api process survives such an outage and answers 503; a worker that exits instead leaves
 * nothing collecting or processing content, and nobody notices until the site goes stale.
 * Retry, and only give up if the database stays away.
 */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = 10, waitMs = 5_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(JSON.stringify({ level: "error", msg: `${label} failed; retrying`, attempt, error: String(error).slice(0, 300) }));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

await retry("ensureContentTargets", () => ensureContentTargets());
const boss = await retry("getBoss", () => getBoss());
await retry("registerContentJobs", () => registerContentJobs(boss));
if (process.env.COLLECT_ENABLED !== "false") await retry("registerSourceJobs", () => registerSourceJobs(boss));
await retry("registerEventJobs", () => registerEventJobs(boss));
await retry("registerNotifyJobs", () => registerNotifyJobs(boss));
await retry("registerPublicationJobs", () => registerPublicationJobs(boss));
await retry("registerSchedules", () => registerSchedules(boss));
// A new site has no leaderboard until the first scheduled round: compute one now.
if (FEATURES.leaderboard) {
  const [published] = await retry("leaderboardCheck", () => sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`);
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
const heartbeat = startHeartbeat("worker");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
