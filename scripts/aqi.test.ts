import { describe, it, expect } from "vitest";
import { calculatePm25Aqi, categorizeAqi, computeScore, epaCorrectedPm25 } from "./aqi.ts";

// ── calculatePm25Aqi ──────────────────────────────────────────────────────────

describe("calculatePm25Aqi", () => {
  it("returns 0 at 0 µg/m³", () => {
    expect(calculatePm25Aqi(0)).toBe(0);
  });

  it("returns 50 at the Good ceiling (9.0 µg/m³)", () => {
    expect(calculatePm25Aqi(9.0)).toBe(50);
  });

  it("returns 51 at the Moderate floor (9.1 µg/m³)", () => {
    expect(calculatePm25Aqi(9.1)).toBe(51);
  });

  it("returns 100 at the Moderate ceiling (35.4 µg/m³)", () => {
    expect(calculatePm25Aqi(35.4)).toBe(100);
  });

  it("returns 101 at the USG floor (35.5 µg/m³)", () => {
    expect(calculatePm25Aqi(35.5)).toBe(101);
  });

  it("returns 150 at the USG ceiling (55.4 µg/m³)", () => {
    expect(calculatePm25Aqi(55.4)).toBe(150);
  });

  it("returns 151 at the Unhealthy floor (55.5 µg/m³)", () => {
    expect(calculatePm25Aqi(55.5)).toBe(151);
  });

  it("returns 200 at the Unhealthy ceiling (125.4 µg/m³)", () => {
    expect(calculatePm25Aqi(125.4)).toBe(200);
  });

  it("returns 201 at the Very Unhealthy floor (125.5 µg/m³)", () => {
    expect(calculatePm25Aqi(125.5)).toBe(201);
  });

  it("returns 500 at the Hazardous ceiling (325.4 µg/m³)", () => {
    expect(calculatePm25Aqi(325.4)).toBe(500);
  });

  it("returns 500 above the highest breakpoint", () => {
    expect(calculatePm25Aqi(500)).toBe(500);
  });

  it("truncates to 1 decimal per EPA convention (9.19 → 9.1)", () => {
    expect(calculatePm25Aqi(9.19)).toBe(calculatePm25Aqi(9.1));
  });
});

// ── categorizeAqi ─────────────────────────────────────────────────────────────

describe("categorizeAqi", () => {
  it("categorizes 0–50 as good", () => {
    expect(categorizeAqi(0)).toBe("good");
    expect(categorizeAqi(50)).toBe("good");
  });

  it("categorizes 51–100 as moderate", () => {
    expect(categorizeAqi(51)).toBe("moderate");
    expect(categorizeAqi(100)).toBe("moderate");
  });

  it("categorizes 101–150 as usg", () => {
    expect(categorizeAqi(101)).toBe("usg");
    expect(categorizeAqi(150)).toBe("usg");
  });

  it("categorizes 151–200 as unhealthy", () => {
    expect(categorizeAqi(151)).toBe("unhealthy");
    expect(categorizeAqi(200)).toBe("unhealthy");
  });

  it("categorizes 201–300 as veryUnhealthy", () => {
    expect(categorizeAqi(201)).toBe("veryUnhealthy");
    expect(categorizeAqi(300)).toBe("veryUnhealthy");
  });

  it("categorizes 301+ as hazardous", () => {
    expect(categorizeAqi(301)).toBe("hazardous");
    expect(categorizeAqi(500)).toBe("hazardous");
  });
});

// ── computeScore ──────────────────────────────────────────────────────────────

