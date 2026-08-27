// Branch routing for confirmed bookings, and the 24-hour-window fallback.

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/whatsapp.js", () => ({
  sendTextMessage:     vi.fn(async () => ({ ok: true, errorCode: null })),
  sendReadReceipt:     vi.fn(async () => ({ ok: true })),
  sendStaffAlert:      vi.fn(async () => ({ ok: true })),
  sendTemplateMessage: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/llm.js", () => ({ generateReply: vi.fn() }));
vi.mock("../src/googleSheets.js", () => ({
  getSheetTabs: vi.fn(async () => []), getPricingRows: vi.fn(async () => []),
}));

import { handleIncomingMessage } from "../src/bot.js";
import { parseBranchNumbers, resolveBranch } from "../src/branches.js";
import { initDb, saveMessage } from "../src/db.js";
import { generateReply } from "../src/llm.js";
import { sendTextMessage, sendStaffAlert, sendTemplateMessage } from "../src/whatsapp.js";

const C  = "60111111111";
const AS = "60123456789";   // Alor Setar
const BP = "60123456793";   // Balik Pulau
const BRANCHES = `Alor Setar=${AS},Changlun=60123456790,Pendang=60123456791,Pokok Sena=60123456792,Balik Pulau=${BP}`;

const booking = (branch) =>
  `Ok dah noted!\n\n[INTAKE]\nname: Amin\ndevice: iPhone 12\nfault: Skrin pecah\n` +
  (branch ? `branch: ${branch}\n` : "") + `time: Esok pagi\n[/INTAKE]`;

