/**
 * One-time backfill: score every Pacific calendar day from the earliest
 * record in the DB through yesterday (or --to date), writing one JSON
 * file per day into the scores/ output directory.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts [--db /path/to/environment] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out /path/to/scores/]
 */

import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreDay, type DataTable } from "./score-from-sqlite.ts";

// ── Arg parsing ───────────────────────────────────────────────────────────────

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

// Dates before this cutover use agg_envdata (hourly); on/after use envdata (minute).
// Override with --cutover YYYY-MM-DD if the aggregation boundary differs.
const CUTOVER_DATE = getArg("--cutover") ?? "2026-05-28";

// ── Date helpers ──────────────────────────────────────────────────────────────

function toPacificDateStr(utcDate: Date): string {
  return utcDate.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

function yesterdayPacific(): string {
  return toPacificDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

/** Add N days to a YYYY-MM-DD string */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC to avoid DST edge cases
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Detect earliest Pacific date from DB */
function earliestDateInDb(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT MIN(hour) as minTime FROM agg_envdata")
      .get() as { minTime: number } | undefined;

    if (!row?.minTime) throw new Error("No data found in agg_envdata table");

    const isSeconds = row.minTime < 1e12;
    const epochMs = isSeconds ? row.minTime * 1000 : row.minTime;
    return toPacificDateStr(new Date(epochMs));
  } finally {
    db.close();
  }
}

// ── Manifest (final write after all days processed) ───────────────────────────

function writeFinalManifest(
  outDir: string,
  earliest: string,
  latest: string
) {
  writeFileSync(
    resolve(outDir, "manifest.json"),
    JSON.stringify({ earliest, latest }, null, 2)
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const toDate = getArg("--to") ?? yesterdayPacific();

  console.log(`Detecting earliest DB date from ${DB_PATH}...`);
  let fromDate = getArg("--from") ?? earliestDateInDb(DB_PATH);
  console.log(`Backfill range: ${fromDate} → ${toDate}`);

  if (fromDate > toDate) {
    console.log("Nothing to backfill (from > to).");
    return;
  }

  // Count days for progress reporting
  const msPerDay = 24 * 60 * 60 * 1000;
  const fromMs = new Date(`${fromDate}T12:00:00Z`).getTime();
  const toMs = new Date(`${toDate}T12:00:00Z`).getTime();
  const totalDays = Math.round((toMs - fromMs) / msPerDay) + 1;

  console.log(`Processing ${totalDays} days...\n`);

  let current = fromDate;
  let processed = 0;
  let errors = 0;

  while (current <= toDate) {
    try {
      // Pre-cutover: use hourly aggregates; on/after cutover: use minute-level data
      const table: DataTable = current < CUTOVER_DATE ? "agg_envdata" : "envdata";
      await scoreDay(current, DB_PATH, OUT_DIR, { table, quiet: true, skipManifest: true });
      processed++;
    } catch (err) {
      // Print errors on their own line so they don't get overwritten by the progress bar
      process.stdout.write("\n");
      console.error(`  ERROR on ${current}: ${(err as Error).message}`);
      errors++;
    }

    const pct = Math.round(((processed + errors) / totalDays) * 100);
    process.stdout.write(
      `\r  ${processed + errors}/${totalDays} (${pct}%) — ${current}  `
    );

    current = addDays(current, 1);
  }

  process.stdout.write("\n");
  console.log(`\nBackfill complete: ${processed} scored, ${errors} errors`);

  // Write the authoritative final manifest covering the full range
  writeFinalManifest(OUT_DIR, fromDate, toDate);
  console.log(`Manifest written: earliest=${fromDate}, latest=${toDate}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