describe("computeScore", () => {
  it("throws on an empty readings array", () => {
    expect(() => computeScore([])).toThrow();
  });

  it("returns healthScore 100 when all readings are Good", () => {
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 2 },
      { time: "2026-05-01T00:01:00Z", p25: 4 },
      { time: "2026-05-01T00:02:00Z", p25: 6 },
    ];
    const result = computeScore(readings);
    expect(result.healthScore).toBe(100);
    expect(result.categories.good).toBeGreaterThan(0);
    expect(result.peakAqi).toBeLessThanOrEqual(50);
  });

  it("returns healthScore 0 when all readings are Unhealthy or worse", () => {
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 60 },
      { time: "2026-05-01T00:01:00Z", p25: 70 },
      { time: "2026-05-01T00:02:00Z", p25: 80 },
    ];
    const result = computeScore(readings);
    expect(result.healthScore).toBe(0);
    expect(result.categories.good).toBe(0);
  });

  it("infers ~60 min duration per reading from hourly timestamps", () => {
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 5 },
      { time: "2026-05-01T01:00:00Z", p25: 5 },
      { time: "2026-05-01T02:00:00Z", p25: 5 },
    ];
    const result = computeScore(readings);
    expect(result.totalMinutes).toBeCloseTo(180, 0);
  });

  it("identifies the peak AQI across all readings", () => {
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 5 },   // Good
      { time: "2026-05-01T00:01:00Z", p25: 60 },  // Unhealthy
      { time: "2026-05-01T00:02:00Z", p25: 3 },   // Good
    ];
    const result = computeScore(readings);
    expect(result.peakAqi).toBe(calculatePm25Aqi(60));
  });

  it("computes averagePm25 as mean of all readings (1 decimal)", () => {
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 10 },
      { time: "2026-05-01T00:01:00Z", p25: 20 },
    ];
    const result = computeScore(readings);
    expect(result.averagePm25).toBe(15);
  });

  it("splits minutes correctly across categories", () => {
    // One Good minute, one Moderate minute
    const readings = [
      { time: "2026-05-01T00:00:00Z", p25: 5 },   // Good,     AQI ~28
      { time: "2026-05-01T00:01:00Z", p25: 12 },  // Moderate, AQI ~56
    ];
    const result = computeScore(readings);
    expect(result.categories.good).toBeGreaterThan(0);
    expect(result.categories.moderate).toBeGreaterThan(0);
    expect(result.healthScore).toBeGreaterThan(0);
    expect(result.healthScore).toBeLessThan(100);
  });
});

// ── epaCorrectedPm25 ──────────────────────────────────────────────────────────

describe("epaCorrectedPm25", () => {
  it("matches the Barkjohn 2021 equation below 30 µg/m³", () => {
    // 0.524 * 20 - 0.0862 * 50 + 5.75
    expect(epaCorrectedPm25(20, 50)).toBeCloseTo(11.92, 2);
  });

  it("uses the high-concentration fit above 260 µg/m³", () => {
    // 2.966 + 0.69 * 300 + 8.84e-4 * 300^2
    expect(epaCorrectedPm25(300, 50)).toBeCloseTo(289.526, 2);
  });

  it.each([30, 50, 210, 260])("is continuous at the %d µg/m³ breakpoint", (x) => {
    expect(epaCorrectedPm25(x - 1e-9, 40)).toBeCloseTo(epaCorrectedPm25(x, 40), 4);
  });

  it("never goes negative in clean, humid air", () => {
    expect(epaCorrectedPm25(0, 95)).toBe(0);
  });

  it("clamps RH to 0–100", () => {
    expect(epaCorrectedPm25(10, 120)).toBe(epaCorrectedPm25(10, 100));
  });
});

// ── computeScore options ──────────────────────────────────────────────────────

describe("computeScore options", () => {
  const minutes = (n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, start + i)).toISOString());

  it("applies the EPA correction when asked", () => {
    const readings = minutes(10).map((time) => ({ time, p25: 20, rh: 50 }));
    const score = computeScore(readings, new Date(), { correction: "epa" });
    expect(score.pm25Correction).toBe("epa");
    expect(score.averagePm25).toBeCloseTo(11.9, 1);
    // 20 µg/m³ raw is Moderate, 11.9 corrected is still Moderate (> 9.0)
    expect(score.categories.moderate).toBe(10);
  });

  it("requires rh on every reading for the EPA correction", () => {
    const readings = minutes(3).map((time) => ({ time, p25: 5 }));
    expect(() => computeScore(readings, new Date(), { correction: "epa" })).toThrow();
  });

  it("does not credit an outage to the reading that ends it", () => {
    // 10 good minutes, a 6-hour outage, then one moderate reading
    const readings = [
      ...minutes(10).map((time) => ({ time, p25: 3 })),
      { time: new Date(Date.UTC(2026, 0, 1, 6, 10)).toISOString(), p25: 20 },
    ];
    const uncapped = computeScore(readings);
    const capped = computeScore(readings, new Date(), { maxGapMinutes: 5 });
    expect(uncapped.categories.moderate).toBe(361);
    expect(capped.categories.moderate).toBe(5);
    expect(capped.totalMinutes).toBe(15);
  });
});
