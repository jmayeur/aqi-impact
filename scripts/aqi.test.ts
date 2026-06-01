import { describe, it, expect } from "vitest";
import { calculatePm25Aqi, categorizeAqi, computeScore } from "./aqi.ts";

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
