// ─────────────────────────────────────────────────────────────────────────────
// Agent loop — a small, transparent function-calling loop (no framework).
//
// Flow per turn:  user msg → LLM → tool calls (guarded, audited) → results
// fed back → repeat (≤ MAX_STEPS) → final answer with citations.
// Everything the loop does is emitted as events for the UI tool stream.
// ─────────────────────────────────────────────────────────────────────────────
import { chat } from "./llm.js";
import { buildSystemPrompt } from "./prompts.js";
import { ToolError } from "../tools/guard.js";
import { calculateExpression } from "../tools/calc.js";
import { ACTION_TYPES } from "../store/actionstore.js";

const MAX_STEPS = 8;
const CITE_RE = /\[(DOC-\d+#[^\]\s]+|TKT-\d+)\]/g;

// ── tool schemas shown to the LLM (OpenAI function format) ──────────────────
export function toolSchemas() {
  return [
    {
      name: "doc_search",
      description:
        "Search ParcelPilot policies, SOPs, product documentation, known issues, and customer agreements. Returns ranked chunks with authority tier (1=contract/agreement, 2=policy/SOP, 3=product docs), status, and scope. Customer sessions automatically see only their own agreement.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search, e.g. 'cancellation fee after 30 minutes'" },
          k: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_order",
      description: "Look up one shipment order by ID (e.g. ORD-1001) with statuses, pickup window, fees, fault flags, and timing derivations. Customers can only access their own orders.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
      },
    },
    {
      name: "list_orders",
      description: "List orders, optionally filtered by status (DRAFT/BOOKED/PICKED_UP/DELIVERED) and account. Customers only see their own account's orders.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string" },
          account_id: { type: "string", description: "Staff only; customers are fixed to their own account" },
        },
      },
    },
    {
      name: "get_account",
      description: "Account summary: plan, status, CSM, whether a custom agreement exists. Customers receive their own account (internal notes redacted); staff may query any account.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
      },
    },
    {
      name: "search_tickets",
      description: "Search support tickets by keyword and/or status (open/closed). Customers only see their own tickets. Closed tickets carry historical_resolutions that are UNVERIFIED context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          status: { type: "string" },
          account_id: { type: "string", description: "Staff only" },
        },
      },
    },
    {
      name: "calculate",
      description:
        "Deterministic arithmetic for fees/credits/deadlines. Supports + - * / ( ) and min(a,b), max(a,b), round(x), floor(x), ceil(x). Example: 'min(500, 4200 * 0.10)'.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
    {
      name: "ops_signals",
      description:
        "STAFF ONLY: proactive issue signals from Ops Radar — SLA breaches/at-risk tickets, known-issue clusters (KI-xxx), recurring complaint themes, and order anomalies (failed pickups, pending cancellations, status mismatches). Use when asked what deserves attention, what's urgent, or to triage.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "prepare_action",
      description:
        "STAGE a state-changing action for explicit user confirmation. Nothing executes now — the user confirms via a separate secure path. Types: create_escalation (reason required; optional ticket_id, order_id, account_id, priority), update_ticket (ticket_id required; optional status, priority, note), create_followup_task (title required; optional account_id, ticket_id, due_hint).",
      parameters: {
        type: "object",
        properties: {
          action_type: { type: "string", enum: Object.keys(ACTION_TYPES) },
          payload: { type: "object", description: "Type-specific fields (see description)" },
        },
        required: ["action_type", "payload"],
      },
    },
  ];
}

