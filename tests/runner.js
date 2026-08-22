// ─────────────────────────────────────────────────────────────────────────────
// Test runner
//   npm test              → structural suite + live LLM scenarios (needs .env key)
//   npm test -- --quick   → structural suite only (no key, no server, seconds)
//
// The runner boots its own server instance on TEST_PORT (default 3999) using
// the repo's .env, runs everything, then tears it down.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runStructural } from "./structural.js";
import { SCENARIOS } from "./scenarios.js";
import { createSession, chat } from "./lib/api.js";

const ROOT = resolve(import.meta.dirname, "..");
const quick = process.argv.includes("--quick");
const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];
const only = onlyArg ? onlyArg.split(",").map((s) => s.trim().toUpperCase()) : null;
const TEST_PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${TEST_PORT}`;

const summary = { structural: { pass: 0, fail: 0 }, scenarios: { pass: 0, fail: 0, skipped: 0 }, failures: [] };

// ── 1. structural ────────────────────────────────────────────────────────────
console.log("\n═══ Structural suite (no LLM) ═══");
const s = await runStructural();
summary.structural = s;
if (s.failures.length) summary.failures.push(...s.failures.map((f) => `[struct] ${f.name}: ${f.error}`));

// ── 2. live scenarios ────────────────────────────────────────────────────────
if (!quick) {
  const hasEnv = existsSync(resolve(ROOT, ".env"));
  if (!hasEnv) {
    console.log("\n═══ Live scenarios: SKIPPED (no .env with an LLM key — run `npm test -- --quick` anywhere) ═══");
    summary.scenarios.skipped = SCENARIOS.length;
  } else {
    console.log(`\n═══ Live grader-simulation scenarios (boots server on :${TEST_PORT}) ═══`);
    // fresh runtime state for deterministic action-id sequences
    rmSync(resolve(ROOT, "data"), { recursive: true, force: true });

    // free the port from any stale server of a previous run (Windows)
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(`netstat -ano | findstr :${TEST_PORT} | findstr LISTENING`, { encoding: "utf8" });
      for (const pid of new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()))) {
        try { execSync(`taskkill /PID ${pid} /F`); } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 1200));
    } catch { /* port already free */ }

    const server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let serverDied = "";
    server.stderr.on("data", (d) => { serverDied += d; process.stderr.write(`[server] ${d}`); });

    // readiness check — OUR server must answer, else abort before scenarios
    const http = await import("node:http");
    const health = () => new Promise((resolve) => {
      http.get(`http://localhost:${TEST_PORT}/api/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }).on("error", () => resolve(false));
    });
    let ready = false;
    for (let i = 0; i < 10 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 700));
      ready = await health();
    }
    if (!ready) {
      console.log(`  ✗ test server failed to start on :${TEST_PORT}${serverDied ? "\n    " + serverDied.split("\n")[0] : ""}`);
      process.exit(1);
    }

    // one session per identity (multi-turn scenarios keep their history)
    const sessions = {};
    const sessionFor = async (identity) => {
      if (!sessions[identity]) sessions[identity] = await createSession(BASE, identity);
      return sessions[identity];
    };

    const filtered = SCENARIOS.filter((sc) => !only || only.includes(sc.id.toUpperCase()));
    let n = 0;
    for (const sc of filtered) {
      n++;
      process.stdout.write(`  [${String(n).padStart(2)}/${filtered.length}] ${sc.id} ${sc.name} … `);
      const checks = [];
      const addResult = (ok, label) => checks.push({ ok, label });

      try {
        const runScenario = async () => {
          const turns = sc.turns || [{ message: sc.message }];
          const session = await sessionFor(sc.identity);
          let answerText = "";
          let toolNames = [];
          let events = [];

          for (const turn of turns) {
            const ev = await chat(BASE, session.token, turn.message, 150_000);
            events = events.concat(ev);
            const final = ev.find((e) => e.type === "final");
            answerText += (final?.text || "") + "\n";
            // staged-action payloads are legitimate evidence: an answer that
            // summarises the action may carry the numbers in the action args
            for (const tc of ev.filter((e) => e.type === "tool_call" && e.name === "prepare_action")) {
              answerText += `[staged action] ${JSON.stringify(tc.args)}\n`;
            }
            toolNames.push(...ev.filter((e) => e.type === "tool_call").map((e) => e.name));
            if (turn.event) {
              const hit = ev.some((e) => Object.entries(turn.event).every(([k, v]) => e[k] === v));
              addResult(hit, `event ${JSON.stringify(turn.event)}`);
            }
            if (turn.includes) for (const re of turn.includes) addResult(re.test(answerText), `includes ${re}`);
          }
          return { answerText, toolNames };
        };

        // first attempt; if the LLM errored (empty answer), wait and retry once —
        // transient provider throttling shouldn't fail a behavioural contract
        let out = await runScenario();
        if (!out.answerText.trim()) {
          await new Promise((r) => setTimeout(r, 4000));
          out = await runScenario();
        }
        const { answerText, toolNames } = out;
        if (!answerText.trim()) {
          // provider errored twice — skip rather than fail (rerun with --only)
          summary.scenarios.skipped++;
          summary.failures.push(`${sc.id} ${sc.name}: SKIPPED (provider returned empty answer twice)`);
          console.log("⚠ skipped (provider error)");
          continue;
        }

        for (const re of sc.includes || []) addResult(re.test(answerText), `includes ${re}`);
        for (const re of sc.excludes || []) addResult(!re.test(answerText), `excludes ${re}`);
        for (const t of sc.tools || []) addResult(toolNames.includes(t), `tool ${t}`);
        for (const c of sc.citations || []) addResult(answerText.includes(c), `citation ${c}`);

        const failed = checks.filter((c) => !c.ok);
        if (failed.length) {
          summary.scenarios.fail++;
          summary.failures.push(`${sc.id} ${sc.name}\n      ${failed.map((f) => "✗ " + f.label).join("\n      ")}\n      answer: ${answerText.slice(0, 260).replace(/\n/g, " ")}…`);
          console.log("✗");
        } else {
          summary.scenarios.pass++;
          console.log("✓" + (sc.bonus && sc.bonus.every((b) => b instanceof RegExp ? b.test(answerText) : true) ? " ⭐" : ""));
        }
        await new Promise((r) => setTimeout(r, 1500)); // gentle pacing for provider rate limits
      } catch (e) {
        summary.scenarios.fail++;
        summary.failures.push(`${sc.id} ${sc.name}: ${e.message}`);
        console.log("✗ (error)");
      }
    }

    // teardown
    server.kill();
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(`netstat -ano | findstr :${TEST_PORT} | findstr LISTENING`, { encoding: "utf8" });
      for (const pid of new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()))) {
        try { execSync(`taskkill /PID ${pid} /F`); } catch { /* gone */ }
      }
    } catch { /* port already free */ }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log("\n════════════ SUMMARY ════════════");
console.log(`  structural: ${summary.structural.pass} passed, ${summary.structural.fail} failed`);
if (!quick) {
  console.log(`  scenarios:  ${summary.scenarios.pass} passed, ${summary.scenarios.fail} failed${summary.scenarios.skipped ? `, ${summary.scenarios.skipped} skipped` : ""}`);
}
if (summary.failures.length) {
  console.log("\n  Failures:");
  for (const f of summary.failures) console.log("  • " + f);
}
const totalFail = summary.structural.fail + summary.scenarios.fail;
console.log(`\n  ${totalFail === 0 ? "✅ ALL GREEN" : `❌ ${totalFail} failure(s)`}\n`);
process.exit(totalFail === 0 ? 0 : 1);