beforeEach(async () => {
  await initDb(env.DB);
  for (const t of ["conversations", "escalations", "intakes"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  for (const m of [sendTextMessage, sendStaffAlert, sendTemplateMessage]) vi.mocked(m).mockClear();
  vi.mocked(sendTextMessage).mockResolvedValue({ ok: true, errorCode: null });
  await saveMessage(env.DB, { senderId: C, role: "ai-assistant", text: "hi" });  // suppress notice
});

async function book(branch, envOverrides = {}) {
  vi.mocked(generateReply).mockResolvedValueOnce(booking(branch));
  const rowId = await saveMessage(env.DB, { senderId: C, role: "customer", text: "ok" });
  await handleIncomingMessage({
    senderId: C, incomingText: "ok",
    env: { ...env, MESSAGE_DEBOUNCE_MS: "0", BRANCH_NUMBERS: BRANCHES, ...envOverrides },
    messageRowId: rowId,
  });
}

const sentTo = () => vi.mocked(sendTextMessage).mock.calls.map(c => c[0]);


describe("parseBranchNumbers", () => {
  it("parses name=number pairs and normalises the number", () => {
    expect(parseBranchNumbers("Alor Setar=+60 12-345 6789")).toEqual([
      { name: "Alor Setar", key: "alorsetar", number: "60123456789" },
    ]);
  });

  it("skips malformed entries without losing the good ones", () => {
    const r = parseBranchNumbers("Alor Setar=60123456789,broken,=60111,Pendang=");
    expect(r.map(b => b.name)).toEqual(["Alor Setar"]);
  });

  it("returns [] for unset config", () => {
    expect(parseBranchNumbers(undefined)).toEqual([]);
    expect(parseBranchNumbers("")).toEqual([]);
  });
});

describe("resolveBranch", () => {
  it("matches however the LLM phrased it", () => {
    for (const text of ["Alor Setar", "alor setar", "ALOR SETAR", "cawangan Alor Setar", "kedai alor setar"]) {
      expect(resolveBranch(text, BRANCHES)?.number).toBe(AS);
    }
  });

  it("distinguishes between branches", () => {
    expect(resolveBranch("Balik Pulau", BRANCHES)?.number).toBe(BP);
    expect(resolveBranch("Pokok Sena", BRANCHES)?.name).toBe("Pokok Sena");
  });

  it("returns null rather than guessing", () => {
    expect(resolveBranch("Kuala Lumpur", BRANCHES)).toBeNull();
    expect(resolveBranch("", BRANCHES)).toBeNull();
    expect(resolveBranch(undefined, BRANCHES)).toBeNull();
    expect(resolveBranch("Alor Setar", undefined)).toBeNull();
  });
});


describe("booking is forwarded to the branch", () => {
  it("sends the alert to the matched branch number", async () => {
    await book("Alor Setar");
    expect(sentTo()).toContain(AS);
    const msg = vi.mocked(sendTextMessage).mock.calls.find(c => c[0] === AS)[1];
    expect(msg).toContain("New repair booking");
    expect(msg).toContain("Amin");
  }, 20000);

  it("still alerts the staff number as well", async () => {
    await book("Alor Setar");
    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
  }, 20000);

  it("routes a different branch to a different number", async () => {
    await book("Balik Pulau");
    expect(sentTo()).toContain(BP);
    expect(sentTo()).not.toContain(AS);
  }, 20000);

  it("an unknown or missing branch still reaches staff", async () => {
    await book("Kuala Lumpur");
    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
    expect(sentTo()).not.toContain(AS);

    vi.mocked(sendStaffAlert).mockClear();
    await book(null);
    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
  }, 25000);

  it("unset BRANCH_NUMBERS disables routing but keeps the staff alert", async () => {
    await book("Alor Setar", { BRANCH_NUMBERS: undefined });
    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
    expect(sentTo()).not.toContain(AS);
  }, 20000);
});


describe("the 24-hour window", () => {
  // 131047 = "more than 24 hours since the recipient last replied".
  const outsideWindow = () =>
    vi.mocked(sendTextMessage).mockImplementation(async (to) =>
      to === AS ? { ok: false, errorCode: 131047 } : { ok: true, errorCode: null });

  it("falls back to a template when the branch is outside the window", async () => {
    outsideWindow();
    await book("Alor Setar", { BRANCH_TEMPLATE_NAME: "branch_booking" });

    expect(vi.mocked(sendTemplateMessage)).toHaveBeenCalledTimes(1);
    const [to, tpl] = vi.mocked(sendTemplateMessage).mock.calls[0];
    expect(to).toBe(AS);
    expect(tpl.name).toBe("branch_booking");
    // Two params, not four: Meta rejects variable-dense templates and forbids
    // a variable at the start or end of the body.
    // Order must match the approved template body:
    //   {{1}} details, {{2}} preferred time, {{3}} contact
    expect(tpl.params).toHaveLength(3);
    expect(tpl.params[0]).toBe("Customer: Amin | Device: iPhone 12 | Fault: Skrin pecah | Branch: Alor Setar");
    expect(tpl.params[1]).toBe("Esok pagi");
    expect(tpl.params[2]).toBe(`+${C}`);        // falls back to the sender's own number
  }, 20000);

  it("does NOT burn a template on an unrelated send failure", async () => {
    vi.mocked(sendTextMessage).mockImplementation(async (to) =>
      to === AS ? { ok: false, errorCode: 131026 } : { ok: true, errorCode: null });
    await book("Alor Setar", { BRANCH_TEMPLATE_NAME: "branch_booking" });
    expect(vi.mocked(sendTemplateMessage)).not.toHaveBeenCalled();
  }, 20000);

  it("warns loudly when outside the window with no template configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    outsideWindow();
    await book("Alor Setar");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/outside the 24h window/);
    warn.mockRestore();
  }, 20000);

  it("no template is used when the plain message succeeds", async () => {
    await book("Alor Setar", { BRANCH_TEMPLATE_NAME: "branch_booking" });
    expect(vi.mocked(sendTemplateMessage)).not.toHaveBeenCalled();
  }, 20000);

  it("REGRESSION: a branch failure never costs the staff alert, the row, or the reply", async () => {
    vi.mocked(sendTextMessage).mockImplementation(async (to) => {
      if (to === AS) throw new Error("network down");
      return { ok: true, errorCode: null };
    });

    await book("Alor Setar");

    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM intakes").first()).n).toBe(1);
    expect(sentTo()).toContain(C);          // customer still got their reply
  }, 20000);
});


