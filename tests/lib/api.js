// ─────────────────────────────────────────────────────────────────────────────
// SSE chat client for tests — hits a running server's /api/chat and returns
// the parsed event stream.
// ─────────────────────────────────────────────────────────────────────────────
import http from "node:http";

export function createSession(baseUrl, identity) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ identity });
    const req = http.request(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`session ${identity}: HTTP ${res.statusCode} ${b}`));
        resolve(JSON.parse(b));
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export function chat(baseUrl, token, message, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ message });
    const req = http.request(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        const events = b
          .split("\n\n")
          .filter((x) => x.startsWith("data: "))
          .map((x) => {
            try { return JSON.parse(x.slice(6)); } catch { return null; }
          })
          .filter(Boolean);
        resolve(events);
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("chat timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export function post(baseUrl, path, token, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export function get(baseUrl, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
}
