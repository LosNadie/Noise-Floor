import { assertProductionSecrets, config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { startWorkerWatchdog } from "@aihot/backend/operations/watch";
import { buildApp } from "./app.ts";

assertProductionSecrets([
  ["auth", "SESSION_SECRET"],
  ["auth", "IMG_PROXY_SIGN_SECRET"],
]);
// Somebody must be able to sign in to the admin.
if (config.environmentName === "production" && !(config.adminPassword && config.adminPassword.length >= 12) && !process.env.FEISHU_LOGIN_APP_ID) {
  throw new Error("Refusing to start in production: set ADMIN_PASSWORD (at least 12 characters) or configure Feishu sign-in");
}

const app = await buildApp();
await app.listen({ port: config.apiPort, host: process.env.API_HOST || "127.0.0.1" });
startHeartbeat(`api:${config.apiPort}`);
startWorkerWatchdog();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();

  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// A stray promise rejection must not take the whole API down. On Windows a transient
// "could not open file ...: Permission denied" from the database (a scanner holding a data
// file) used to surface as an unhandled rejection and kill the process, so the whole site
// went 503 until someone restarted it. The web process already logs instead of exiting;
// mirror that here. Requests that fail still answer 503 through setErrorHandler.
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason).slice(0, 500) }));
});
