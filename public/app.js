// ParcelPilot Support Console — vanilla JS SPA (no build step)
/* global fetch */
const $ = (sel) => document.querySelector(sel);

const state = {
  token: null,
  identity: null,
  health: null,
  pendingCards: new Map(), // action_id → {el, timer}
  streamingBubble: null,
  toolStrip: null,
  busy: false,
};

// ── tiny markdown renderer (escape → bold/code → citation chips) ─────────────
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdToHtml(text) {
  let h = esc(text);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<span class="md-b">$1</span>');
  h = h.replace(/`([^`]+)`/g, '<span class="md-c">$1</span>');
  return h;
}
function citationChipsHtml(citations) {
  if (!citations?.length) return "";
  return `<div class="cite-chips">${citations.map((c) => `<span class="cite-chip">${esc(c)}</span>`).join("")}</div>`;
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  state.health = await (await fetch("/api/health")).json();
  $("#llmBadge").textContent = "LLM: " + state.health.llm;
  const { identities } = await (await fetch("/api/identities")).json();
  const cust = $("#custGrid"), staff = $("#staffGrid");
  for (const id of identities) {
    const card = document.createElement("button");
    card.className = "id-card";
    card.innerHTML = `<span class="name">${esc(id.label.split(" — ")[0])}</span>
      <span class="meta">${esc(id.label.split(" — ")[1] || "")} <span class="role-pill ${id.role}">${id.role.replace("internal_", "")}</span></span>`;
    card.onclick = () => login(id.id);
    (id.role === "customer" ? cust : staff).appendChild(card);
  }
}
boot();

// ── session ──────────────────────────────────────────────────────────────────
async function login(identityId) {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: identityId }),
  });
  const data = await res.json();
  state.token = data.token;
  state.identity = data.identity;
  enterConsole();
}

async function enterConsole() {
  const acct = state.identity.accountId
    ? (await (await fetch(`/api/health`)).json()) // keep it light; account details come from the agent itself
    : null;

  $("#loginView").classList.add("hidden");
  $("#chatView").classList.remove("hidden");
  $("#tabs").classList.remove("hidden");
  $("#identityChip").classList.remove("hidden");
  $("#switchBtn").classList.remove("hidden");
  $("#identityChip").innerHTML =
    `<span class="dot"></span>${esc(state.identity.userName)} <span class="role-pill ${state.identity.role}">${state.identity.role.replace("internal_", "")}</span>`;
  $("#switchBtn").onclick = () => location.reload();

  const internal = state.identity.role.startsWith("internal");
  if (internal) $("#radarTab").classList.remove("hidden");

  $("#sessionInfo").innerHTML = `
    <div>User <b>${esc(state.identity.userName)}</b></div>
    <div>Role <b>${esc(state.identity.role.replace("internal_", ""))}</b></div>
    ${state.identity.accountId ? `<div>Account <b>${esc(state.identity.accountId)}</b></div>` : `<div>Scope <b>all accounts</b></div>`}
    <div>Data clock <b>16 Aug 2026, 11:00 IST</b></div>`;

  const suggestions = internal
    ? ["What deserves attention right now?", "Is LumenWorks owed a credit on ORD-2002?", "What are Northstar's P1 response targets?", "Show open tickets and their SLA status"]
    : ["Can I cancel ORD-1001 without a cancellation fee?", "My pickup was late — do I get a service credit?", "What are my support response targets?", "Create a follow-up task to review my bulk upload issue"];
  const row = $("#suggestRow");
  row.innerHTML = "";
  for (const s of suggestions) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = s;
    chip.onclick = () => { $("#composerInput").value = s; send(); };
    row.appendChild(chip);
  }

  $("#sendBtn").onclick = send;
  $("#composerInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("#composerInput").focus();

  if (internal) loadRadar();
}

// ── chat / SSE ───────────────────────────────────────────────────────────────
async function send() {
  const input = $("#composerInput");
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  state.busy = true;
  $("#sendBtn").disabled = true;

  const thread = $("#thread");
  thread.querySelector(".welcome")?.remove();
  addMsg("user", text);

  // containers for this turn
  state.toolStrip = document.createElement("div");
  state.toolStrip.className = "tool-strip";
  state.streamingBubble = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || "chat failed");
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        handleEvent(evt, thread);
      }
    }
  } catch (e) {
    addMsg("bot", `⚠️ ${e.message}`);
  } finally {
    state.busy = false;
    $("#sendBtn").disabled = false;
    $("#composerInput").focus();
  }
}

function handleEvent(evt, thread) {
  switch (evt.type) {
    case "tool_call": {
      if (!state.toolStrip.isConnected) thread.appendChild(state.toolStrip);
      const row = document.createElement("div");
      row.className = "tool-row";
      row.innerHTML = `<span class="spin"></span><span class="tname">🔧 ${esc(evt.name)}</span><span class="targs">${esc(JSON.stringify(evt.args).slice(0, 90))}</span>`;
      state.toolStrip.appendChild(row);
      row._pending = true;
      state.lastToolRow = row;
      scrollDown();
      break;
    }
    case "tool_result": {
      const row = state.lastToolRow;
      if (row?._pending) {
        row._pending = false;
        row.querySelector(".spin")?.remove();
        row.classList.add(evt.ok ? "ok" : "err");
        const brief = document.createElement("span");
        brief.className = "tbrief";
        brief.textContent = " " + evt.brief;
        row.appendChild(brief);
      }
      scrollDown();
      break;
    }
    case "delta": {
      if (!state.streamingBubble) {
        state.toolStrip?.classList.add("done");
        state.streamingBubble = document.createElement("div");
        state.streamingBubble.className = "msg bot streaming";
        thread.appendChild(state.streamingBubble);
      }
      state.streamingBubble.dataset.raw = (state.streamingBubble.dataset.raw || "") + evt.text;
      state.streamingBubble.innerHTML = mdToHtml(state.streamingBubble.dataset.raw);
      scrollDown();
      break;
    }
    case "action_card": {
      renderActionCard(thread, evt.action);
      break;
    }
    case "action_result": {
      markCard(evt.action?.action_id, evt.confirmed ? "executed" : "cancelled");
      const text = evt.confirmed
        ? `✅ ${evt.action?.result?.escalation_id || evt.action?.result?.task_id || "Action"} confirmed & executed.`
        : "Action cancelled — nothing was executed.";
      addMsg("system", text);
      break;
    }
    case "final": {
      if (state.streamingBubble) {
        state.streamingBubble.classList.remove("streaming");
        state.streamingBubble.innerHTML = mdToHtml(evt.text) + citationChipsHtml(evt.citations);
      } else {
        addMsg("bot", evt.text);
        const last = thread.querySelector(".msg.bot:last-of-type");
        if (last) last.innerHTML = mdToHtml(evt.text) + citationChipsHtml(evt.citations);
      }
      scrollDown();
      break;
    }
    case "error":
      addMsg("bot", `⚠️ ${evt.message}`);
      break;
    default:
      break;
  }
}

function addMsg(kind, text) {
  const thread = $("#thread");
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = mdToHtml(text);
  thread.appendChild(el);
  scrollDown();
  return el;
}

function scrollDown() {
  const t = $("#thread");
  t.scrollTop = t.scrollHeight;
}

// ── action cards ─────────────────────────────────────────────────────────────
function renderActionCard(thread, action) {
  const card = document.createElement("div");
  card.className = "action-card";
  const payload = Object.entries(action.payload || {})
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  card.innerHTML = `
    <div class="ac-head">⚠️ <span>Confirmation required</span><span class="ac-type">${esc(action.type)}</span>
      <span class="ac-ttl">expires in 10 min</span></div>
    <pre class="ac-payload">${esc(payload || "(no payload)")}</pre>
    <div class="ac-buttons">
      <button class="primary ac-confirm">Confirm &amp; execute</button>
      <button class="ghost ac-cancel" style="color:#475569;border-color:#cbd5e1">Cancel</button>
    </div>`;
  card.querySelector(".ac-confirm").onclick = () => resolveAction(action.action_id, true, card);
  card.querySelector(".ac-cancel").onclick = () => resolveAction(action.action_id, false, card);
  thread.appendChild(card);
  state.pendingCards.set(action.action_id, card);
  scrollDown();
}

async function resolveAction(actionId, confirm, card) {
  try {
    const res = await fetch(`/api/action/${actionId}/${confirm ? "confirm" : "cancel"}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "failed");
    markCard(actionId, confirm ? "executed" : "cancelled");
    if (confirm) {
      const r = data.result?.result || {};
      const ref = r.escalation_id || r.task_id || r.ticket_id || actionId;
      addMsg("system", `✅ Executed — ${data.result?.type || "action"} ${ref}`);
    } else {
      addMsg("system", "Action cancelled — nothing was executed.");
    }
  } catch (e) {
    addMsg("system", `⚠️ ${e.message}`);
  }
}

