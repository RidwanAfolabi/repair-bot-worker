// Runs against a real (local) D1 database provided by vitest-pool-workers.
// Nothing here touches remote Cloudflare resources.

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  initDb, saveMessage, saveIntake, getRecentMessages, getLatestUserMessageId,
  getLastEngagementAt, purgeOldConversations,
} from "../src/db.js";

const C = "60111111111";
const NOW  = () => Math.floor(Date.now() / 1000);
const DAYS = (n) => n * 86400;

beforeEach(async () => {
  await initDb(env.DB);
  for (const t of ["conversations", "escalations", "intakes"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function seed(senderId, role, text, ageDays = 0) {
  await env.DB
    .prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
    .bind(senderId, role, text, NOW() - DAYS(ageDays)).run();
}


describe("conversations.role vocabulary", () => {
  it("accepts the three real roles", async () => {
    for (const role of ["customer", "ai-assistant", "staff"]) {
      await saveMessage(env.DB, { senderId: C, role, text: "x" });
    }
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM conversations").first();
    expect(r.n).toBe(3);
  });

  it("rejects the retired 'user'/'assistant' values", async () => {
    await expect(saveMessage(env.DB, { senderId: C, role: "user", text: "x" })).rejects.toThrow();
    await expect(saveMessage(env.DB, { senderId: C, role: "assistant", text: "x" })).rejects.toThrow();
  });
});

describe("saveMessage input validation", () => {
  it("REGRESSION: names the missing field instead of a bare D1_TYPE_ERROR", async () => {
    // A real edit webhook arrived with no sender and produced only
    // "D1_TYPE_ERROR: Type 'undefined' not supported", naming neither the
    // column nor the caller.
    await expect(saveMessage(env.DB, { senderId: undefined, role: "customer", text: "hi" }))
      .rejects.toThrow(/senderId=MISSING/);
    await expect(saveMessage(env.DB, { senderId: C, role: undefined, text: "hi" }))
      .rejects.toThrow(/role=MISSING/);
    await expect(saveMessage(env.DB, { senderId: C, role: "customer", text: undefined }))
      .rejects.toThrow(/text=MISSING/);
  });

  it("returns the new row id on success", async () => {
    expect(await saveMessage(env.DB, { senderId: C, role: "customer", text: "hi" }))
      .toBeGreaterThan(0);
  });
});

describe("getRecentMessages ordering", () => {
  it("REGRESSION: same-second messages keep insertion order", async () => {
    // timestamp is second-granularity, so a burst lands in one second and
    // ORDER BY timestamp alone returned them scrambled — which silently
    // reordered the conversation handed to the LLM.
    const t = NOW();
    for (const [role, text] of [
      ["customer", "first"], ["ai-assistant", "second"],
      ["customer", "third"], ["staff", "fourth"],
    ]) {
      await env.DB
        .prepare("INSERT INTO conversations (sender_id, role, text, timestamp) VALUES (?,?,?,?)")
        .bind(C, role, text, t).run();
    }
    const hist = await getRecentMessages(env.DB, C, 32);
    expect(hist.map(h => h.text)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("returns oldest first and honours the limit", async () => {
    await seed(C, "customer", "old", 2);
    await seed(C, "customer", "new", 1);
    const hist = await getRecentMessages(env.DB, C, 1);
    expect(hist.map(h => h.text)).toEqual(["new"]);
  });

  it("keeps history-sync backfill in real chronological order", async () => {
    // Backfilled rows get new high ids but old timestamps; timestamp must
    // stay the primary sort or they land at the wrong end.
    await seed(C, "customer", "recent", 0);
    await seed(C, "customer", "backfilled", 30);
    expect((await getRecentMessages(env.DB, C, 32)).map(h => h.text))
      .toEqual(["backfilled", "recent"]);
  });
});

describe("getLatestUserMessageId (debounce marker)", () => {
  it("tracks only customer rows", async () => {
    const first = await saveMessage(env.DB, { senderId: C, role: "customer", text: "a" });
    await saveMessage(env.DB, { senderId: C, role: "ai-assistant", text: "b" });
    await saveMessage(env.DB, { senderId: C, role: "staff", text: "c" });
    expect(await getLatestUserMessageId(env.DB, C)).toBe(first);

    const second = await saveMessage(env.DB, { senderId: C, role: "customer", text: "d" });
    expect(await getLatestUserMessageId(env.DB, C)).toBe(second);
  });
});

describe("getLastEngagementAt (AI notice window)", () => {
  it("REGRESSION: the customer's own messages never count as engagement", async () => {
    // Basing this on any prior message meant a new customer's own opening
    // burst suppressed their disclosure notice.
    await seed(C, "customer", "one");
    await seed(C, "customer", "two");
    expect(await getLastEngagementAt(env.DB, C)).toBeNull();
  });

  it("counts both AI and staff replies", async () => {
    await seed(C, "ai-assistant", "reply");
    expect(await getLastEngagementAt(env.DB, C)).not.toBeNull();

    await env.DB.prepare("DELETE FROM conversations").run();
    await seed(C, "staff", "manager reply");
    expect(await getLastEngagementAt(env.DB, C)).not.toBeNull();
  });
});

describe("purgeOldConversations (12-month retention)", () => {
  it("deletes past the window and keeps the rest", async () => {
    await seed("A", "customer", "ancient", 400);
    await seed("B", "customer", "recent", 300);
    const r = await purgeOldConversations(env.DB, 365);
    expect(r.conversationsDeleted).toBe(1);
    expect((await env.DB.prepare("SELECT text FROM conversations").first()).text).toBe("recent");
  });

  it("keeps a row sitting exactly on the boundary", async () => {
    await seed("A", "customer", "edge", 364);
    expect((await purgeOldConversations(env.DB, 365)).conversationsDeleted).toBe(0);
  });

  it("clears escalations orphaned by the purge but keeps active ones", async () => {
    await seed("GONE", "customer", "old", 400);
    await seed("STAYS", "customer", "new", 1);
    for (const s of ["GONE", "STAYS"]) {
      await env.DB.prepare("INSERT INTO escalations (sender_id, escalated) VALUES (?, 1)").bind(s).run();
    }
    const r = await purgeOldConversations(env.DB, 365);
    expect(r.escalationsDeleted).toBe(1);
    expect((await env.DB.prepare("SELECT sender_id FROM escalations").first()).sender_id).toBe("STAYS");
  });

  it("never purges intakes — booking records are not conversation logs", async () => {
    await env.DB
      .prepare("INSERT INTO intakes (sender_id, customer_name, timestamp) VALUES (?,?,?)")
      .bind("OLD", "Amin", NOW() - DAYS(500)).run();
    await purgeOldConversations(env.DB, 365);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM intakes").first()).n).toBe(1);
  });

  it("is a safe no-op on an empty table", async () => {
    const r = await purgeOldConversations(env.DB, 365);
    expect(r.conversationsDeleted).toBe(0);
    expect(r.escalationsDeleted).toBe(0);
  });
});

describe("saveIntake", () => {
  it("stores every field, branch included", async () => {
    await saveIntake(env.DB, {
      senderId: C, customerName: "Amin", deviceModel: "iPhone 12",
      fault: "Skrin pecah", branch: "Sungai Petani",
      contact: "0123456789", preferredTime: "Esok pagi",
    });
    const row = await env.DB.prepare("SELECT * FROM intakes").first();
    expect(row).toMatchObject({
      sender_id: C, customer_name: "Amin", device_model: "iPhone 12",
      branch: "Sungai Petani", preferred_time: "Esok pagi",
    });
  });

  it("accepts a partial booking rather than losing it", async () => {
    const id = await saveIntake(env.DB, { senderId: C, customerName: "Siti" });
    expect(id).toBeGreaterThan(0);
    const row = await env.DB.prepare("SELECT * FROM intakes").first();
    expect(row.branch).toBeNull();
  });
});
