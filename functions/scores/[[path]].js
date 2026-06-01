/**
 * Cloudflare Pages Function — proxies /scores/* requests to the private R2 bucket.
 *
 * R2 binding required (Pages → Settings → Functions → R2 bucket bindings):
 *   Binding name: SCORES
 *   R2 bucket:    aqi-scores
 *
 * Validation:
 *   403 — filename is not manifest.json or a valid YYYY-MM-DD.json
 *   400 — date is outside the manifest's earliest/latest range
 *   404 — object absent from R2 (valid request but no data for that day)
 *   503 — manifest itself is missing (R2 not yet populated)
 */

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Parses and validates the requested filename.
 * Returns { type: "manifest" }, { type: "date", date: "YYYY-MM-DD" }, or null (invalid).
 */
export function validateFilename(filename) {
  if (filename === "manifest.json") return { type: "manifest" };

  const m = filename.match(DATE_RE);
  if (!m) return null;

  // Reject calendar nonsense like 2026-02-30 (JS Date rolls it silently to March 2)
  const probe = new Date(`${m[1]}T12:00:00Z`);
  if (isNaN(probe.getTime()) || !probe.toISOString().startsWith(m[1])) return null;

  return { type: "date", date: m[1] };
}

/**
 * Returns true when date falls within [earliest, latest] inclusive.
 * All arguments must be YYYY-MM-DD strings (lexicographic comparison is correct for ISO dates).
 */
export function isDateInRange(date, earliest, latest) {
  return date >= earliest && date <= latest;
}

export async function onRequest({ params, env }) {
  const filename = params.path?.at(-1) ?? "";
  const parsed = validateFilename(filename);

  if (!parsed) {
    return new Response("Forbidden", { status: 403 });
  }

  if (parsed.type === "date") {
    // Check the manifest before touching date files so callers get a useful error
    const manifestObj = await env.SCORES.get("scores/manifest.json");
    if (!manifestObj?.body) {
      return new Response("Manifest unavailable", { status: 503 });
    }
    const manifest = await new Response(manifestObj.body).json();

    if (!isDateInRange(parsed.date, manifest.earliest, manifest.latest)) {
      return new Response("Date out of range", { status: 400 });
    }
  }

  const key = `scores/${params.path.join("/")}`;
  const obj = await env.SCORES.get(key);
  if (!obj?.body) {
    return new Response("Not found", { status: 404 });
  }

  const cacheControl =
    parsed.type === "manifest"
      ? "public, max-age=60"
      : "public, max-age=86400, immutable";

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}
