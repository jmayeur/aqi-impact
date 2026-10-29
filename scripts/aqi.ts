export type Category =
  | "good"
  | "moderate"
  | "usg"
  | "unhealthy"
  | "veryUnhealthy"
  | "hazardous";

export interface SensorReading {
  time: string; // ISO 8601
  p25: number;  // PM2.5 µg/m³ (PMS5003 CF=1)
  rh?: number;  // the sensor's own relative humidity, %, used by the EPA correction
}

export type Pm25Correction = "epa" | "none";

export interface ScoreOptions {
  correction?: Pm25Correction; // "epa" requires rh on every reading
  maxGapMinutes?: number;      // a reading covers at most this long a gap before it
}

export interface ScoreResult {
  generatedAt: string;
  lastAttemptAt: string;
  stale: boolean;
  healthScore: number;
  totalMinutes: number;      // minutes covered by readings (gaps beyond maxGapMinutes excluded)
  pm25Correction: Pm25Correction;
  categories: Record<Category, number>;
  peakAqi: number;
  averagePm25: number;
}

// EPA 2024 PM2.5 AQI breakpoints
// [BP_lo, BP_hi, I_lo, I_hi]
const BREAKPOINTS: [number, number, number, number][] = [
  [0.0,   9.0,   0,   50],
  [9.1,  35.4,  51,  100],
  [35.5, 55.4, 101,  150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

export function calculatePm25Aqi(concentration: number): number {
  // Truncate to 1 decimal per EPA convention
  const c = Math.floor(concentration * 10) / 10;

  for (const [bpLo, bpHi, iLo, iHi] of BREAKPOINTS) {
    if (c >= bpLo && c <= bpHi) {
      return Math.round(((iHi - iLo) / (bpHi - bpLo)) * (c - bpLo) + iLo);
    }
  }

  // Above highest breakpoint
  return 500;
}

/**
 * EPA US-wide correction for PMS5003-based sensors (PurpleAir), from CF=1 PM2.5 and
 * the sensor's own RH: Barkjohn et al. 2021 (AMT 14, 4617) below 50 µg/m³, with the
 * 2022 extension used by the AirNow Fire and Smoke Map for smoke-level readings.
 * Uncorrected, these sensors read roughly 40% high, and up to ~2x high in smoke.
 */
export function epaCorrectedPm25(cf1: number, rh: number): number {
  const x = Math.max(cf1, 0);
  const h = Math.min(Math.max(rh, 0), 100);
  let pm: number;
  if (x < 30) {
    pm = 0.524 * x - 0.0862 * h + 5.75;
  } else if (x < 50) {
    const w = x / 20 - 3 / 2;
    pm = (0.786 * w + 0.524 * (1 - w)) * x - 0.0862 * h + 5.75;
  } else if (x < 210) {
    pm = 0.786 * x - 0.0862 * h + 5.75;
  } else if (x < 260) {
    const w = x / 50 - 21 / 5;
    pm = (0.69 * w + 0.786 * (1 - w)) * x - 0.0862 * h * (1 - w) +
      2.966 * w + 5.75 * (1 - w) + 8.84e-4 * x * x * w;
  } else {
    pm = 2.966 + 0.69 * x + 8.84e-4 * x * x;
  }
  return Math.max(pm, 0);
}

export function categorizeAqi(aqi: number): Category {
  if (aqi <= 50)  return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "usg";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "veryUnhealthy";
  return "hazardous";
}

export function computeScore(
  readings: SensorReading[],
  now: Date = new Date(),
  { correction = "none", maxGapMinutes = Infinity }: ScoreOptions = {}
): Omit<ScoreResult, "generatedAt" | "lastAttemptAt" | "stale"> {
  if (readings.length === 0) {
    throw new Error("No readings to compute score from");
  }
  if (correction === "epa" && readings.some((r) => r.rh == null)) {
    throw new Error("EPA correction needs rh on every reading");
  }
  const pm25 = (r: SensorReading) =>
    correction === "epa" ? epaCorrectedPm25(r.p25, r.rh!) : r.p25;

  // Infer per-reading duration in minutes from timestamps when possible.
  // Each reading "owns" the time from the previous reading up to itself.
  // First reading gets the same interval as the second gap (or 1 min fallback).
  const sorted = [...readings].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );

  const durations: number[] = new Array(sorted.length).fill(1);
  if (sorted.length > 1) {
    for (let i = 1; i < sorted.length; i++) {
      const gapMs =
        new Date(sorted[i].time).getTime() -
        new Date(sorted[i - 1].time).getTime();
      // Cap the gap so an outage isn't credited to the reading that ends it
      durations[i] = Math.min(Math.max(gapMs / 60_000, 0.01), maxGapMinutes);
    }
    durations[0] = durations[1]; // mirror first gap onto first reading
  }

  const categories: Record<Category, number> = {
    good: 0,
    moderate: 0,
    usg: 0,
    unhealthy: 0,
    veryUnhealthy: 0,
    hazardous: 0,
  };

  let totalMinutes = 0;
  let goodMinutes = 0;
  let peakAqi = 0;
  let sumPm25 = 0;

  for (let i = 0; i < sorted.length; i++) {
    const p25 = pm25(sorted[i]);
    const aqi = calculatePm25Aqi(p25);
    const cat = categorizeAqi(aqi);
    const dur = durations[i];

    categories[cat] += dur;
    totalMinutes += dur;
    if (cat === "good") goodMinutes += dur;
    if (aqi > peakAqi) peakAqi = aqi;
    sumPm25 += p25;
  }

  const healthScore =
    Math.round((goodMinutes / totalMinutes) * 1000) / 10; // 1 decimal

  // Round category minutes to nearest minute for display
  const roundedCategories = Object.fromEntries(
    Object.entries(categories).map(([k, v]) => [k, Math.round(v)])
  ) as Record<Category, number>;

  return {
    healthScore,
    totalMinutes: Math.round(totalMinutes),
    pm25Correction: correction,
    categories: roundedCategories,
    peakAqi,
    averagePm25: Math.round((sumPm25 / sorted.length) * 10) / 10,
  };
}
