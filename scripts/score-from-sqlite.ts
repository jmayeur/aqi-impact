import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore, calculatePm25Aqi, type SensorReading } from "./aqi.ts";

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
 * Returns the UTC millisecond timestamp of midnight Pacific time for a given
 * YYYY-MM-DD date string. Uses T08:00Z as the probe point (always within an
 * hour of Pacific midnight regardless of DST offset).
 */
function pacificMidnightMs(dateStr: string): number {
  const approx = new Date(`${dateStr}T08:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(approx);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const offsetMs =
    (parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10)) * 60_000;
  return approx.getTime() - offsetMs;
}

/**
 * Returns [startMs, endMs) in milliseconds UTC for the given Pacific calendar day.
 * Handles DST correctly: spring-forward days are 23 hours, fall-back days 25 hours.
 * endMs is computed independently (not startMs + 86400000) so DST transitions are exact.
 */
export function pacificDayBoundariesMs(dateStr: string): [number, number] {
  const startMs = pacificMidnightMs(dateStr);
  // Advance one calendar day at noon UTC (safe midpoint, never crosses a date boundary)
  const nextDay = new Date(`${dateStr}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endMs = pacificMidnightMs(nextDay.toISOString().slice(0, 10));
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

// ── Extras query (hourly path only) ──────────────────────────────────────────

interface DayExtras {
  peakP25: number | null;
  tempHigh: number | null;
  tempLow: number | null;
  humidityHigh: number | null;
  humidityLow: number | null;
}

/**
 * For historical (agg_envdata) days, pull supplementary data in one DB open:
 *   - True peak P25 from hourly_peak_envdata → more accurate peakAqi
 *   - Daily temp/humidity high (from peak table) and low (from avg table)
 */
function queryDayExtras(
  dbPath: string,
  startMs: number,
  endMs: number,
): DayExtras {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Detect timestamp unit via agg_envdata (same epoch format across tables)
    const sample = db
      .prepare("SELECT hour AS t FROM agg_envdata ORDER BY hour DESC LIMIT 1")
      .get() as { t: number } | undefined;

    const isSeconds = sample !== undefined && sample.t < 1e12;
    const qStart = isSeconds ? Math.floor(startMs / 1000) : startMs;
    const qEnd   = isSeconds ? Math.floor(endMs   / 1000) : endMs;

    // Peak P25, daily temp high, humidity high from the peak table
    const peakRow = db
      .prepare(
        `SELECT MAX(P25) AS peakP25,
                MAX(output_temp) AS tempHigh,
                MAX(output_humidity) AS humidityHigh
         FROM hourly_peak_envdata
         WHERE hour >= ? AND hour < ?`
      )
      .get(qStart, qEnd) as {
        peakP25: number | null;
        tempHigh: number | null;
        humidityHigh: number | null;
      } | undefined;

    // Daily temp low and humidity low from the hourly-average table
    const avgRow = db
      .prepare(
        `SELECT MIN(output_temp) AS tempLow,
                MIN(output_humidity) AS humidityLow
         FROM agg_envdata
         WHERE hour >= ? AND hour < ?`
      )
      .get(qStart, qEnd) as {
        tempLow: number | null;
        humidityLow: number | null;
      } | undefined;

    return {
      peakP25:      peakRow?.peakP25 ?? null,
      tempHigh:     peakRow?.tempHigh     != null ? Math.round(peakRow.tempHigh * 10) / 10 : null,
      tempLow:      avgRow?.tempLow       != null ? Math.round(avgRow.tempLow   * 10) / 10 : null,
      humidityHigh: peakRow?.humidityHigh != null ? Math.round(peakRow.humidityHigh)        : null,
      humidityLow:  avgRow?.humidityLow   != null ? Math.round(avgRow.humidityLow)           : null,
    };
  } finally {
    db.close();
  }
}

/**
 * For minute-level (envdata) days, pull daily temp/humidity high/low directly
 * from the same table. No peak table exists for recent data — computeScore()
 * already gives an accurate peakAqi from the per-minute readings.
 */
function queryEnvdataWeather(
  dbPath: string,
  startMs: number,
  endMs: number,
): DayExtras {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sample = db
      .prepare("SELECT time AS t FROM envdata ORDER BY time DESC LIMIT 1")
      .get() as { t: number } | undefined;

    const isSeconds = sample !== undefined && sample.t < 1e12;
    const qStart = isSeconds ? Math.floor(startMs / 1000) : startMs;
    const qEnd   = isSeconds ? Math.floor(endMs   / 1000) : endMs;

    const row = db
      .prepare(
        `SELECT MAX(output_temp) AS tempHigh,
                MIN(output_temp) AS tempLow,
                MAX(output_humidity) AS humidityHigh,
                MIN(output_humidity) AS humidityLow
         FROM envdata
         WHERE time >= ? AND time < ?`
      )
      .get(qStart, qEnd) as {
        tempHigh: number | null;
        tempLow: number | null;
        humidityHigh: number | null;
        humidityLow: number | null;
      } | undefined;

    return {
      peakP25:      null,  // not needed — computeScore() is exact with minute data
      tempHigh:     row?.tempHigh     != null ? Math.round(row.tempHigh     * 10) / 10 : null,
      tempLow:      row?.tempLow      != null ? Math.round(row.tempLow      * 10) / 10 : null,
      humidityHigh: row?.humidityHigh != null ? Math.round(row.humidityHigh)            : null,
      humidityLow:  row?.humidityLow  != null ? Math.round(row.humidityLow)             : null,
    };
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

  // Fetch weather extras for both paths — hourly uses peak table, minute uses envdata directly
  const extras = table === "agg_envdata"
    ? queryDayExtras(dbPath, startMs, endMs)
    : queryEnvdataWeather(dbPath, startMs, endMs);

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
        tempHigh: extras?.tempHigh ?? null,
        tempLow: extras?.tempLow ?? null,
        humidityHigh: extras?.humidityHigh ?? null,
        humidityLow: extras?.humidityLow ?? null,
      }, null, 2)
    );
    say(`No readings for ${date} — wrote empty score file`);
  } else {
    const score = computeScore(readings);

    // Override peakAqi with the true hourly-peak value when available —
    // hourly averages understate the real intra-hour spike.
    const peakAqi = extras?.peakP25 != null
      ? calculatePm25Aqi(extras.peakP25)
      : score.peakAqi;

    writeFileSync(
      outFile,
      JSON.stringify({
        date,
        resolution,
        generatedAt: new Date().toISOString(),
        ...score,
        peakAqi,
        tempHigh: extras?.tempHigh ?? null,
        tempLow: extras?.tempLow ?? null,
        humidityHigh: extras?.humidityHigh ?? null,
        humidityLow: extras?.humidityLow ?? null,
      }, null, 2)
    );
    say(`Wrote ${outFile} (score=${score.healthScore}, peakAqi=${peakAqi}, resolution=${resolution})`);
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
