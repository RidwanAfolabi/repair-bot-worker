// Full worker.fetch() webhook handling: who gets served, media, sender
// resolution, onboarding and history sync. Local D1, mocked outbound calls.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/whatsapp.js", () => ({
  sendTextMessage: vi.fn(async () => ({ ok: true })),
  sendReadReceipt: vi.fn(async () => ({ ok: true })),
  sendStaffAlert:  vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/llm.js", () => ({ generateReply: vi.fn(async () => "Boleh, RM230") }));
vi.mock("../src/googleSheets.js", () => ({
  getSheetTabs: vi.fn(async () => []), getPricingRows: vi.fn(async () => []),
}));

import worker from "../src/index.js";
import { initDb, saveMessage, getSetting } from "../src/db.js";
import { sendTextMessage, sendStaffAlert, sendReadReceipt } from "../src/whatsapp.js";

const C     = "60111111111";
const STAFF = "60122222222";
const BIZ   = "60133333333";
const BSUID = "MY.13491208655302741918";

beforeEach(async () => {
  await initDb(env.DB);
  for (const t of ["conversations", "escalations", "wa_contacts", "bot_settings"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DROP TABLE IF EXISTS connected_numbers").run();
  for (const m of [sendTextMessage, sendStaffAlert, sendReadReceipt]) vi.mocked(m).mockClear();
});

async function post(body, overrides = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("http://x/webhook", { method: "POST", body: JSON.stringify(body) }),
    { ...env, MESSAGE_DEBOUNCE_MS: "0", TEST_ALLOWLIST: "*", STAFF_WA_NUMBER: STAFF, ...overrides },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const msgs = (messages, extra = {}) => ({
  entry: [{ changes: [{ field: "messages", value: { messages, ...extra } }] }],
});
const text = (from, body) => msgs([{ from, id: `w.${Math.random()}`, type: "text", text: { body } }]);

const replied  = () => vi.mocked(sendTextMessage).mock.calls.length > 0;
const sentTo   = () => vi.mocked(sendTextMessage).mock.calls.map(c => c[0]);
const alerts   = () => vi.mocked(sendStaffAlert).mock.calls.map(c => c[0]).join("\n");
const rows     = async () =>
  (await env.DB.prepare("SELECT sender_id, role, text FROM conversations ORDER BY id").all()).results;


describe("who gets served", () => {
  it("REGRESSION: delisted wins over the allowlist and over '*'", async () => {
    await post(text(C, "hi"), { DELISTED_NUMBERS: C, TEST_ALLOWLIST: C });
    expect(replied()).toBe(false);
    expect(await rows()).toHaveLength(0);
    expect(vi.mocked(sendReadReceipt)).not.toHaveBeenCalled();
  }, 20000);

  it("REGRESSION: delisting works whatever format the number is written in", async () => {
    // A "+" in the dashboard silently defeated this in production.
    await post(text(C, "hi"), { DELISTED_NUMBERS: `+60 11-111 1111` });
    expect(replied()).toBe(false);
  }, 20000);

  it("delisted applies even to the staff number", async () => {
    await post(text(STAFF, "!pauseall"), { DELISTED_NUMBERS: STAFF });
    expect(await getSetting(env.DB, "bot_enabled")).not.toBe("false");
  }, 20000);

  it("an unlisted number is skipped, a listed one is served", async () => {
    await post(text("60999999999", "hi"), { TEST_ALLOWLIST: C });
    expect(replied()).toBe(false);

    await post(text(C, "hi"), { TEST_ALLOWLIST: `+${C}` });
    expect(replied()).toBe(true);
  }, 25000);

  it("REGRESSION: an unset allowlist fails CLOSED, serving nobody", async () => {
    await post(text(C, "hi"), { TEST_ALLOWLIST: undefined });
    expect(replied()).toBe(false);
  }, 20000);

  it("staff bypass the allowlist and reach the command parser", async () => {
    await post(text(STAFF, "!pauseall"), { TEST_ALLOWLIST: C });
    expect(await getSetting(env.DB, "bot_enabled")).toBe("false");
  }, 20000);

  it("BOT_ENABLED=false silences customers but not staff", async () => {
    await post(text(C, "hi"), { BOT_ENABLED: "false" });
    expect(replied()).toBe(false);
  }, 20000);
});


describe("sender resolution", () => {
  it("REGRESSION: a username customer (BSUID, no `from`) is served", async () => {
    await post(msgs(
      [{ from_user_id: BSUID, id: "w.1", type: "text", text: { body: "berapa harga" } }],
      { contacts: [{ profile: { name: "Sheena", username: "realsheena" }, user_id: BSUID }] }
    ));
    expect(sentTo()).toContain(BSUID);
    expect((await rows())[0].sender_id).toBe(BSUID);
  }, 20000);

  it("a BSUID can be delisted, and a lookalike number cannot catch it", async () => {
    await post(msgs([{ from_user_id: BSUID, id: "w.2", type: "text", text: { body: "hi" } }]),
               { DELISTED_NUMBERS: BSUID });
    expect(replied()).toBe(false);

    await post(msgs([{ from_user_id: BSUID, id: "w.3", type: "text", text: { body: "hi" } }]),
               { DELISTED_NUMBERS: "13491208655302741918" });
    expect(replied()).toBe(true);
  }, 25000);

  it("REGRESSION: a message with no sender at all is ignored, not crashed on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(msgs([{ id: "w.4", type: "edit", edit: { message: { type: "text", text: { body: "x" } } } }]));
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("no sender id");
    warn.mockRestore();
  }, 20000);
});


describe("media", () => {
  const media = (type) => msgs([{ from: C, id: `w.${Math.random()}`, type, [type]: {} }]);

  it("REGRESSION: sends nothing to the customer, and alerts staff when it's a fresh event", async () => {
    for (const type of ["image", "video", "document", "audio"]) {
      await env.DB.prepare("DELETE FROM conversations").run();   // each type tested as its own fresh event
      vi.mocked(sendTextMessage).mockClear();
      vi.mocked(sendStaffAlert).mockClear();
      await post(media(type));
      expect(replied()).toBe(false);
      expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
    }
  }, 30000);

  it("REGRESSION: a burst of images alerts staff only once, not once per image", async () => {
    await post(media("image"));
    await post(media("image"));
    await post(media("image"));
    await post(media("image"));
    await post(media("image"));

    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
  }, 30000);

  it("every item in the burst is still recorded in D1, not just the first", async () => {
    await post(media("image"));
    await post(media("image"));
    await post(media("image"));

    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.every(row => row.text.includes("you cannot see it"))).toBe(true);
  }, 30000);

  it("a burst stays one alert even when it mixes media types (image, then voice note)", async () => {
    await post(media("image"));
    await post(media("video"));
    await post(media("audio"));

    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(1);
  }, 30000);

  it("a customer text message in between BREAKS the burst — the next media alerts again", async () => {
    await post(media("image"));
    await post(text(C, "ok wait sat"));
    await post(media("image"));

    // one for the first image, one for the second (the text in between reset it)
    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(2);
  }, 30000);

  it("an AI reply in between also breaks the burst", async () => {
    await post(media("image"));
    await saveMessage(env.DB, { senderId: C, role: "ai-assistant", text: "noted, let me know if you need anything else" });
    await post(media("image"));

    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(2);
  }, 30000);

  it("each customer still gets their own independent burst — not shared across customers", async () => {
    const other = "60199999999";
    await post(media("image"));                                            // C's first
    await post(msgs([{ from: other, id: "w.other", type: "image", image: {} }]));  // other customer's first

    expect(vi.mocked(sendStaffAlert)).toHaveBeenCalledTimes(2);
  }, 30000);

  it("logs it as context that does not read as a staff handoff", async () => {
    await post(media("image"));
    const r = await rows();
    expect(r[0].text).toContain("you cannot see it");
    expect(r[0].text).not.toContain("staff alerted to view and respond");
  }, 20000);

  it("does not mute the customer", async () => {
    await post(media("image"));
    const row = await env.DB.prepare("SELECT COUNT(*) n FROM escalations WHERE escalated = 1").first();
    expect(row.n).toBe(0);
  }, 20000);

  it("the follow-up text is answered normally", async () => {
    await post(media("image"));
    await post(text(C, "ni skrin pecah, berapa?"));
    expect(vi.mocked(sendTextMessage).mock.calls.map(c => c[1]).join(" ")).toContain("RM230");
  }, 25000);

  it("a caption is answered as text", async () => {
    await post(msgs([{ from: C, id: "w.c", type: "image", image: { caption: "ni rosak" } }]));
    expect(vi.mocked(sendTextMessage).mock.calls.map(c => c[1]).join(" ")).toContain("RM230");
  }, 20000);
});


describe("staff echoes", () => {
  const echo = (from, to, body) => ({
    entry: [{ changes: [{ field: "smb_message_echoes", value: {
      message_echoes: [{ from, to, type: "text", text: { body } }],
    }}]}],
  });

  it("a manual staff reply is stored as 'staff' and mutes the bot", async () => {
    await post(echo(BIZ, C, "saya reply manual"));
    const r = await rows();
    expect(r[0]).toMatchObject({ sender_id: C, role: "staff", text: "saya reply manual" });
    const mute = await env.DB.prepare("SELECT * FROM escalations WHERE sender_id = ?").bind(C).first();
    expect(mute.escalated).toBe(1);
  }, 20000);

  it("delisting one recipient does not drop others in the same batch", async () => {
    await post({
      entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [
        { from: BIZ, to: "60999999999", type: "text", text: { body: "ignored" } },
        { from: BIZ, to: C,             type: "text", text: { body: "kept" } },
      ]}}]}],
    }, { DELISTED_NUMBERS: "60999999999" });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("kept");
  }, 20000);
});