export function makeExecutor(deps) {
  const { kb, docSearch, actionStore } = deps;
  const data = deps.dataTools;

  return async function execute(session, name, args) {
    try {
      switch (name) {
        case "ops_signals": {
          // role gate in the TOOL layer, not just the prompt
          if (!(session.role === "internal_support" || session.role === "internal_ops")) {
            return { error: "forbidden", message: "ops_signals is restricted to ParcelPilot staff." };
          }
          const radar = deps.radar();
          return {
            summary: `${radar.signals.length} signals (${radar.signals.filter((s) => s.severity === "critical").length} critical) as of snapshot`,
            signals: radar.signals.map((s) => ({
              title: s.title,
              severity: s.severity,
              type: s.signalType,
              evidence: s.evidence,
              suggestedAction: s.suggestedAction,
            })),
          };
        }
        case "doc_search": {
          const out = docSearch.search(args.query ?? "", session, Math.min(args.k ?? 5, 8));
          return out;
        }
        case "get_order":
          return data.get_order(session, args);
        case "list_orders":
          return data.list_orders(session, args || {});
        case "get_account":
          return data.get_account(session, args || {});
        case "search_tickets":
          return data.search_tickets(session, args || {});
        case "calculate":
          return { expression: args.expression, result: calculateExpression(args.expression) };
        case "prepare_action":
          return actionStore.prepare(session, args);
        default:
          return { error: "unknown_tool", message: `No tool named '${name}'` };
      }
    } catch (e) {
      if (e instanceof ToolError) return { error: e.code, message: e.message };
      return { error: "tool_failed", message: e.message };
    }
  };
}

const brief = (result) => {
  if (!result || typeof result !== "object") return String(result ?? "");
  if (result.error) return `✗ ${result.message || result.error}`;
  if (result.results) {
    const dep = result.deprecatedMatches?.length ? `, ${result.deprecatedMatches.length} deprecated match(es) ignored` : "";
    return `${result.results.length} chunks: ${result.results.map((r) => r.id).join(", ")}${dep}`;
  }
  if (result.action_id) return `${result.type} staged as ${result.action_id} — awaiting user confirmation`;
  if (result.result !== undefined && result.expression) return `${result.expression} = ${result.result}`;
  if (result.order_id) return `${result.order_id} · ${result.status} · ${result.account_id}`;
  if (result.orders) return `${result.count} order(s)`;
  if (result.tickets) return `${result.count} ticket(s)`;
  if (result.account_id) return `${result.account_id} ${result.account_name}`;
  return "ok";
};

/**
 * Run one conversation turn. Async generator of SSE-ready events.
 * @param {Function} [onDelta] optional live token handler (forwarded to the LLM)
 */
export async function* runTurn(session, userMessage, deps, onDelta) {
  const system = buildSystemPrompt(session, deps.kb);
  const execute = makeExecutor(deps);
  const schemas = toolSchemas();

  const messages = [
    { role: "system", content: system },
    ...session.history,
    { role: "user", content: userMessage },
  ];

  let finalText = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    let assistant;
    try {
      assistant = await chat(messages, schemas, onDelta);
    } catch (e) {
      yield { type: "error", message: `LLM error: ${e.message}` };
      return;
    }

    // tool-calling round
    if (assistant.tool_calls?.length) {
      messages.push({ role: "assistant", content: assistant.content ?? "", tool_calls: assistant.tool_calls });
      for (const tc of assistant.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* empty args */
        }
        yield { type: "tool_call", name: tc.function.name, args };
        const result = await execute(session, tc.function.name, args);
        yield {
          type: "tool_result",
          name: tc.function.name,
          ok: !(result && result.error),
          brief: brief(result),
          ...(tc.function.name === "prepare_action" && result?.action_id ? { action: result } : {}),
        };
        if (tc.function.name === "prepare_action" && result?.action_id) {
          yield { type: "action_card", action: result };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result).slice(0, 6000) });
      }
      continue;
    }

    finalText = assistant.content?.trim() || "";
    break;
  }

  if (!finalText) finalText = "I couldn't complete that request — let me hand this to the support team.";
  const citations = [...new Set([...finalText.matchAll(CITE_RE)].map((m) => m[1]))];

  session.history.push({ role: "user", content: userMessage });
  session.history.push({ role: "assistant", content: finalText });
  if (session.history.length > 20) session.history.splice(0, session.history.length - 20); // keep the window small

  yield { type: "final", text: finalText, citations };
}
