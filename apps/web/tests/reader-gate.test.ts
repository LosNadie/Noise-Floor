// Run after `npm run build -w @aihot/web`. The reader gate against a real production web server: the
// reader-only pages ask for sign-in on their own, the rest of the site stays open, and QZ_REQUIRE_LOGIN
// still closes everything. The api is never reachable here, so every assertion is about the gate — the
// pages behind it are allowed to answer 503.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SITE_SESSION_COOKIE, issueSiteSession } from "@aihot/contracts/site-session";

// The web process reads the session cookie with the same secret this test signs it with.
process.env.SESSION_SECRET = "reader-gate-test-secret";

/** Sign-in switched on with credentials present, so a gate can actually be passed. */
const SIGN_IN_OFFERED = { QZ_LOGIN_ENABLED: "true", QZ_APP_KEY: "test-app-key", QZ_APP_SECRET: "test-app-secret" };

interface Web {
  origin: string;
  stop(): Promise<void>;
}

async function startWeb(env: Record<string, string>): Promise<Web> {
  const web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    // Port 1 is never listening: an api call fails fast instead of reaching a developer's own stack.
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: "http://127.0.0.1:1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      if (web.exitCode === null) {
        web.kill("SIGTERM");
        await once(web, "exit");
      }
    },
  };
}

test("the subscription page asks for sign-in on its own; every other page stays open", async () => {
  const site = await startWeb({ ...SIGN_IN_OFFERED, QZ_REQUIRE_LOGIN: "false" });
  try {
    // Entering by URL is a document request and takes a plain 302 to sign-in.
    const doc = await fetch(`${site.origin}/subscriptions`, { redirect: "manual" });
    assert.equal(doc.status, 302);
    assert.equal(doc.headers.get("location"), `/login?return=${encodeURIComponent("/subscriptions")}`);
    await doc.text();

    // Client-side navigation asks the `.data` suffix. That is not a page: the gate must answer in the
    // single-fetch protocol (a 204 carrying the redirect + reload-document), or the client would try
    // to decode the login HTML as stream data. Both ways in land on sign-in, and on the plain page.
    const data = await fetch(`${site.origin}/subscriptions.data?_routes=routes%2Fsubscriptions`, { redirect: "manual" });
    assert.equal(data.status, 204);
    assert.equal(data.headers.get("x-remix-redirect"), `/login?return=${encodeURIComponent("/subscriptions")}`);
    assert.equal(data.headers.get("x-remix-status"), "302");
    assert.equal(data.headers.get("x-remix-reload-document"), "true");
    assert.equal(data.headers.get("location"), null);
    await data.text();
    const about = await fetch(`${site.origin}/about`, { redirect: "manual" });
    assert.notEqual(about.status, 302, "an open site must not bounce a public page to sign-in");
    await about.text();
  } finally {
    await site.stop();
  }
});

test("QZ_REQUIRE_LOGIN still closes the whole site, and a signed-in reader walks in", async () => {
  const locked = await startWeb({ ...SIGN_IN_OFFERED, QZ_REQUIRE_LOGIN: "true" });
  try {
    const anonymous = await fetch(`${locked.origin}/about`, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), `/login?return=${encodeURIComponent("/about")}`);
    await anonymous.text();

    const cookie = `${SITE_SESSION_COOKIE}=${issueSiteSession({ qUid: "q_test", name: "读", avatar: null })!}`;
    const page = await fetch(`${locked.origin}/subscriptions`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /订阅推送/);
  } finally {
    await locked.stop();
  }
});

test("a site that cannot sign anyone in explains itself instead of redirecting into a dead end", async () => {
  const plain = await startWeb({ QZ_LOGIN_ENABLED: "false", QZ_APP_KEY: "", QZ_APP_SECRET: "", QZ_REQUIRE_LOGIN: "false" });
  try {
    const res = await fetch(`${plain.origin}/subscriptions`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /还没有配置 Q助理 登录/);
  } finally {
    await plain.stop();
  }
});
