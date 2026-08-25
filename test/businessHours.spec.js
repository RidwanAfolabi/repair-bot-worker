// Pure unit tests — no D1, no worker.
//
// The bot used to tell customers "yes we're open" at 8am because nothing in
// the prompt told it what time it was. These pin the boundaries so a change
// to opening hours can't silently break the open/closed answer.

import { describe, it, expect } from "vitest";
import {
  getBusinessTimeContext,
  formatBusinessTimeContext,
  OPERATING_HOURS_LABEL,
} from "../src/businessHours.js";
import { buildSystemPrompt } from "../src/prompt.js";

// Malaysia is UTC+8 with no DST, so local = UTC + 8, always.
function malaysia(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

describe("open / closed boundaries", () => {
  const cases = [
    ["00:00 midnight",      malaysia(2026, 8, 12, 0, 0),   false],
    ["08:00 the reported bug case", malaysia(2026, 8, 12, 8, 0), false],
    ["09:59 one minute early",      malaysia(2026, 8, 12, 9, 59), false],
    ["10:00 exactly open",  malaysia(2026, 8, 12, 10, 0),  true],
    ["15:00 mid-day",       malaysia(2026, 8, 12, 15, 0),  true],
    ["21:29 last minute",   malaysia(2026, 8, 12, 21, 29), true],
    ["21:30 exactly close", malaysia(2026, 8, 12, 21, 30), false],
    ["23:00 after close",   malaysia(2026, 8, 12, 23, 0),  false],
  ];

  for (const [label, when, expected] of cases) {
    it(`${label} → ${expected ? "open" : "closed"}`, () => {
      expect(getBusinessTimeContext(when).isOpen).toBe(expected);
    });
  }

  it("opens on Sundays too — no weekend gating", () => {
    const sunday = malaysia(2026, 8, 16, 12, 0);
    const ctx = getBusinessTimeContext(sunday);
    expect(ctx.weekday).toBe("Sunday");
    expect(ctx.isOpen).toBe(true);
  });
});

describe("closing-soon flag", () => {
  it("flags the last 30 minutes", () => {
    const ctx = getBusinessTimeContext(malaysia(2026, 8, 12, 21, 15));
    expect(ctx.isClosingSoon).toBe(true);
    expect(ctx.minutesUntilClose).toBe(15);
  });

  it("does not flag mid-afternoon", () => {
    expect(getBusinessTimeContext(malaysia(2026, 8, 12, 15, 0)).isClosingSoon).toBe(false);
  });
});

describe("prompt injection", () => {
  it("states CLOSED plainly, and forbids claiming otherwise", () => {
    const block = formatBusinessTimeContext(malaysia(2026, 8, 12, 8, 0));
    expect(block).toContain("CLOSED right now");
    expect(block).toContain("do not say");
    expect(block).toContain(OPERATING_HOURS_LABEL);
  });

  it("states OPEN plainly mid-day", () => {
    const block = formatBusinessTimeContext(malaysia(2026, 8, 12, 15, 0));
    expect(block).toContain("OPEN right now");
    expect(block).not.toContain("CLOSED right now");
  });

  it("buildSystemPrompt injects the live block", () => {
    expect(buildSystemPrompt("", malaysia(2026, 8, 12, 8, 0))).toContain("CLOSED right now");
    expect(buildSystemPrompt("", malaysia(2026, 8, 12, 15, 0))).toContain("OPEN right now");
  });

  it("defaults to the real current time when no date is passed", () => {
    expect(buildSystemPrompt()).toContain("CURRENT TIME");
  });

  it("still accepts pricing context as the first argument", () => {
    expect(buildSystemPrompt("## CURRENT PRICING\nrows")).toContain("## CURRENT PRICING");
  });
});
