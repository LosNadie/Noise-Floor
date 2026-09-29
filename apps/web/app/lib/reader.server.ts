// The signed-in reader, read straight from the session cookie.
//
// The cookie is signed, so this process can verify it without asking the api — which matters because
// this runs in the root loader, on every page. Server-only: `node:crypto` must not reach the browser
// bundle, and the session is not something the client is allowed to inspect anyway.
import { readSiteSession, type Reader } from "@aihot/contracts/site-session";

export type { Reader };

export function readerOf(request: Request): Reader | null {
  return readSiteSession(request.headers.get("cookie") ?? undefined);
}

/** Whether the site is closed behind sign-in, as the api decides it. */
export function requireLogin(): boolean {
  return ["1", "true"].includes((process.env.QZ_REQUIRE_LOGIN ?? "").trim().toLowerCase());
}
