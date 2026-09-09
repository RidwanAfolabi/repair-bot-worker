// Brand-tab matching. Pure functions, no D1, no network.

import { describe, it, expect } from "vitest";
import { matchBrandTab, matchBrandFromHistory, findFallbackTab } from "../src/pricing.js";

const TABS = [
  "iPhone", "Huawei", "Oppo", "Vivo", "Samsung", "Realme", "Redmi",
  "Xiaomi", "Infinix / Tecno", "iPad", "One Plus", "Services & Accessories",
];

describe("matchBrandTab — direct tab-name matches", () => {
  it("matches a tab name mentioned directly", () => {
    expect(matchBrandTab("harga screen samsung a54", TABS)).toBe("Samsung");
    expect(matchBrandTab("oppo reno 2 skrin pecah", TABS)).toBe("Oppo");
  });

  it("matches either half of a combined tab", () => {
    expect(matchBrandTab("infinix note 30", TABS)).toBe("Infinix / Tecno");
    expect(matchBrandTab("tecno spark 10", TABS)).toBe("Infinix / Tecno");
  });

  it("matches 'OnePlus' against the spaced tab title 'One Plus'", () => {
    expect(matchBrandTab("oneplus 11 battery", TABS)).toBe("One Plus");
  });

  it("returns null when nothing matches", () => {
    expect(matchBrandTab("nak tanya operating hours", TABS)).toBeNull();
  });
});

describe("matchBrandTab — Huawei-family product lines (no 'Huawei' mentioned)", () => {
  // The real bug report: customers ask about Honor/Nova/Mate models directly
  // and essentially never say "Huawei", even though every one of those
  // models lives in the sheet's single "Huawei" tab.
  it("REGRESSION: 'Honor X9c' resolves to the Huawei tab", () => {
    expect(matchBrandTab("harga skrin honor x9c berapa", TABS)).toBe("Huawei");
  });

  it("REGRESSION: 'Nova 11' resolves to the Huawei tab", () => {
    expect(matchBrandTab("nova 11 battery rosak", TABS)).toBe("Huawei");
  });

  it("REGRESSION: 'Mate 50 Pro' resolves to the Huawei tab", () => {
    expect(matchBrandTab("mate 50 pro screen crack", TABS)).toBe("Huawei");
  });

  it("is case-insensitive, same as every other brand match", () => {
    expect(matchBrandTab("HONOR x9c", TABS)).toBe("Huawei");
    expect(matchBrandTab("Nova", TABS)).toBe("Huawei");
  });
});

describe("matchBrandTab — REGRESSION: whole-word aliasing, not bare substring", () => {
  // A naive `.includes()` alias check would also fire on these — both are
  // plausible things a customer actually types in a repair-price chat.
  it("'estimate' does NOT trigger the Huawei alias via 'MATE'", () => {
    expect(matchBrandTab("boleh bagi estimate harga tak", TABS)).toBeNull();
  });

  it("'innovation' does NOT trigger the Huawei alias via 'NOVA'", () => {
    expect(matchBrandTab("some innovation in phone tech", TABS)).toBeNull();
  });

  it("a real brand mention still wins even when an unrelated alias-lookalike word is also present", () => {
    // "estimate" is present (would be a false Huawei hit pre-fix), but the
    // customer actually named Samsung directly — direct match must win.
    expect(matchBrandTab("can i get an estimate for samsung s23 screen", TABS)).toBe("Samsung");
  });

  it("the existing Apple alias is unaffected by the switch to word-boundary matching", () => {
    expect(matchBrandTab("apple battery replacement", TABS)).toBe("iPhone");
  });

  it("'pineapple' does not falsely trigger the Apple alias either", () => {
    expect(matchBrandTab("pineapple juice recipe", TABS)).toBeNull();
  });
});

describe("matchBrandTab — direct match still wins over alias expansion", () => {
  it("an explicit iPad mention is not overridden by an incidental Apple/Honor-style alias", () => {
    expect(matchBrandTab("ipad pro screen", TABS)).toBe("iPad");
  });
});

describe("matchBrandFromHistory", () => {
  it("finds the most recent brand mention, searching backward", () => {
    const history = [
      { text: "hi" },
      { text: "honor x9c skrin pecah" },
      { text: "berapa harga" },
    ];
    expect(matchBrandFromHistory(history, TABS)).toBe("Huawei");
  });

  it("returns null when no message in history mentions a brand", () => {
    const history = [{ text: "hi" }, { text: "ok thanks" }];
    expect(matchBrandFromHistory(history, TABS)).toBeNull();
  });
});

describe("findFallbackTab", () => {
  it("finds the Services & Accessories tab regardless of the & character", () => {
    expect(findFallbackTab(TABS)).toBe("Services & Accessories");
  });
});
