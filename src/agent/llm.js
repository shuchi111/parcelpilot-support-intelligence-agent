// ─────────────────────────────────────────────────────────────────────────────
// LLM adapter — OpenAI-compatible chat completions with tool calling.
// Works with OpenAI, Groq, Gemini's OpenAI-compat endpoint, OpenRouter, or a
// local server — configured entirely via env (see .env.example).
//
// MOCK_LLM=true gives a scripted stand-in so the full agent pipeline (tools,
// access control, confirmations, SSE) can be demoed with zero API keys.
// ─────────────────────────────────────────────────────────────────────────────
import { readEnv } from "../config.js";

const env = readEnv();

async function realLLM(messages, tools, onDelta) {
  if (!env.LLM_API_KEY || env.LLM_API_KEY === "your-key-here") {
    throw new Error("LLM_API_KEY is not configured (see .env.example). Set MOCK_LLM=true for a keyless demo.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        messages,
        ...(tools && tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
        temperature: 0.2,
        max_tokens: 1600,
        stream: Boolean(onDelta), // stream tokens when a delta handler is attached
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    if (!onDelta) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("LLM returned no message");
      return msg; // { role, content, tool_calls? }
    }

    // ── SSE stream: accumulate a message object from deltas ────────────────
    const acc = { role: "assistant", content: "", tool_calls: [] };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        if (d.content) { acc.content += d.content; onDelta(d.content); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? 0;
          acc.tool_calls[i] = acc.tool_calls[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) acc.tool_calls[i].id = tc.id;
          if (tc.function?.name) acc.tool_calls[i].function.name += tc.function.name;
          if (tc.function?.arguments) acc.tool_calls[i].function.arguments += tc.function.arguments;
        }
      }
    }
    if (!acc.tool_calls.length) delete acc.tool_calls;
    return acc;
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic Messages API (z.ai compat, Anthropic native, etc.) ─────────────
// Converts the loop's OpenAI-style messages to Anthropic format and back,
// so the agent loop stays provider-agnostic.
const safeJsonParse = (s) => {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
};

function toAnthropicMessages(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conv = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      conv.push({ role: "user", content: String(m.content) });
    } else if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        const blocks = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJsonParse(tc.function.arguments) });
        }
        conv.push({ role: "assistant", content: blocks });
      } else {
        conv.push({ role: "assistant", content: String(m.content ?? "") });
      }
    } else if (m.role === "tool") {
      // consecutive tool results collapse into ONE user turn of tool_result blocks
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) };
      const last = conv[conv.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        conv.push({ role: "user", content: [block] });
      }
    }
  }
  return { system, messages: conv };
}

// normalize an Anthropic final message into the loop's expected shape
function fromAnthropicMessage(data) {
  let text = "";
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  return { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

async function realAnthropic(messages, tools, onDelta) {
  if (!env.LLM_API_KEY || env.LLM_API_KEY === "your-key-here") {
    throw new Error("LLM_API_KEY is not configured (see .env.example). Set MOCK_LLM=true for a keyless demo.");
  }
  const { system, messages: conv } = toAnthropicMessages(messages);
  const aTools = (tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        max_tokens: 2000,
        temperature: 0.2,
        ...(system ? { system } : {}),
        messages: conv,
        ...(aTools.length ? { tools: aTools } : {}),
        stream: Boolean(onDelta),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    if (!onDelta) {
      const data = await res.json();
      return fromAnthropicMessage(data);
    }

    // ── Anthropic SSE stream ──────────────────────────────────────────────
    // events: content_block_start / content_block_delta / content_block_stop / message_stop
    const textParts = [];
    const toolBlocks = new Map(); // index → {id, name, json}
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        let j;
        try { j = JSON.parse(s.slice(5).trim()); } catch { continue; }
        if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
          toolBlocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: "" });
        } else if (j.type === "content_block_delta") {
          const d = j.delta || {};
          if (d.type === "text_delta" && d.text) { textParts.push(d.text); onDelta(d.text); }
          else if (d.type === "input_json_delta" && d.partial_json) {
            const tb = toolBlocks.get(j.index);
            if (tb) tb.json += d.partial_json;
          }
        }
      }
    }
    const tool_calls = [...toolBlocks.values()].map((tb) => ({
      id: tb.id, type: "function", function: { name: tb.name, arguments: tb.json || "{}" },
    }));
    return {
      role: "assistant",
      content: textParts.join("") || null,
      ...(tool_calls.length ? { tool_calls } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── scripted fallback ────────────────────────────────────────────────────────
function mockLLM(messages, tools, onDelta) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = String(lastUser?.content || "").toLowerCase();
  const alreadyCalled = new Set(messages.filter((m) => m.role === "tool").map((m) => m.name));

  const call = (name, args) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `mock_${name}_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });

  // 1) order questions → look the order up, then answer deterministically
  const ordId = (String(lastUser?.content || "").match(/ord-\d{4}/i) || [])[0];
  if (ordId && !alreadyCalled.has("get_order")) return call("get_order", { order_id: ordId.toUpperCase() });
  if (ordId && alreadyCalled.has("get_order") && !alreadyCalled.has("doc_search")) {
    return call("doc_search", { query: "cancellation fee policy agreement" });
  }

  // 1b) escalation requests exercise the prepare→confirm protocol
  if (/\b(escalat\w*|raise|follow[- ]?ups?)\b/i.test(q)) {
    const tktId = (String(lastUser?.content || "").match(/tkt-\d{3}/i) || [])[0];
    const isFollowup = /follow[- ]?up/i.test(q);
    if (isFollowup && !alreadyCalled.has("prepare_action")) {
      return call("prepare_action", { action_type: "create_followup_task", payload: { title: String(lastUser?.content || "").slice(0, 80) } });
    }
    if (!isFollowup && !alreadyCalled.has("prepare_action")) {
      return call("prepare_action", {
        action_type: "create_escalation",
        payload: { reason: String(lastUser?.content || "").slice(0, 120), ...(tktId ? { ticket_id: tktId.toUpperCase() } : {}) },
      });
    }
  }

  // 2) keyword-shaped doc search so retrieval is exercised
  if (!alreadyCalled.has("doc_search")) {
    const terms = q.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 3).slice(0, 6).join(" ");
    return call("doc_search", { query: terms || "support policy" });
  }

  // 3) compose an answer from what the tools returned
  const toolChunks = messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n\n").slice(0, 1200);
  const content =
    `**[MOCK LLM — no API key configured]**\n\nTool evidence gathered:\n\n${toolChunks}\n\n` +
    `Connect a real LLM via LLM_BASE_URL / LLM_MODEL / LLM_API_KEY (see .env.example) for full reasoning, citations and the confirmation flow.`;
  if (onDelta) onDelta(content);
  return { role: "assistant", content };
}

/**
 * @param {Function} [onDelta] optional token-stream handler
 * @returns {Promise<{role, content, tool_calls?}>} assistant message
 */
export async function chat(messages, tools, onDelta) {
  if (env.MOCK_LLM) return mockLLM(messages, tools, onDelta);
  return env.LLM_API_STYLE === "anthropic"
    ? realAnthropic(messages, tools, onDelta)
    : realLLM(messages, tools, onDelta);
}

export const llmMode = () =>
  env.MOCK_LLM ? "mock" : `${env.LLM_API_STYLE}:${env.LLM_MODEL}`;
