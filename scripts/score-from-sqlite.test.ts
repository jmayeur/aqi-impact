import { describe, it, expect } from "vitest";
import { toPacificDateStr, pacificDayBoundariesMs } from "./score-from-sqlite.ts";

// ── toPacificDateStr ──────────────────────────────────────────────────────────

describe("toPacificDateStr", () => {
  it("converts a UTC date to the correct Pacific date string (PDT)", () => {
    // 2026-05-01T08:00:00Z = May 1, 2026 01:00 PDT → still May 1
    expect(toPacificDateStr(new Date("2026-05-01T08:00:00Z"))).toBe("2026-05-01");
  });

  it("rolls the date back across Pacific midnight (PDT)", () => {
    // 2026-05-01T06:59:00Z = April 30 at 23:59 PDT → April 30
    expect(toPacificDateStr(new Date("2026-05-01T06:59:00Z"))).toBe("2026-04-30");
    // 2026-05-01T07:01:00Z = May 1 at 00:01 PDT → May 1
    expect(toPacificDateStr(new Date("2026-05-01T07:01:00Z"))).toBe("2026-05-01");
  });

  it("handles PST (winter, UTC-8) offset correctly", () => {
    // 2026-01-15T07:59:00Z = Jan 14 at 23:59 PST → still Jan 14
    expect(toPacificDateStr(new Date("2026-01-15T07:59:00Z"))).toBe("2026-01-14");
    // 2026-01-15T08:01:00Z = Jan 15 at 00:01 PST → Jan 15
    expect(toPacificDateStr(new Date("2026-01-15T08:01:00Z"))).toBe("2026-01-15");
  });
});

// ── pacificDayBoundariesMs ────────────────────────────────────────────────────

describe("pacificDayBoundariesMs", () => {
  it("returns correct UTC boundaries for a PDT day (UTC-7)", () => {
    // 2026-05-01 midnight PDT = 07:00 UTC
    const [start, end] = pacificDayBoundariesMs("2026-05-01");
    expect(new Date(start).toISOString()).toBe("2026-05-01T07:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-05-02T07:00:00.000Z");
  });

  it("returns correct UTC boundaries for a PST day (UTC-8)", () => {
    // 2026-01-15 midnight PST = 08:00 UTC
    const [start, end] = pacificDayBoundariesMs("2026-01-15");
    expect(new Date(start).toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("returns a 86400000ms range for a normal day", () => {
    const [start, end] = pacificDayBoundariesMs("2026-05-01");
    expect(end - start).toBe(86_400_000);
  });

  it("handles spring-forward: 2026-03-08 is a 23-hour day", () => {
    // Clocks spring forward at 2:00 AM PST → 3:00 AM PDT
    // Midnight starts at 08:00 UTC (PST), next midnight is 07:00 UTC (PDT)
    const [start, end] = pacificDayBoundariesMs("2026-03-08");
    expect(new Date(start).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(end - start).toBe(23 * 60 * 60 * 1000);
  });

  it("handles fall-back: 2026-11-01 is a 25-hour day", () => {
    // Clocks fall back at 2:00 AM PDT → 1:00 AM PST
    // Midnight starts at 07:00 UTC (PDT), next midnight is 08:00 UTC (PST)
    const [start, end] = pacificDayBoundariesMs("2026-11-01");
    expect(new Date(start).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(end - start).toBe(25 * 60 * 60 * 1000);
  });
});
