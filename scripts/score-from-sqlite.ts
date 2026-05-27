import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore, type SensorReading } from "./aqi.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DataTable = "envdata" | "agg_envdata";
export type Resolution = "minute" | "hourly";

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

export function toPacificDateStr(utcDate: Date): string {
  return utcDate.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

export function yesterdayPacific(): string {
  return toPacificDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

/**
 * Returns [startMs, endMs) in milliseconds UTC for the given Pacific calendar day.
 * Correctly handles DST — America/Los_Angeles offset is auto-detected via Intl.
 */
export function pacificDayBoundariesMs(dateStr: string): [number, number] {
  const midnightApprox = new Date(`${dateStr}T08:00:00.000Z`);
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

  const offsetMs = (pacificHour * 60 + pacificMin) * 60 * 1000;
  const startMs = midnightApprox.getTime() - offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000;

  return [startMs, endMs];
}

// ── SQLite query ──────────────────────────────────────────────────────────────

interface DbRow {
  t: number;  // aliased time column (works for both `time` and `hour`)
  P25: number;
}

/**
 * Query one Pacific day's readings from either table.
 *
 * envdata:     minute-level, time column = `time`
 * agg_envdata: hourly aggregates, time column = `hour`
 *              computeScore() infers ~60 min duration per row from the gaps,
 *              so totalMinutes comes out correctly at ~1440 even with 24 rows.
 */
function queryDay(
  dbPath: string,
  startMs: number,
  endMs: number,
  table: DataTable
): SensorReading[] {
  const timeCol = table === "agg_envdata" ? "hour" : "time";
  const db = new Database(dbPath, { readonly: true });

  try {
    // Sample one row to detect timestamp unit (ms vs seconds)
    const sample = db
      .prepare(`SELECT ${timeCol} AS t FROM ${table} ORDER BY ${timeCol} DESC LIMIT 1`)
      .get() as { t: number } | undefined;

    const isSeconds = sample !== undefined && sample.t < 1e12;
    const qStart = isSeconds ? Math.floor(startMs / 1000) : startMs;
    const qEnd   = isSeconds ? Math.floor(endMs   / 1000) : endMs;

    const rows = db
      .prepare(
        `SELECT ${timeCol} AS t, P25 FROM ${table}
         WHERE ${timeCol} >= ? AND ${timeCol} < ?
         ORDER BY ${timeCol}`
      )
      .all(qStart, qEnd) as DbRow[];

    return rows.map((r) => ({
      time: new Date(isSeconds ? r.t * 1000 : r.t).toISOString(),
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
    earliest: existing ? (date < existing.earliest ? date : existing.earliest) : date,
    latest:   existing ? (date > existing.latest   ? date : existing.latest)   : date,
  };
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// ── scoreDay ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export interface ScoreDayOptions {
  table?: DataTable;        // which DB table to read (default: "envdata")
  quiet?: boolean;          // suppress per-day log lines
  skipManifest?: boolean;   // skip manifest update (backfill writes once at the end)
}

export async function scoreDay(
  date: string,
  dbPath: string,
  outDir: string,
  { table = "envdata", quiet = false, skipManifest = false }: ScoreDayOptions = {}
) {
  const say = (msg: string) => { if (!quiet) log(msg); };
  const resolution: Resolution = table === "agg_envdata" ? "hourly" : "minute";

  say(`Scoring ${date} from ${table} (${resolution})`);

  const [startMs, endMs] = pacificDayBoundariesMs(date);
  say(`Pacific window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);

  const readings = queryDay(dbPath, startMs, endMs, table);
  say(`Found ${readings.length} readings`);

  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `${date}.json`);

  if (readings.length === 0) {
    writeFileSync(
      outFile,
      JSON.stringify({
        date,
        resolution,
        generatedAt: new Date().toISOString(),
        healthScore: null,
        totalMinutes: 0,
        categories: { good: 0, moderate: 0, usg: 0, unhealthy: 0, veryUnhealthy: 0, hazardous: 0 },
        peakAqi: null,
        averagePm25: null,
      }, null, 2)
    );
    say(`No readings for ${date} — wrote empty score file`);
  } else {
    const score = computeScore(readings);
    writeFileSync(
      outFile,
      JSON.stringify({
        date,
        resolution,
        generatedAt: new Date().toISOString(),
        ...score,
      }, null, 2)
    );
    say(`Wrote ${outFile} (score=${score.healthScore}, resolution=${resolution})`);
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
  // Daily cron always reads from envdata (minute-level)
  scoreDay(targetDate, DB_PATH, OUT_DIR, { table: "envdata" }).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