describe("branch numbers are not treated as customers", () => {
  it("REGRESSION: a branch messaging head office gets no AI reply", async () => {
    // Branches are told to message head office to keep the 24h window open.
    // Without folding BRANCH_NUMBERS into the delisted set, that habit would
    // make A'aisyah greet her own colleagues and start quoting them.
    const { default: worker } = await import("../src/index.js");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");

    vi.mocked(sendTextMessage).mockClear();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://x/webhook", { method: "POST", body: JSON.stringify({
        entry: [{ changes: [{ field: "messages", value: { messages: [
          { from: AS, id: "w.branch", type: "text", text: { body: "keeping window open" } },
        ]}}]}],
      })}),
      { ...env, MESSAGE_DEBOUNCE_MS: "0", TEST_ALLOWLIST: "*", BRANCH_NUMBERS: BRANCHES },
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(vi.mocked(sendTextMessage)).not.toHaveBeenCalled();
    const rows = (await env.DB.prepare("SELECT * FROM conversations WHERE sender_id = ?").bind(AS).all()).results;
    expect(rows).toHaveLength(0);
  }, 20000);

  it("a real customer is still served when BRANCH_NUMBERS is set", async () => {
    const { default: worker } = await import("../src/index.js");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");

    vi.mocked(generateReply).mockResolvedValueOnce("Boleh, RM230");
    vi.mocked(sendTextMessage).mockClear();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://x/webhook", { method: "POST", body: JSON.stringify({
        entry: [{ changes: [{ field: "messages", value: { messages: [
          { from: C, id: "w.cust", type: "text", text: { body: "berapa harga" } },
        ]}}]}],
      })}),
      { ...env, MESSAGE_DEBOUNCE_MS: "0", TEST_ALLOWLIST: "*", BRANCH_NUMBERS: BRANCHES },
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(vi.mocked(sendTextMessage).mock.calls.map(c => c[0])).toContain(C);
  }, 20000);
});


describe("delisting a branch does not block sending TO it", () => {
  // BRANCH_NUMBERS are folded into the delisted set so branch chatter is
  // ignored INBOUND. This proves the OUTBOUND direction is unaffected, going
  // through the real worker.fetch() path where `delisted` is actually built —
  // the earlier branch tests call handleIncomingMessage directly and never
  // touch that code, so they could not have caught a regression here.
  it("REGRESSION: a booking still reaches a branch that is delisted inbound", async () => {
    const { default: worker } = await import("../src/index.js");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");

    await saveMessage(env.DB, { senderId: C, role: "ai-assistant", text: "hi" });
    vi.mocked(generateReply).mockResolvedValueOnce(booking("Alor Setar"));
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(sendTextMessage).mockResolvedValue({ ok: true, errorCode: null });

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://x/webhook", { method: "POST", body: JSON.stringify({
        entry: [{ changes: [{ field: "messages", value: { messages: [
          { from: C, id: "w.e2e", type: "text", text: { body: "nak book" } },
        ]}}]}],
      })}),
      { ...env, MESSAGE_DEBOUNCE_MS: "0", TEST_ALLOWLIST: "*",
        BRANCH_NUMBERS: BRANCHES, STAFF_WA_NUMBER: "60199999999" },
      ctx
    );
    await waitOnExecutionContext(ctx);

    const targets = vi.mocked(sendTextMessage).mock.calls.map(c => c[0]);
    expect(targets).toContain(AS);   // branch received it despite being delisted
    expect(targets).toContain(C);    // customer still got their reply
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM intakes").first()).n).toBe(1);
  }, 25000);

  it("and that same branch number is still ignored inbound", async () => {
    const { default: worker } = await import("../src/index.js");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");

    vi.mocked(sendTextMessage).mockClear();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://x/webhook", { method: "POST", body: JSON.stringify({
        entry: [{ changes: [{ field: "messages", value: { messages: [
          { from: AS, id: "w.in", type: "text", text: { body: "hello" } },
        ]}}]}],
      })}),
      { ...env, MESSAGE_DEBOUNCE_MS: "0", TEST_ALLOWLIST: "*", BRANCH_NUMBERS: BRANCHES },
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(vi.mocked(sendTextMessage)).not.toHaveBeenCalled();
  }, 20000);
});


