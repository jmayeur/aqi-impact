/**
 * Cloudflare Pages Function — proxies /scores/* requests to the private R2 bucket.
 *
 * R2 binding required (configured in Pages → Settings → Functions → R2 bucket bindings):
 *   Binding name: SCORES
 *   R2 bucket:    aqi-scores
 *
 * This means PUBLIC_SCORES_BASE can stay empty — the Astro site fetches from
 * /scores/... on its own domain and this function handles it.
 */

export async function onRequest({ params, env }) {
  // params.path is an array, e.g. ["2026-05-01.json"] or ["manifest.json"]
  const key = `scores/${params.path.join("/")}`;

  const obj = await env.SCORES.get(key);
  if (!obj || !obj.body) {
    return new Response("Not found", { status: 404 });
  }

  // manifest.json changes daily — keep TTL short so updates flow through quickly.
  // Individual date files are immutable once written — cache aggressively.
  const filename = params.path.at(-1) ?? "";
  const cacheControl = filename === "manifest.json"
    ? "public, max-age=60"
    : "public, max-age=86400, immutable";

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}
