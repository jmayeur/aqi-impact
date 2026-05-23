import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore, type SensorReading, type ScoreResult } from "./aqi.ts";

const SENSOR_URL =
  process.env["AQI_SENSOR_URL"] ??
  (() => {
    console.error(
      "Error: AQI_SENSOR_URL env var is not set.\n" +
        "Example: AQI_SENSOR_URL=http://<sensor-ip>/aq-data.json?\\$dh=24&fields=(p1,p10,p25)"
    );
    process.exit(1);
  })();
const MAX_RETRIES = 3;
const BACKOFF_MS = [5_000, 15_000, 45_000];
const FETCH_TIMEOUT_MS = 10_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../site/public/latest.json");

const INSPECT = process.argv.includes("--inspect");

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── API response normalisation ────────────────────────────────────────────────
// Actual sensor response shape:
//   { p1: [{time, value}, ...], p25: [{time, value}, ...], p10: [{time, value}, ...] }
// Each array has ~1440 entries (one per minute over 24h).

interface TimeValue {
  time: string;
  value: number;
}

function parseReadings(raw: unknown): SensorReading[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Unexpected response shape (expected keyed object). Got: ${typeof raw}`
    );
  }

  const obj = raw as Record<string, unknown>;
  const p25Key = ["p25", "PM25", "pm25", "pm2_5"].find(
    (k) => k in obj && Array.isArray(obj[k])
  );

  if (!p25Key) {
    throw new Error(
      `Cannot find PM2.5 series. Top-level keys: ${Object.keys(obj).join(", ")}`
    );
  }

  const rows = obj[p25Key] as TimeValue[];
  if (rows.length === 0) throw new Error("Sensor returned 0 PM2.5 readings");

  return rows.map((r) => ({
    time: r.time,
    p25: r.value,
  }));
}

// ── Fetch with retry ──────────────────────────────────────────────────────────

async function fetchWithRetry(): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS[attempt - 1];
      log(`Retry ${attempt}/${MAX_RETRIES - 1} — waiting ${wait / 1000}s...`);
      await sleep(wait);
    }

    try {
      log(`Fetching sensor data (attempt ${attempt + 1})...`);
      const res = await fetchWithTimeout(SENSOR_URL, FETCH_TIMEOUT_MS);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();
      log("Fetch successful.");
      return json;
    } catch (err) {
      lastError = err;
      log(`Attempt ${attempt + 1} failed: ${(err as Error).message}`);
    }
  }

  throw lastError;
}

// ── Stale-data fallback ───────────────────────────────────────────────────────

function loadExistingResult(): ScoreResult | null {
  try {
    if (!existsSync(OUTPUT_PATH)) return null;
    return JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as ScoreResult;
  } catch {
    return null;
  }
}

function writeResult(result: ScoreResult) {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  log(`Wrote result to ${OUTPUT_PATH}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const lastAttemptAt = new Date().toISOString();

  // --inspect: dump raw API response and exit
  if (INSPECT) {
    log("--inspect mode: fetching raw sensor response...");
    try {
      const raw = await fetchWithRetry();
      console.log("\n=== RAW SENSOR RESPONSE ===");
      console.log(JSON.stringify(raw, null, 2));
      const arr = Array.isArray(raw) ? raw : null;
      if (arr && arr.length > 0) {
        console.log("\n=== FIRST RECORD ===");
        console.log(JSON.stringify(arr[0], null, 2));
        console.log(`\nTotal records: ${arr.length}`);
      }
    } catch (err) {
      console.error("Fetch failed:", (err as Error).message);
      process.exit(1);
    }
    return;
  }

  // Normal run
  let raw: unknown;
  let fetchFailed = false;

  try {
    raw = await fetchWithRetry();
  } catch (err) {
    log(`All ${MAX_RETRIES} fetch attempts failed: ${(err as Error).message}`);
    fetchFailed = true;
  }

  if (fetchFailed) {
    const existing = loadExistingResult();
    if (existing) {
      existing.stale = true;
      existing.lastAttemptAt = lastAttemptAt;
      writeResult(existing);
      log("Preserved existing data with stale=true.");
    } else {
      log("No existing data to fall back to. Nothing written.");
    }
    process.exit(1);
  }

  let readings: SensorReading[];
  try {
    readings = parseReadings(raw!);
    log(`Parsed ${readings.length} readings.`);
  } catch (err) {
    log(`Failed to parse response: ${(err as Error).message}`);
    process.exit(1);
  }

  const score = computeScore(readings);
  const result: ScoreResult = {
    ...score,
    generatedAt: lastAttemptAt,
    lastAttemptAt,
    stale: false,
  };

  writeResult(result);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