describe("template contact parameter", () => {
  const outsideWindow = () =>
    vi.mocked(sendTextMessage).mockImplementation(async (to) =>
      to === AS ? { ok: false, errorCode: 131047 } : { ok: true, errorCode: null });

  const lastParams = () => vi.mocked(sendTemplateMessage).mock.calls[0][1].params;

  it("uses the contact the customer gave, when they gave a different one", async () => {
    outsideWindow();
    vi.mocked(generateReply).mockResolvedValueOnce(
      `Ok!\n\n[INTAKE]\nname: Amin\ndevice: iPhone 12\nbranch: Alor Setar\ncontact: 0119876543\n[/INTAKE]`
    );
    const rowId = await saveMessage(env.DB, { senderId: C, role: "customer", text: "ok" });
    await handleIncomingMessage({
      senderId: C, incomingText: "ok",
      env: { ...env, MESSAGE_DEBOUNCE_MS: "0", BRANCH_NUMBERS: BRANCHES, BRANCH_TEMPLATE_NAME: "branch_booking" },
      messageRowId: rowId,
    });
    expect(lastParams()[2]).toBe("0119876543");
  }, 20000);

  it("says so plainly for a username customer with no number to dial", async () => {
    const BSUID = "MY.13491208655302741918";
    outsideWindow();
    vi.mocked(generateReply).mockResolvedValueOnce(booking("Alor Setar"));
    const rowId = await saveMessage(env.DB, { senderId: BSUID, role: "customer", text: "ok" });
    await handleIncomingMessage({
      senderId: BSUID, incomingText: "ok",
      env: { ...env, MESSAGE_DEBOUNCE_MS: "0", BRANCH_NUMBERS: BRANCHES, BRANCH_TEMPLATE_NAME: "branch_booking" },
      messageRowId: rowId,
    });
    expect(lastParams()[2]).toBe("WhatsApp only, no number shared");
  }, 20000);

  it("no parameter ever contains a newline, which Meta rejects", async () => {
    outsideWindow();
    vi.mocked(generateReply).mockResolvedValueOnce(booking("Alor Setar"));
    const rowId = await saveMessage(env.DB, { senderId: C, role: "customer", text: "ok" });
    await handleIncomingMessage({
      senderId: C, incomingText: "ok",
      env: { ...env, MESSAGE_DEBOUNCE_MS: "0", BRANCH_NUMBERS: BRANCHES, BRANCH_TEMPLATE_NAME: "branch_booking" },
      messageRowId: rowId,
    });
    for (const p of lastParams()) expect(String(p)).not.toMatch(/[\n\t]/);
  }, 20000);
});


describe("REGRESSION: config format tolerance", () => {
  // A correctly-set BRANCH_NUMBERS secret still failed to route a real Pendang
  // booking in production. The value was fine; the parser only split on
  // commas, so a newline-separated paste collapsed into one bogus entry.
  const CASES = {
    "commas (documented)": "Alor Setar=601,Changlun=602,Pendang=603",
    "newlines":            "Alor Setar=601\nChanglun=602\nPendang=603",
    "CRLF newlines":       "Alor Setar=601\r\nChanglun=602\r\nPendang=603",
    "semicolons":          "Alor Setar=601;Changlun=602;Pendang=603",
    "colon separator":     "Alor Setar:601,Changlun:602,Pendang:603",
    "spaces around =":     "Alor Setar = 601 , Changlun = 602 , Pendang = 603",
    "trailing newline":    "Alor Setar=601,Changlun=602,Pendang=603\n",
    "blank lines mixed in":"Alor Setar=601\n\nChanglun=602\n\nPendang=603\n",
  };

  for (const [label, cfg] of Object.entries(CASES)) {
    it(`parses ${label}`, () => {
      const parsed = parseBranchNumbers(cfg);
      expect(parsed).toHaveLength(3);
      expect(resolveBranch("Pendang", cfg)?.number).toBe("603");
      expect(resolveBranch("Alor Setar", cfg)?.number).toBe("601");
    });
  }

  it("still rejects genuine rubbish rather than inventing entries", () => {
    expect(parseBranchNumbers("just some text")).toEqual([]);
    expect(parseBranchNumbers("Name=")).toEqual([]);
    expect(parseBranchNumbers("=60123")).toEqual([]);
  });

  it("logs WHICH failure it was, naming the configured branches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await book("Kuala Lumpur");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/matched none of the 5 configured branches/);

    warn.mockClear();
    await book("Pendang", { BRANCH_NUMBERS: "" });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/unset or unparseable/);

    warn.mockRestore();
  }, 25000);
});
