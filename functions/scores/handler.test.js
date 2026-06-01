import { describe, it, expect } from "vitest";
import { validateFilename, isDateInRange, onRequest } from "./[[path]].js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const MANIFEST = { earliest: "2022-07-01", latest: "2026-05-31" };

/** Minimal R2-binding mock. Pass manifest=null to simulate an unpopulated bucket. */
function makeEnv({ manifest = MANIFEST, dates = {} } = {}) {
  return {
    SCORES: {
      get: async (key) => {
        if (key === "scores/manifest.json") {
          return manifest ? { body: JSON.stringify(manifest) } : null;
        }
        const data = dates[key.replace("scores/", "")];
        return data !== undefined ? { body: JSON.stringify(data) } : null;
      },
    },
  };
}

function makeCtx(filename, env) {
  return { params: { path: [filename] }, env };
}

function makeCtxMultiSegment(segments, env) {
  return { params: { path: segments }, env };
}

// ── validateFilename ──────────────────────────────────────────────────────────

describe("validateFilename", () => {
  it("accepts manifest.json", () => {
    expect(validateFilename("manifest.json")).toEqual({ type: "manifest" });
  });

  it("accepts a valid date filename", () => {
    expect(validateFilename("2026-05-01.json")).toEqual({ type: "date", date: "2026-05-01" });
  });

  it("accepts an early-range date", () => {
    expect(validateFilename("2022-07-01.json")).toEqual({ type: "date", date: "2022-07-01" });
  });

  it("rejects an arbitrary name", () => {
    expect(validateFilename("foo.json")).toBeNull();
  });

  it("rejects a filename without .json extension", () => {
    expect(validateFilename("2026-05-01")).toBeNull();
  });

  it("rejects a path-traversal attempt", () => {
    expect(validateFilename("../../etc/passwd")).toBeNull();
  });

  it("rejects an impossible date — Feb 30", () => {
    expect(validateFilename("2026-02-30.json")).toBeNull();
  });

  it("rejects an impossible date — month 13", () => {
    expect(validateFilename("2026-13-01.json")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateFilename("")).toBeNull();
  });
});

// ── isDateInRange ─────────────────────────────────────────────────────────────

describe("isDateInRange", () => {
  const { earliest, latest } = MANIFEST;

  it("accepts a date well within the range", () => {
    expect(isDateInRange("2024-06-15", earliest, latest)).toBe(true);
  });

  it("accepts the earliest boundary (inclusive)", () => {
    expect(isDateInRange(earliest, earliest, latest)).toBe(true);
  });

  it("accepts the latest boundary (inclusive)", () => {
    expect(isDateInRange(latest, earliest, latest)).toBe(true);
  });

  it("rejects one day before earliest", () => {
    expect(isDateInRange("2022-06-30", earliest, latest)).toBe(false);
  });

  it("rejects one day after latest", () => {
    expect(isDateInRange("2026-06-01", earliest, latest)).toBe(false);
  });
});

// ── onRequest ─────────────────────────────────────────────────────────────────

describe("onRequest", () => {
  it("returns 200 + JSON for manifest.json with short cache TTL", async () => {
    const res = await onRequest(makeCtx("manifest.json", makeEnv()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earliest).toBe(MANIFEST.earliest);
    expect(body.latest).toBe(MANIFEST.latest);
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });

  it("returns 200 + score JSON for a valid in-range date with immutable cache", async () => {
    const score = { date: "2024-06-15", healthScore: 95 };
    const env = makeEnv({ dates: { "2024-06-15.json": score } });
    const res = await onRequest(makeCtx("2024-06-15.json", env));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthScore).toBe(95);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("returns 400 for a valid date before manifest.earliest", async () => {
    const res = await onRequest(makeCtx("2020-01-01.json", makeEnv()));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a valid date after manifest.latest", async () => {
    const res = await onRequest(makeCtx("2030-12-31.json", makeEnv()));
    expect(res.status).toBe(400);
  });

  it("returns 403 for an invalid filename", async () => {
    const res = await onRequest(makeCtx("foo.json", makeEnv()));
    expect(res.status).toBe(403);
  });

  it("returns 403 for a path-traversal attempt", async () => {
    const res = await onRequest(makeCtx("../../etc/passwd", makeEnv()));
    expect(res.status).toBe(403);
  });

  it("returns 403 for an impossible date (Feb 30) — not a range error", async () => {
    const res = await onRequest(makeCtx("2026-02-30.json", makeEnv()));
    expect(res.status).toBe(403);
  });

  it("returns 404 when a valid in-range date file is absent from R2", async () => {
    // Date is valid and in range but no file in the mock bucket
    const res = await onRequest(makeCtx("2024-06-15.json", makeEnv()));
    expect(res.status).toBe(404);
  });

  it("returns 503 when the manifest itself is missing from R2", async () => {
    const env = makeEnv({ manifest: null });
    const res = await onRequest(makeCtx("2024-06-15.json", env));
    expect(res.status).toBe(503);
  });

  it("returns 403 for a multi-segment path (prevents reading arbitrary R2 key prefixes)", async () => {
    const res = await onRequest(makeCtxMultiSegment(["subfolder", "2024-06-15.json"], makeEnv()));
    expect(res.status).toBe(403);
  });

  it("includes X-Content-Type-Options: nosniff on successful responses", async () => {
    const res = await onRequest(makeCtx("manifest.json", makeEnv()));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
