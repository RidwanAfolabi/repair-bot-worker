// The real request-building logic in llm.js — no mocking of llm.js itself.
// Everywhere else in the suite mocks this module out; here it's the thing
// under test. fetch is stubbed to capture the exact request body sent to
// each provider, since that shape is what actually controls API spend.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateReply } from "../src/llm.js";
import { STATIC_SYSTEM_PROMPT, buildDynamicContext } from "../src/prompt.js";

const history = [
  { role: "customer",     text: "berapa harga screen iphone 12" },
  { role: "ai-assistant", text: "RM230 in sya Allah" },
  { role: "staff",        text: "ok saya bagi RM200 untuk cik" },
];

function mockFetch(replyText) {
  let captured;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      content:    [{ text: replyText }],                          // Claude shape
      candidates: [{ content: { parts: [{ text: replyText }] } }], // Gemini shape
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return () => captured;
}

afterEach(() => vi.unstubAllGlobals());


describe("callClaude — prompt caching request shape", () => {
  let getCaptured;
  beforeEach(() => { getCaptured = mockFetch("ok"); });

  const env = { LLM_PROVIDER: "claude", ANTHROPIC_API_KEY: "k" };

  it("system is STATIC_SYSTEM_PROMPT alone, marked cache_control ephemeral", async () => {
    await generateReply(history, "next question", env, "");
    const { body } = getCaptured();

    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(1);
    expect(body.system[0]).toEqual({
      type: "text",
      text: STATIC_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    });
  });

  it("REGRESSION: the live time block and pricing are NOT in system at all", async () => {
    await generateReply(history, "hi", env, "## CURRENT PRICING (live lookup for this enquiry)\nsome rows");
    const { body } = getCaptured();

    // The whole point of the split: these must never re-enter the cached
    // block, or every request looks "new" and nothing is ever reused.
    expect(body.system[0].text).not.toContain("CURRENT TIME —");
    expect(body.system[0].text).not.toContain("some rows");
  });

  it("top-level cache_control auto-caches the growing message history", async () => {
    await generateReply(history, "next question", env, "");
    const { body } = getCaptured();
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("dynamic context (time + pricing) is attached to the newest user turn, not the system block", async () => {
    const pricing = "## CURRENT PRICING (live lookup for this enquiry)\nScreen: RM230";
    await generateReply(history, "berapa", env, pricing);
    const { body } = getCaptured();

    const lastMsg = body.messages.at(-1);
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content).toHaveLength(2);
    expect(lastMsg.content[0].text).toContain("CURRENT TIME");
    expect(lastMsg.content[0].text).toContain("RM230");
    expect(lastMsg.content[1]).toEqual({ type: "text", text: "berapa" });
  });

  it("the dynamic block carries no cache_control (it must never be cached)", async () => {
    await generateReply(history, "hi", env, "");
    const { body } = getCaptured();
    const dynamicBlock = body.messages.at(-1).content[0];
    expect(dynamicBlock.cache_control).toBeUndefined();
  });

  it("REGRESSION: STATIC_SYSTEM_PROMPT is byte-identical across two separate calls", async () => {
    // The single property that actually makes caching work: if this ever
    // differs between requests (a stray date, a non-deterministic field),
    // every request looks unique and nothing gets reused.
    await generateReply(history, "first message", env, "## CURRENT PRICING\nrows A");
    const first = getCaptured().body.system[0].text;

    await generateReply(history, "second message, much later", env, "## CURRENT PRICING\nrows B (completely different)");
    const second = getCaptured().body.system[0].text;

    expect(first).toBe(second);
  });

  it("history is still mapped with roles and the staff marker exactly as before", async () => {
    await generateReply(history, "next", env, "");
    const { body } = getCaptured();

    expect(body.messages.slice(0, 3)).toEqual([
      { role: "user",      content: "berapa harga screen iphone 12" },
      { role: "assistant", content: "RM230 in sya Allah" },
      { role: "assistant", content: "[Staff replied] ok saya bagi RM200 untuk cik" },
    ]);
  });

  it("still sends model, max_tokens and disabled thinking as before", async () => {
    await generateReply(history, "hi", { ...env, CLAUDE_MODEL: "claude-sonnet-5" }, "");
    const { body } = getCaptured();
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(500);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("response parsing is unaffected by the new request shape", async () => {
    const reply = await generateReply(history, "hi", env, "");
    expect(reply).toBe("ok");
  });
});


describe("callGemini — unaffected by the Claude-specific caching change", () => {
  let getCaptured;
  beforeEach(() => { getCaptured = mockFetch("Boleh, RM230"); });

  const env = { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" };

  it("still sends one combined systemInstruction string, not an array", async () => {
    await generateReply(history, "berapa", env, "## CURRENT PRICING\nScreen: RM230");
    const { body } = getCaptured();

    expect(typeof body.systemInstruction.parts[0].text).toBe("string");
    // Combined string now has static content first, dynamic (time+pricing)
    // last — same reordering benefit, no cache_control needed for Gemini.
    expect(body.systemInstruction.parts[0].text).toContain(STATIC_SYSTEM_PROMPT);
    expect(body.systemInstruction.parts[0].text).toContain("RM230");
  });

  it("role mapping to 'model' is unaffected", async () => {
    await generateReply(history, "next", env, "");
    const { body } = getCaptured();
    expect(body.contents.slice(0, 3).map(c => c.role)).toEqual(["user", "model", "model"]);
  });

  it("still returns the parsed reply text", async () => {
    const reply = await generateReply(history, "hi", env, "");
    expect(reply).toBe("Boleh, RM230");
  });
});


describe("buildDynamicContext — used directly by both providers", () => {
  it("changes when time or pricing changes, independent of the static prompt", () => {
    const a = buildDynamicContext("", new Date(2026, 0, 1, 8, 0));
    const b = buildDynamicContext("", new Date(2026, 0, 1, 20, 0));
    expect(a).not.toBe(b);
  });

  it("omits the pricing block entirely when none is given", () => {
    const ctx = buildDynamicContext("", new Date(2026, 0, 1, 12, 0));
    expect(ctx).not.toContain("CURRENT PRICING");
  });
});
