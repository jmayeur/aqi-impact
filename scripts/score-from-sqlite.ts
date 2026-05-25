import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore, type SensorReading } from "./aqi.ts";

// ── Arg / env parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const DB_PATH =
  getArg("--db") ??
  process.env["AQI_DB_PATH"] ??
  "/home/pihead/enviro-lite/environment";

const OUT_DIR =
  getArg("--out") ?? resolve(PROJECT_ROOT, "site/public/scores");

const DATE_ARG = getArg("--date"); // YYYY-MM-DD, default = yesterday Pacific

// ── Pacific time helpers ──────────────────────────────────────────────────────

/** Returns the Pacific calendar date string "YYYY-MM-DD" for a given UTC Date */
function toPacificDateStr(utcDate: Date): string {
  return utcDate.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  }); // en-CA gives YYYY-MM-DD format
}

/** Returns yesterday's Pacific calendar date as "YYYY-MM-DD" */
function yesterdayPacific(): string {
  const now = new Date();
  // Subtract 24h from now to safely land in "yesterday" Pacific regardless of UTC offset
  return toPacificDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * Returns [startMs, endMs) in milliseconds UTC for the given Pacific calendar day.
 * Correctly handles DST transitions — America/Los_Angeles offset is auto-detected.
 */
function pacificDayBoundariesMs(dateStr: string): [number, number] {
  // Build "YYYY-MM-DDT00:00:00" and interpret it in the Pacific timezone
  // by formatting a candidate UTC date in Pacific and comparing the date part.
  // We do a binary search to find the exact UTC millisecond = Pacific midnight.

  // Simpler approach: offset detection via Intl
  const midnightApprox = new Date(`${dateStr}T08:00:00.000Z`); // ~Pacific midnight in winter
  const pacificParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(midnightApprox);

  const get = (t: string) =>
    pacificParts.find((p) => p.type === t)?.value ?? "0";
  const pacificHour = parseInt(get("hour"), 10);
  const pacificMin = parseInt(get("minute"), 10);

  // Adjust the approximate UTC midnight by however many hours/minutes off we are
  const offsetMs = (pacificHour * 60 + pacificMin) * 60 * 1000;
  const startMs = midnightApprox.getTime() - offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000;

  return [startMs, endMs];
}

// ── SQLite query ──────────────────────────────────────────────────────────────

interface DbRow {
  time: number;
  P25: number;
}

function queryDay(dbPath: string, startMs: number, endMs: number): SensorReading[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Sample one row to detect timestamp unit (ms vs seconds)
    const sample = db
      .prepare("SELECT time FROM envdata ORDER BY time DESC LIMIT 1")
      .get() as { time: number } | undefined;

    let qStart = startMs;
    let qEnd = endMs;

    if (sample && sample.time < 1e12) {
      // Timestamps are in seconds
      qStart = Math.floor(startMs / 1000);
      qEnd = Math.floor(endMs / 1000);
    }

    const rows = db
      .prepare(
        "SELECT time, P25 FROM envdata WHERE time >= ? AND time < ? ORDER BY time"
      )
      .all(qStart, qEnd) as DbRow[];

    const isSeconds = sample && sample.time < 1e12;

    return rows.map((r) => ({
      time: new Date(isSeconds ? r.time * 1000 : r.time).toISOString(),
      p25: r.P25,
    }));
  } finally {
    db.close();
  }
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

interface Manifest {
  earliest: string;
  latest: string;
}

function readManifest(outDir: string): Manifest | null {
  const p = resolve(outDir, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function writeManifest(outDir: string, date: string, existing: Manifest | null) {
  const manifest: Manifest = {
    earliest: existing
      ? date < existing.earliest
        ? date
        : existing.earliest
      : date,
    latest: existing
      ? date > existing.latest
        ? date
        : existing.latest
      : date,
  };
  writeFileSync(
    resolve(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface ScoreDayOptions {
  quiet?: boolean;        // suppress per-day log lines (useful when called from backfill)
  skipManifest?: boolean; // skip manifest update (backfill writes it once at the end)
}

export async function scoreDay(
  date: string,
  dbPath: string,
  outDir: string,
  { quiet = false, skipManifest = false }: ScoreDayOptions = {}
) {
  const say = (msg: string) => { if (!quiet) log(msg); };

  say(`Scoring ${date} from ${dbPath}`);

  const [startMs, endMs] = pacificDayBoundariesMs(date);
  say(
    `Pacific window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`
  );

  const readings = queryDay(dbPath, startMs, endMs);
  say(`Found ${readings.length} readings`);

  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `${date}.json`);

  if (readings.length === 0) {
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          date,
          generatedAt: new Date().toISOString(),
          healthScore: null,
          totalMinutes: 0,
          categories: { good: 0, moderate: 0, usg: 0, unhealthy: 0, veryUnhealthy: 0, hazardous: 0 },
          peakAqi: null,
          averagePm25: null,
        },
        null,
        2
      )
    );
    say(`No readings for ${date} — wrote empty score file`);
  } else {
    const score = computeScore(readings);
    writeFileSync(
      outFile,
      JSON.stringify({ date, generatedAt: new Date().toISOString(), ...score }, null, 2)
    );
    say(`Wrote ${outFile} (score=${score.healthScore})`);
  }

  if (!skipManifest) {
    const existing = readManifest(outDir);
    writeManifest(outDir, date, existing);
    say(`Updated manifest`);
  }
}

// Only run main() when invoked directly (not imported by backfill.ts)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetDate = DATE_ARG ?? yesterdayPacific();
  scoreDay(targetDate, DB_PATH, OUT_DIR).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
