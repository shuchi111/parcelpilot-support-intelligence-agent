// Central env loading with sane defaults. Phase 0: PORT only.
// Later phases add LLM_* config here so it stays in one place.
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import dns from "node:dns";

// Windows/undici fix: Node's fetch can fail DNS (EAI_AGAIN) when the system
// prioritizes flaky IPv6 resolution; IPv4-first is safe everywhere.
dns.setDefaultResultOrder("ipv4first");

// tiny .env loader (no dependency) — enough for this project
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

export function readEnv() {
  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const style = (process.env.LLM_API_STYLE || (baseUrl.includes("anthropic") ? "anthropic" : "openai")).toLowerCase();
  return {
    PORT: Number(process.env.PORT || 3000),
    LLM_BASE_URL: baseUrl,
    LLM_MODEL: process.env.LLM_MODEL || "gpt-4o-mini",
    LLM_API_KEY: process.env.LLM_API_KEY || "",
    LLM_API_STYLE: style, // "openai" (/chat/completions) | "anthropic" (/v1/messages)
    MOCK_LLM: String(process.env.MOCK_LLM || "false") === "true",
  };
}