function markCard(actionId, status) {
  const card = state.pendingCards.get(actionId);
  if (!card) return;
  card.classList.add(status);
  const head = card.querySelector(".ac-head");
  card.querySelector(".ac-buttons")?.remove();
  const s = document.createElement("span");
  s.className = "ac-status";
  s.textContent = status === "executed" ? "✔ executed" : "✖ cancelled";
  head.appendChild(s);
  state.pendingCards.delete(actionId);
}

// ── radar (Phase 4 fills the data; shell works today) ────────────────────────
async function loadRadar() {
  const body = $("#radarBody");
  body.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const res = await fetch("/api/radar", { headers: { Authorization: "Bearer " + state.token } });
    const data = await res.json();
    if (!data.available) {
      body.innerHTML = `<div class="signal-card sev-medium"><div class="sig-head"><span class="sig-title">Ops Radar</span><span class="sig-badge">next phase</span></div><div class="sig-evidence">${esc(data.note || "")}</div></div>`;
      return;
    }
    body.innerHTML = data.signals
      .map((s) => `
        <div class="signal-card sev-${s.severity}">
          <div class="sig-head"><span class="sig-title">${esc(s.title)}</span>
            <span class="sig-badge">${esc(s.severity)}</span>
            ${s.signalType ? `<span class="muted" style="font-size:12px">${esc(s.signalType)}</span>` : ""}</div>
          <div class="sig-evidence">${mdToHtml(s.evidence)}</div>
          <div class="sig-action"><button class="chip" data-q="${esc(s.suggestedActionQuery || "Tell me more about " + s.title)}">${esc(s.suggestedAction || "Investigate")}</button></div>
        </div>`)
      .join("");
    body.querySelectorAll(".chip").forEach((b) =>
      (b.onclick = () => { switchView("chat"); $("#composerInput").value = b.dataset.q; send(); })
    );
  } catch (e) {
    body.innerHTML = `<div class="muted">⚠️ ${esc(e.message)}</div>`;
  }
}
$("#radarRefresh")?.addEventListener("click", () => state.identity?.role.startsWith("internal") && loadRadar());

// ── view switching ───────────────────────────────────────────────────────────
function switchView(view) {
  for (const v of ["chat", "radar"]) $(`#${v}View`).classList.toggle("hidden", v !== view);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
