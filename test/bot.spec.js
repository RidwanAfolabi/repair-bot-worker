// Bot pipeline: disclosure notice, intake capture, escalation.
// Local D1; WhatsApp, the LLM and Google Sheets are mocked.

import { env } from "cloudflare:test";
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

import { handleIncomingMessage, parseIntakeBlock } from "../src/bot.js";
import { initDb, saveMessage } from "../src/db.js";
import { generateReply } from "../src/llm.js";
import { sendTextMessage, sendStaffAlert } from "../src/whatsapp.js";

const C = "60111111111";
const NOW = () => Math.floor(Date.now() / 1000);

const CONFIRMATION = "Ok Cik Amin, dah noted semua!";
const WITH_BLOCK = `${CONFIRMATION}\n\n[INTAKE]\nname: Amin\ndevice: iPhone 12\n` +
                   `fault: Skrin pecah\nbranch: Sungai Petani\ntime: Esok pagi\n[/INTAKE]`;

beforeEach(async () => {
  await initDb(env.DB);
  for (const t of ["conversations", "escalations", "intakes"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  vi.mocked(sendTextMessage).mockClear();
  vi.mocked(sendStaffAlert).mockClear();
});

async function incoming(text, reply) {
  if (reply) vi.mocked(generateReply).mockResolvedValueOnce(reply);
  const rowId = await saveMessage(env.DB, { senderId: C, role: "customer", text });
  await handleIncomingMessage({
    senderId: C, incomingText: text,
    env: { ...env, MESSAGE_DEBOUNCE_MS: "0" }, messageRowId: rowId,
  });
}

const sent      = () => vi.mocked(sendTextMessage).mock.calls.map(c => c[1]);
const alerts    = () => vi.mocked(sendStaffAlert).mock.calls.map(c => c[0]).join("\n");
// Keyed on the privacy URL, not on prose: the notice wording is edited
// freely (and differs per language), but the link is a code constant.
const NOTICE_MARK = "https://ifixexpress.com.my/privacy-policy";
const noticeSent = () => sent().some(t => t.includes(NOTICE_MARK));
// A prior reply marks the customer as already-engaged, suppressing the notice.
const alreadyEngaged = () => saveMessage(env.DB, { senderId: C, role: "ai-assistant", text: "hi" });


describe("parseIntakeBlock", () => {
  it("extracts all fields and strips the marker", () => {
    const { intake, cleanedReply } = parseIntakeBlock(WITH_BLOCK);
    expect(intake).toEqual({
      customerName: "Amin", deviceModel: "iPhone 12", fault: "Skrin pecah",
      branch: "Sungai Petani", preferredTime: "Esok pagi",
    });
    expect(cleanedReply).toBe(CONFIRMATION);
  });

  it("leaves an ordinary reply untouched", () => {
    expect(parseIntakeBlock(CONFIRMATION)).toEqual({ intake: null, cleanedReply: CONFIRMATION });
  });

  it("keeps partial bookings rather than discarding them", () => {
    const { intake } = parseIntakeBlock("Ok\n\n[INTAKE]\nname: Siti\n[/INTAKE]");
    expect(intake).toEqual({ customerName: "Siti" });
  });

  it("treats placeholder values as absent", () => {
    const { intake } = parseIntakeBlock("Ok\n\n[INTAKE]\nname: Amin\ncontact: N/A\nbranch: -\n[/INTAKE]");
    expect(intake).toEqual({ customerName: "Amin" });
  });

  it("REGRESSION: strips an unterminated block so no marker can leak", () => {
    const { cleanedReply } = parseIntakeBlock("Ok dah noted!\n\n[INTAKE]\nname: Amin");
    expect(cleanedReply).toBe("Ok dah noted!");
    expect(cleanedReply).not.toContain("INTAKE");
  });

  it("is safe on empty input", () => {
    expect(parseIntakeBlock(null)).toEqual({ intake: null, cleanedReply: "" });
  });
});


describe("AI disclosure notice", () => {
  it("goes to a brand new customer, before the reply", async () => {
    await incoming("Salam");
    expect(sent()[0]).toContain(NOTICE_MARK);
    expect(sent().length).toBeGreaterThan(1);
  }, 20000);

  it("REGRESSION: still sent when the customer opens with a burst", async () => {
    // Their own first message used to count as prior activity and swallow it.
    await saveMessage(env.DB, { senderId: C, role: "customer", text: "Salam" });
    await incoming("nak tanya harga");
    expect(noticeSent()).toBe(true);
  }, 20000);

  it("is not repeated once the bot has replied", async () => {
    await alreadyEngaged();
    await incoming("berapa harga");
    expect(noticeSent()).toBe(false);
  }, 20000);

  it("is not repeated when staff handled them instead", async () => {
    await saveMessage(env.DB, { senderId: C, role: "staff", text: "ya cik" });
    await incoming("ok");
    expect(noticeSent()).toBe(false);
  }, 20000);

  it("returns after the inactivity window, but not before it", async () => {
    await env.DB.prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
      .bind(C, "ai-assistant", "old", NOW() - 20 * 86400).run();
    await incoming("Salam lagi");
    expect(noticeSent()).toBe(true);

    vi.mocked(sendTextMessage).mockClear();
    await env.DB.prepare("DELETE FROM conversations").run();
    await env.DB.prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
      .bind(C, "ai-assistant", "recent", NOW() - 13 * 86400).run();
    await incoming("Salam");
    expect(noticeSent()).toBe(false);
  }, 30000);

  it("carries the privacy link and no em dash", async () => {
    await incoming("Salam");
    const notice = sent()[0];
    expect(notice).toContain("https://ifixexpress.com.my/privacy-policy");
    expect(notice).not.toContain("—");
  }, 20000);

  it("is never stored, so it cannot pollute LLM history", async () => {
    await incoming("Salam");
    const { results } = await env.DB.prepare("SELECT text FROM conversations").all();
    expect(results.some(r => r.text.includes(NOTICE_MARK))).toBe(false);
  }, 20000);
});


describe("intake capture", () => {
  beforeEach(alreadyEngaged);

  it("saves the booking and alerts staff", async () => {
    await incoming("ok book", WITH_BLOCK);
    const row = await env.DB.prepare("SELECT * FROM intakes").first();
    expect(row).toMatchObject({ customer_name: "Amin", branch: "Sungai Petani" });
    expect(alerts()).toContain("New repair booking");
  }, 20000);

  it("REGRESSION: the marker never reaches the customer or the history", async () => {
    await incoming("ok book", WITH_BLOCK);
    expect(sent().join(" ")).not.toContain("INTAKE");
    const { results } = await env.DB
      .prepare("SELECT text FROM conversations WHERE role = 'ai-assistant'").all();
    expect(results.map(r => r.text).join(" ")).not.toContain("INTAKE");
  }, 20000);

  it("REGRESSION: a failed DB save still alerts staff, and says it failed", async () => {
    // These were chained once; one schema error silently swallowed the alert
    // and nobody at the shop heard about a booking the customer was promised.
    await env.DB.prepare("DROP TABLE intakes").run();
    await incoming("ok book", WITH_BLOCK);
    expect(alerts()).toContain("Could not save");
    expect(alerts()).toContain("Amin");
    expect(sent().join(" ")).toContain("dah noted");
    await initDb(env.DB);
  }, 20000);

  it("an ordinary reply books nothing and alerts nobody", async () => {
    await incoming("berapa harga", "Screen iPhone 12 RM230");
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM intakes").first()).n).toBe(0);
    expect(vi.mocked(sendStaffAlert)).not.toHaveBeenCalled();
  }, 20000);
});


describe("escalation", () => {
  beforeEach(alreadyEngaged);

  it("mutes and alerts on the trigger phrase, and still delivers the message", async () => {
    await incoming("soalan pelik", "Biar saya check dan update balik ya");
    const row = await env.DB.prepare("SELECT * FROM escalations WHERE sender_id = ?").bind(C).first();
    expect(row.escalated).toBe(1);
    expect(row.mute_type).toBe("auto");            // self-resolving, not permanent
    expect(alerts()).toContain("needs attention");
    expect(sent().join(" ")).toContain("check dan update balik");
  }, 20000);

  it("an ordinary reply does not escalate", async () => {
    await incoming("hi", "Boleh, RM230");
    const row = await env.DB.prepare("SELECT * FROM escalations WHERE sender_id = ?").bind(C).first();
    expect(row).toBeNull();
  }, 20000);
});
