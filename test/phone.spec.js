// Pure unit tests — no D1, no worker, runs in milliseconds.
//
// Covers the identifier matching that gates who the bot will and will not
// talk to. Both real bugs here reached production: a delisted number that
// kept getting replies because the config had a "+" in it, and BSUIDs being
// mangled into fake phone numbers once WhatsApp usernames arrived.

import { describe, it, expect } from "vitest";
import { digitsOnly, normalizeId, isBsuid, phoneList, samePhone, displayId } from "../src/phone.js";

const BSUID = "MY.13491208655302741918";
const PHONE = "601155241769";

describe("digitsOnly", () => {
  it("strips every non-digit", () => {
    expect(digitsOnly("+60 (11) 5524-1769")).toBe(PHONE);
  });

  it("is safe on null and undefined", () => {
    expect(digitsOnly(undefined)).toBe("");
    expect(digitsOnly(null)).toBe("");
  });
});

describe("isBsuid", () => {
  it("recognises user and parent BSUIDs", () => {
    expect(isBsuid(BSUID)).toBe(true);
    expect(isBsuid("US.ENT.11815799212886844830")).toBe(true);
  });

  it("does not mistake a phone number for one", () => {
    expect(isBsuid(PHONE)).toBe(false);
    expect(isBsuid("+60 11-5524 1769")).toBe(false);
    expect(isBsuid("")).toBe(false);
    expect(isBsuid(undefined)).toBe(false);
  });
});

describe("normalizeId", () => {
  it("reduces phone numbers to digits, whatever the formatting", () => {
    expect(normalizeId("+60 11-5524 1769")).toBe(PHONE);
    expect(normalizeId(PHONE)).toBe(PHONE);
  });

  it("REGRESSION: leaves BSUIDs intact instead of digit-stripping them", () => {
    // digitsOnly(BSUID) is "13491208655302741918" — a plausible-looking
    // 20-digit phone number that is not a phone number at all. Comparing on
    // that would make every allowlist/delist decision meaningless.
    expect(digitsOnly(BSUID)).toBe("13491208655302741918");
    expect(normalizeId(BSUID)).toBe(BSUID);
  });

  it("upper-cases BSUIDs so casing never causes a miss", () => {
    expect(normalizeId(BSUID.toLowerCase())).toBe(BSUID);
  });
});

describe("phoneList", () => {
  it("accepts phone numbers and BSUIDs in one list", () => {
    expect(phoneList(`+${PHONE}, ${BSUID} , 60123456789`))
      .toEqual([PHONE, BSUID, "60123456789"]);
  });

  it("drops blanks and returns [] for unset config", () => {
    expect(phoneList("a,,b")).toEqual([]);          // no digits, not BSUIDs
    expect(phoneList(undefined)).toEqual([]);
    expect(phoneList("")).toEqual([]);
  });

  it("does not treat the wildcard as an identifier", () => {
    expect(phoneList("*")).toEqual([]);
  });
});

describe("samePhone", () => {
  it("matches the same number written differently", () => {
    expect(samePhone("+60 11-5524 1769", PHONE)).toBe(true);
  });

  it("matches BSUIDs regardless of case", () => {
    expect(samePhone(BSUID, BSUID.toLowerCase())).toBe(true);
  });

  it("never matches a BSUID against its own stripped digits", () => {
    expect(samePhone(BSUID, "13491208655302741918")).toBe(false);
  });

  it("REGRESSION: empty never matches empty, so unset config matches nobody", () => {
    // Guards the case where STAFF_WA_NUMBER is unset and a customer id also
    // normalises to "" — that must not make the customer staff.
    expect(samePhone("", "")).toBe(false);
    expect(samePhone(undefined, undefined)).toBe(false);
    expect(samePhone("abc", "xyz")).toBe(false);
  });
});

describe("displayId", () => {
  it("formats a phone number for staff", () => {
    expect(displayId(PHONE)).toBe(`+${PHONE}`);
  });

  it("shows name and username for a BSUID, since staff cannot search by id", () => {
    expect(displayId(BSUID, { username: "realsheena", name: "Sheena" }))
      .toBe(`Sheena @realsheena (${BSUID})`);
    expect(displayId(BSUID)).toBe(BSUID);
  });

  it("REGRESSION: never renders the literal string '+undefined'", () => {
    for (const v of [undefined, null, ""]) {
      expect(displayId(v)).toBe("unknown sender");
    }
  });
});
