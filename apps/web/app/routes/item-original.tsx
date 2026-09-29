import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404, cookieOf } from "../lib/api.server";

export { default, headers, meta } from "./item";

export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { cookie: cookieOf(request), signal: request.signal });
  return { item };
}