describe("onboarding and history sync", () => {
  it("PARTNER_ADDED is recorded and cannot be suppressed by any gate", async () => {
    const body = {
      entry: [{ id: "WABA1", changes: [{ field: "account_update", value: {
        event: "PARTNER_ADDED", waba_info: { waba_id: "WABA1", owner_business_id: "BIZ1" },
      }}]}],
    };
    await post(body, { BOT_ENABLED: "false", TEST_ALLOWLIST: "", DELISTED_NUMBERS: "WABA1" });
    const r = await env.DB.prepare("SELECT * FROM connected_numbers").all();
    expect(r.results).toHaveLength(1);
    expect(alerts()).toContain("PARTNER_ADDED");
  }, 20000);

  it("REGRESSION: a BSUID customer's history is not all labelled staff", async () => {
    await post({
      entry: [{ changes: [{ field: "history", value: { history: [{
        metadata: { phase: "1", chunk_order: 1, progress: 100 },
        threads: [{ id: BSUID, messages: [
          { from_user_id: BSUID, type: "text", text: { body: "berapa" }, timestamp: "1750000000" },
          { from: BIZ,           type: "text", text: { body: "RM230" },  timestamp: "1750000060" },
        ]}],
      }]}}]}],
    });
    expect((await rows()).map(r => r.role)).toEqual(["customer", "staff"]);
  }, 20000);

  it("a contact with only a BSUID is still stored", async () => {
    await post({
      entry: [{ changes: [{ field: "smb_app_state_sync", value: {
        state_sync: [{ type: "contact", action: "add",
                       contact: { user_id: BSUID, full_name: "Sheena" } }],
      }}]}],
    });
    const r = await env.DB.prepare("SELECT * FROM wa_contacts").first();
    expect(r.phone_number).toBe(BSUID);
  }, 20000);
});


describe("cron dispatch", () => {
  it("the 2am schedule purges, the 9pm summary slot does not", async () => {
    const seedOld = () => env.DB
      .prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
      .bind("OLD", "customer", "ancient", Math.floor(Date.now() / 1000) - 400 * 86400).run();

    await seedOld();
    let ctx = createExecutionContext();
    await worker.scheduled({ cron: "0 13 * * *" }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM conversations").first()).n).toBe(1);

    ctx = createExecutionContext();
    await worker.scheduled({ cron: "0 18 * * *" }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM conversations").first()).n).toBe(0);
  });

  it("an unrecognised schedule still purges, as a fail-safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await env.DB
      .prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
      .bind("OLD", "customer", "ancient", Math.floor(Date.now() / 1000) - 400 * 86400).run();

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "0 18 * * ?" }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await env.DB.prepare("SELECT COUNT(*) n FROM conversations").first()).n).toBe(0);
    warn.mockRestore();
  });
});
