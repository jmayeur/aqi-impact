/**
 * Generate historical score files by fetching a large window from the sensor
 * HTTP API, splitting readings by Pacific calendar day, and scoring each day.
 *
 * No SQLite or Pi access required — works anywhere AQI_SENSOR_URL is reachable.
 *
 * Usage:
 *   npx tsx scripts/backfill-from-api.ts [--days 100] [--out site/public/scores]
 *
 * Note: if the sensor API caps the $dh value, reduce --days until it responds.
 * The script skips today (incomplete) and only writes completed Pacific days.
 *
 * The script replaces the $dh parameter in AQI_SENSOR_URL with days*24 to
 * request a larger historical window from the sensor in a single fetch.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore, type SensorReading } from "./aqi.ts";

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const DAYS = parseInt(getArg("--days") ?? "100", 10);
const OUT_DIR = getArg("--out") ?? resolve(PROJECT_ROOT, "site/public/scores");
const FETCH_TIMEOUT_MS = 120_000; // 100+ days of readings can be a large response

// ── Sensor URL ────────────────────────────────────────────────────────────────

const BASE_URL = process.env["AQI_SENSOR_URL"];
if (!BASE_URL) {
  console.error(
    "Error: AQI_SENSOR_URL env var is not set.\n" +
      "Example: AQI_SENSOR_URL=http://<sensor-ip>/aq-data.json?\\$dh=24&fields=(p1,p10,p25)"
  );
  process.exit(1);
}

/** Replace the $dh=N value in the sensor URL with the requested hours */
function buildUrl(hours: number): string {
  return BASE_URL!.replace(/(\$dh=)\d+/, `$1${hours}`);
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    console.log(`Fetching ${DAYS} days of data...`);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface TimeValue { time: string; value: number }

function parseReadings(raw: unknown): SensorReading[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Unexpected response shape: ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const p25Key = ["p25", "PM25", "pm25", "pm2_5"].find(
    (k) => k in obj && Array.isArray(obj[k])
  );
  if (!p25Key) {
    throw new Error(
      `Cannot find PM2.5 series. Keys: ${Object.keys(obj).join(", ")}`
    );
  }
  return (obj[p25Key] as TimeValue[]).map((r) => ({
    time: r.time,
    p25: r.value,
  }));
}

// ── Pacific date helpers ──────────────────────────────────────────────────────

function toPacificDate(isoTime: string): string {
  return new Date(isoTime).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

function yesterdayPacific(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString(
    "en-CA",
    { timeZone: "America/Los_Angeles" }
  );
}

// ── Manifest ──────────────────────────────────────────────────────────────────

interface Manifest { earliest: string; latest: string }

function updateManifest(outDir: string, dates: string[]) {
  const sorted = [...dates].sort();
  const path = resolve(outDir, "manifest.json");

  let existing: Manifest | null = null;
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { /* ignore */ }
  }

  const manifest: Manifest = {
    earliest: existing
      ? (sorted[0] < existing.earliest ? sorted[0] : existing.earliest)
      : sorted[0],
    latest: existing
      ? (sorted.at(-1)! > existing.latest ? sorted.at(-1)! : existing.latest)
      : sorted.at(-1)!,
  };

  writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(`Manifest: ${manifest.earliest} → ${manifest.latest}`);
}

// ── Score and write one day ───────────────────────────────────────────────────

function writeDay(date: string, readings: SensorReading[], outDir: string) {
  const outFile = resolve(outDir, `${date}.json`);

  if (readings.length === 0) {
    writeFileSync(
      outFile,
      JSON.stringify({
        date,
        generatedAt: new Date().toISOString(),
        healthScore: null,
        totalMinutes: 0,
        categories: { good: 0, moderate: 0, usg: 0, unhealthy: 0, veryUnhealthy: 0, hazardous: 0 },
        peakAqi: null,
        averagePm25: null,
      }, null, 2)
    );
    console.log(`  ${date}: no data`);
    return;
  }

  const score = computeScore(readings);
  writeFileSync(
    outFile,
    JSON.stringify({ date, generatedAt: new Date().toISOString(), ...score }, null, 2)
  );
  console.log(
    `  ${date}: score=${score.healthScore} peakAQI=${score.peakAqi} readings=${readings.length}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const url = buildUrl(DAYS * 24);
  const raw = await fetchWithTimeout(url);
  const allReadings = parseReadings(raw);

  console.log(`Received ${allReadings.length} total readings — splitting by Pacific day...`);

  // Group by Pacific calendar date, skip today (incomplete day)
  const byDay = new Map<string, SensorReading[]>();
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  for (const r of allReadings) {
    const date = toPacificDate(r.time);
    if (date === today) continue; // only score completed days
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(r);
  }

  const yesterday = yesterdayPacific();
  const dates = [...byDay.keys()].filter((d) => d <= yesterday).sort();

  if (dates.length === 0) {
    console.log("No completed days found in the returned data.");
    return;
  }

  console.log(`\nScoring ${dates.length} days:\n`);
  for (const date of dates) {
    writeDay(date, byDay.get(date)!, OUT_DIR);
  }

  updateManifest(OUT_DIR, dates);
  console.log(`\nDone — ${dates.length} files written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
