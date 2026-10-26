import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * AI copilot backend. Provider-neutral chat endpoint + provider adapters.
 *
 *   GET  /api/ai/status                 -> providers, models, quota usage
 *   POST /api/ai/chat                   -> { provider, model?, system, messages, tools } => { text, toolCalls, raw, model, quota }
 *   GET  /api/ai/openai/login?return=   -> (LOCAL ONLY) starts ChatGPT OAuth (PKCE), callback on http://localhost:1455/auth/callback
 *   POST /api/ai/openai/logout
 *   GET  /api/ai/openai/models
 *   GET  /api/ai/hazards?kind=fires|storms|volcanoes|earthquakes   (NASA EONET / USGS, cached 10 min)
 *   GET  /api/ai/route?profile=foot|car|bike&coords=lon,lat;lon,lat (OSM routing proxy, cached)
 *
 * Gemini free tier is tiny (≈10 RPM / 250 RPD on flash), so every request goes through a per-model
 * sliding-window limiter that QUEUES instead of failing, 429s set a cooldown from the server's retryDelay
 * and fall through to the next model in the chain. Thinking is disabled on 2.5 models to save tokens.
 */

const router = Router();

// ─── shared types ────────────────────────────────────────────────────────────

interface ToolCall { id: string; name: string; args: Record<string, unknown> }
interface ToolResult { id: string; name: string; result: unknown }
interface AiMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  /** JPEG/PNG data URLs. */
  images?: string[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** Opaque provider content echoed back verbatim (Gemini thought signatures). */
  raw?: unknown;
}
interface ToolDecl { name: string; description: string; parameters: Record<string, unknown> }
interface ChatBody { provider: "gemini" | "openai"; model?: string; system: string; messages: AiMessage[]; tools: ToolDecl[] }
interface ChatOut { text: string; toolCalls: ToolCall[]; raw?: unknown; model: string }

class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfterSec?: number) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const callId = () => crypto.randomBytes(6).toString("hex");

function splitDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  return m ? { mime: m[1], data: m[2] } : null;
}

// ─── rate limiter ────────────────────────────────────────────────────────────

class Limiter {
  private stamps: number[] = [];
  private day = "";
  dayCount = 0;
  blockedUntil = 0;
  constructor(public rpm: number, public rpd: number) {}

  private roll(now: number) {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.dayCount = 0; }
    while (this.stamps.length && now - this.stamps[0] > 60_000) this.stamps.shift();
  }

  /** ms until a slot is free (0 = now). Infinity if the daily budget is gone. */
  waitMs(now = Date.now()): number {
    this.roll(now);
    if (this.dayCount >= this.rpd) return Infinity;
    const cooldown = Math.max(0, this.blockedUntil - now);
    const windowWait = this.stamps.length < this.rpm ? 0 : 60_000 - (now - this.stamps[0]) + 50;
    return Math.max(cooldown, windowWait);
  }

  take(now = Date.now()) { this.roll(now); this.stamps.push(now); this.dayCount++; }

  snapshot() {
    const now = Date.now();
    this.roll(now);
    return { rpm: this.rpm, rpd: this.rpd, usedMinute: this.stamps.length, usedToday: this.dayCount, cooldownSec: Math.ceil(Math.max(0, this.blockedUntil - now) / 1000) };
  }
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Env values pasted with surrounding quotes ('AQ....') are rejected by Google as API_KEY_INVALID.
const geminiKey = () =>
  (process.env.GEMINI_API || process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
const GEMINI_DEFAULT = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Each model has its own free-tier bucket, so falling through the chain multiplies usable quota.
// 2.5 models are retired for new keys (404), so they are left out.
const GEMINI_CHAIN = [GEMINI_DEFAULT, "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"].filter((m, i, a) => a.indexOf(m) === i);

/** Conservative defaults just under the published free-tier limits. Override with GEMINI_RPM / GEMINI_RPD. */
function freeTierLimits(model: string): [number, number] {
  const envRpm = Number(process.env.GEMINI_RPM);
  const envRpd = Number(process.env.GEMINI_RPD);
  let rpm = 8, rpd = 240;
  if (model.includes("lite")) { rpm = 13; rpd = 950; }
  return [envRpm > 0 ? envRpm : rpm, envRpd > 0 ? envRpd : rpd];
}

const limiters = new Map<string, Limiter>();
function limiterFor(model: string): Limiter {
  let l = limiters.get(model);
  if (!l) { const [rpm, rpd] = freeTierLimits(model); l = new Limiter(rpm, rpd); limiters.set(model, l); }
  return l;
}

function toGeminiContents(messages: AiMessage[]) {
  const contents: { role: "user" | "model"; parts: unknown[] }[] = [];
  const imgParts = (imgs?: string[]) =>
    (imgs ?? []).map(splitDataUrl).filter(Boolean).map((p) => ({ inlineData: { mimeType: p!.mime, data: p!.data } }));
  for (const m of messages) {
    if (m.role === "user") {
      const parts: unknown[] = [];
      if (m.text) parts.push({ text: m.text });
      parts.push(...imgParts(m.images));
      if (parts.length) contents.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const raw = m.raw as { parts?: unknown[] } | undefined;
      if (raw?.parts?.length) { contents.push({ role: "model", parts: raw.parts }); continue; }
      const parts: unknown[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      const parts: unknown[] = (m.toolResults ?? []).map((r) => ({
        functionResponse: { name: r.name, response: { result: r.result } },
      }));
      parts.push(...imgParts(m.images));
      if (parts.length) contents.push({ role: "user", parts });
    }
  }
  return contents;
}

function parseRetryDelay(body: string): number | undefined {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(Number(m[1])) : undefined;
}

/** Minimal thinking keeps latency and token spend low. 2.5 uses a budget, 3.x uses a level. */
function thinkingConfigFor(model: string) {
  if (model.includes("2.5")) return { thinkingBudget: model.includes("pro") ? 128 : 0 };
  return { thinkingLevel: "low" };
}
const noThinkingConfig = new Set<string>();

async function geminiOnce(model: string, body: ChatBody, timeoutMs: number): Promise<ChatOut> {
  try {
    return await geminiRequest(model, body, !noThinkingConfig.has(model), timeoutMs);
  } catch (e) {
    if (e instanceof HttpError && e.status === 400 && /thinking/i.test(e.message) && !noThinkingConfig.has(model)) {
      noThinkingConfig.add(model);
      return geminiRequest(model, body, false, timeoutMs);
    }
    if ((e as Error)?.name === "TimeoutError") throw new HttpError(504, `Gemini ${model} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  }
}

async function geminiRequest(model: string, body: ChatBody, withThinking: boolean, timeoutMs: number): Promise<ChatOut> {
  const payload: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: body.system }] },
    contents: toGeminiContents(body.messages),
    tools: body.tools.length ? [{ functionDeclarations: body.tools }] : undefined,
    toolConfig: body.tools.length ? { functionCallingConfig: { mode: "AUTO" } } : undefined,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      ...(withThinking ? { thinkingConfig: thinkingConfigFor(model) } : {}),
    },
  };
  const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt.slice(0, 400);
    try { msg = (JSON.parse(txt) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep raw */ }
    throw new HttpError(res.status, `Gemini ${res.status}: ${msg}`, res.status === 429 ? parseRetryDelay(txt) ?? 30 : undefined);
  }
  const json = JSON.parse(txt) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { id?: string; name: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  const cand = json.candidates?.[0];
  if (!cand?.content) {
    const reason = json.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty response";
    return { text: `(no answer: ${reason})`, toolCalls: [], model };
  }
  const parts = cand.content.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ id: p.functionCall!.id ?? callId(), name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
  return { text, toolCalls, raw: cand.content, model };
}

const MAX_QUEUE_WAIT_MS = 8_000;
// The whole fallback chain must finish before the rewrite proxy gives up (proxyTimeout is 60s in next.config.mjs).
const CHAT_BUDGET_MS = 45_000;
const ATTEMPT_TIMEOUT_MS = 12_000;
const OVERLOAD_COOLDOWN_MS = 60_000;
const TIMEOUT_COOLDOWN_MS = 10 * 60 * 1000;
const RETIRED_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// The model that answered most recently is tried first, so a slow or exhausted default
// doesn't burn the time budget on every request.
let lastGoodModel: string | null = null;

export async function geminiChat(body: ChatBody): Promise<ChatOut> {
  if (!geminiKey()) throw new HttpError(503, "GEMINI_KEY is not set on the server.");
  const requested = body.model || GEMINI_DEFAULT;
  const chain = [lastGoodModel, requested, ...GEMINI_CHAIN].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
  const deadline = Date.now() + CHAT_BUDGET_MS;
  const failures: string[] = [];
  let sawQuota = false;
  let sawTimeout = false;

  for (const model of chain) {
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;
    const lim = limiterFor(model);
    const wait = lim.waitMs();
    if (wait === Infinity) { failures.push(`${model}: daily limit`); sawQuota = true; continue; }
    // Prefer the next model over a long wait, but queue briefly for the requested one.
    if (wait > Math.min(MAX_QUEUE_WAIT_MS, remaining - 3_000)) { failures.push(`${model}: cooling down`); continue; }
    if (wait > 0) await sleep(wait);
    lim.take();
    try {
      const out = await geminiOnce(model, body, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
      lastGoodModel = model;
      return out;
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(502, String((e as Error).message));
      failures.push(`${model}: ${err.status === 504 ? "timed out" : err.status}`);
      if (lastGoodModel === model) lastGoodModel = null;
      if (err.status === 429) { sawQuota = true; lim.blockedUntil = Date.now() + (err.retryAfterSec ?? 30) * 1000; continue; }
      if (err.status === 404 || err.status === 400 && /not found|not supported/i.test(err.message)) { lim.blockedUntil = Date.now() + RETIRED_COOLDOWN_MS; continue; }
      if (err.status === 504) { sawTimeout = true; lim.blockedUntil = Date.now() + TIMEOUT_COOLDOWN_MS; continue; }
      if (err.status >= 500) { lim.blockedUntil = Date.now() + OVERLOAD_COOLDOWN_MS; continue; }
      throw err;
    }
  }
  const soonest = Math.min(...chain.map((m) => limiterFor(m).waitMs()));
  const retryAfter = Number.isFinite(soonest) ? Math.max(5, Math.ceil(soonest / 1000)) : 3600;
  const why = sawQuota ? "free-tier quota is used up or the models are overloaded" : sawTimeout ? "the models are responding too slowly" : "the models are overloaded";
  throw new HttpError(sawQuota ? 429 : 503, `Gemini is unavailable right now (${why}). Tried ${failures.join(", ") || "no models"}.`, retryAfter);
}

// ─── OpenAI (ChatGPT OAuth, local only; or OPENAI_API_KEY) ───────────────────

const OAUTH_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 1455;
const OAUTH_REDIRECT = `http://localhost:${OAUTH_PORT}/auth/callback`;
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const AUTH_FILE = path.join(process.env.WORLDVIEW_DATA_DIR || path.join(os.homedir(), ".worldview"), "openai-auth.json");

const OAUTH_MODELS = ["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex", "gpt-5-codex-mini"];

interface OpenAiAuth { access_token: string; refresh_token: string; id_token?: string; expires_at: number; account_id?: string; email?: string }

function isLocalRequest(req: Request): boolean {
  if (process.env.VERCEL) return false;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "";
  const h = host.split(":")[0].toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0";
}

function readAuth(): OpenAiAuth | null {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as OpenAiAuth; } catch { return null; }
}
function writeAuth(a: OpenAiAuth | null) {
  if (!a) { try { fs.unlinkSync(AUTH_FILE); } catch { /* none */ } return; }
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

function jwtClaims(token?: string): Record<string, unknown> {
  if (!token) return {};
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>; } catch { return {}; }
}

function authFromTokens(t: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }, prev?: OpenAiAuth | null): OpenAiAuth {
  const idClaims = jwtClaims(t.id_token ?? prev?.id_token);
  const accClaims = jwtClaims(t.access_token);
  const authNs = (idClaims["https://api.openai.com/auth"] ?? accClaims["https://api.openai.com/auth"] ?? {}) as { chatgpt_account_id?: string };
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token ?? "",
    id_token: t.id_token ?? prev?.id_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
    account_id: authNs.chatgpt_account_id ?? prev?.account_id,
    email: (idClaims.email as string | undefined) ?? prev?.email,
  };
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const txt = await res.text();
  if (!res.ok) throw new HttpError(res.status, `OpenAI token ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
}

let refreshing: Promise<OpenAiAuth> | null = null;
async function validAuth(): Promise<OpenAiAuth> {
  const a = readAuth();
  if (!a) throw new HttpError(401, "Not signed in to OpenAI. Use the Sign in button (local only).");
  if (a.expires_at - Date.now() > 60_000) return a;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: OAUTH_CLIENT_ID, scope: "openid profile email" })
    .then((t) => { const next = authFromTokens(t, a); writeAuth(next); return next; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// PKCE session + one-shot callback listener on :1455 (the redirect URI registered for this client id).
let pending: { verifier: string; state: string; returnTo: string } | null = null;
let callbackServer: http.Server | null = null;

function ensureCallbackServer(): Promise<void> {
  if (callbackServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      const send = (msg: string, ok: boolean) => {
        const back = pending?.returnTo ?? "http://localhost:3000/";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>WORLDVIEW · OpenAI</title><body style="background:#020408;color:${ok ? "#7df9ff" : "#ff6b6b"};font:14px monospace;padding:40px">${msg}<br><br><a style="color:#7df9ff" href="${back}">Return to WORLDVIEW</a><script>setTimeout(()=>location.href=${JSON.stringify(back)},${ok ? 1200 : 6000})</script></body>`);
      };
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!pending || !code || state !== pending.state) { send("OAuth state mismatch or missing code. Start sign-in again.", false); return; }
      try {
        const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: OAUTH_REDIRECT, client_id: OAUTH_CLIENT_ID, code_verifier: pending.verifier });
        writeAuth(authFromTokens(t));
        send("SIGNED IN TO OPENAI. Returning to the console…", true);
      } catch (e) {
        send(`Token exchange failed: ${(e as Error).message}`, false);
      } finally {
        setTimeout(() => { srv.close(); if (callbackServer === srv) callbackServer = null; pending = null; }, 500);
      }
    });
    srv.once("error", (e) => { callbackServer = null; reject(e); });
    srv.listen(OAUTH_PORT, "127.0.0.1", () => { callbackServer = srv; resolve(); });
  });
}

function toResponsesInput(messages: AiMessage[]) {
  const input: unknown[] = [];
  const imgs = (list?: string[]) => (list ?? []).map((u) => ({ type: "input_image", image_url: u }));
  for (const m of messages) {
    if (m.role === "user") {
      input.push({ role: "user", content: [...(m.text ? [{ type: "input_text", text: m.text }] : []), ...imgs(m.images)] });
    } else if (m.role === "assistant") {
      if (m.text) input.push({ role: "assistant", content: [{ type: "output_text", text: m.text }] });
      for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    } else {
      for (const r of m.toolResults ?? []) input.push({ type: "function_call_output", call_id: r.id, output: JSON.stringify(r.result) });
      if (m.images?.length) input.push({ role: "user", content: [{ type: "input_text", text: "Screenshot of the current view:" }, ...imgs(m.images)] });
    }
  }
  return input;
}

function parseResponsesOutput(output: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string }[], model: string): ChatOut {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const item of output ?? []) {
    if (item.type === "message") text += (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    else if (item.type === "function_call") {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(item.arguments || "{}"); } catch { /* bad json */ }
      toolCalls.push({ id: item.call_id ?? callId(), name: item.name ?? "", args });
    }
  }
  return { text: text.trim(), toolCalls, model };
}

async function readSse(res: globalThis.Response): Promise<{ output: unknown[] }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const done: unknown[] = [];
  let completed: { output: unknown[] } | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data) as { type?: string; item?: unknown; response?: { output: unknown[]; error?: { message?: string } } };
        if (ev.type === "response.output_item.done" && ev.item) done.push(ev.item);
        else if (ev.type === "response.completed" && ev.response) completed = ev.response;
        else if (ev.type === "response.failed" || ev.type === "error") throw new HttpError(502, `OpenAI: ${ev.response?.error?.message ?? data.slice(0, 300)}`);
      } catch (e) { if (e instanceof HttpError) throw e; }
    }
  }
  return completed?.output?.length ? completed : { output: done };
}

async function openaiChat(req: Request, body: ChatBody): Promise<ChatOut> {
  const apiKey = process.env.OPENAI_API_KEY;
  const tools = body.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  const input = toResponsesInput(body.messages);

  if (readAuth() || !apiKey) {
    if (!isLocalRequest(req)) throw new HttpError(403, "OpenAI OAuth is only available when running locally (http://localhost).");
    const auth = await validAuth();
    const model = body.model || OAUTH_MODELS[0];
    const send = (withInstructions: boolean) => fetch(CODEX_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${auth.access_token}`,
        ...(auth.account_id ? { "chatgpt-account-id": auth.account_id } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: crypto.randomUUID(),
      },
      body: JSON.stringify({
        model,
        instructions: withInstructions ? body.system : "You are a helpful assistant.",
        input: withInstructions ? input : [{ role: "developer", content: [{ type: "input_text", text: body.system }] }, ...input],
        tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        reasoning: { effort: "low", summary: "auto" },
        include: [],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (!/instructions/i.test(t)) throw new HttpError(400, `OpenAI 400: ${t.slice(0, 300)}`);
      res = await send(false);
    }
    if (!res.ok) throw new HttpError(res.status, `OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = await readSse(res);
    return parseResponsesOutput(out.output as never, model);
  }

  const model = body.model || "gpt-4.1-mini";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, instructions: body.system, input, tools, tool_choice: "auto", store: false }),
    signal: AbortSignal.timeout(90_000),
  });
  const txt = await res.text();
  if (!res.ok) throw new HttpError(res.status, `OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  return parseResponsesOutput((JSON.parse(txt) as { output: never }).output, model);
}

// ─── routes ──────────────────────────────────────────────────────────────────

router.get("/ai/status", (req: Request, res: Response) => {
  const auth = readAuth();
  res.json({
    gemini: {
      configured: !!geminiKey(),
      defaultModel: GEMINI_DEFAULT,
      models: GEMINI_CHAIN,
      quota: Object.fromEntries(GEMINI_CHAIN.map((m) => [m, limiterFor(m).snapshot()])),
    },
    openai: {
      local: isLocalRequest(req),
      oauth: auth ? { signedIn: true, email: auth.email ?? null } : { signedIn: false, email: null },
      apiKey: !!process.env.OPENAI_API_KEY,
      models: OAUTH_MODELS,
    },
  });
});

router.post("/ai/chat", async (req: Request, res: Response) => {
  const body = req.body as ChatBody;
  if (!body || !Array.isArray(body.messages) || typeof body.system !== "string") {
    res.status(400).json({ error: "bad request" });
    return;
  }
  body.tools = Array.isArray(body.tools) ? body.tools : [];
  try {
    const out = body.provider === "openai" ? await openaiChat(req, body) : await geminiChat(body);
    res.json({ ...out, quota: body.provider === "openai" ? null : limiterFor(out.model).snapshot() });
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, String((e as Error)?.message ?? e));
    res.status(err.status).json({ error: err.message, retryAfterSec: err.retryAfterSec ?? null });
  }
});

router.post("/ai/stt", async (req: Request, res: Response) => {
  const { audio } = (req.body ?? {}) as { audio?: string };
  if (typeof audio !== "string" || !/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audio)) {
    res.status(400).json({ error: "audio data URL required" });
    return;
  }
  try {
    const out = await geminiChat({
      provider: "gemini",
      system: "You are a speech-to-text transcriber for a geospatial command console. Return ONLY the exact spoken words as plain text with no quotes, no markdown, and no commentary. If silence or unintelligible noise, return an empty string.",
      tools: [],
      messages: [{ role: "user", text: "Transcribe this voice command verbatim.", images: [audio] }],
    });
    res.json({ text: out.text.trim() });
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, String((e as Error)?.message ?? e));
    res.status(err.status).json({ error: err.message });
  }
});


router.get("/ai/openai/login", async (req: Request, res: Response) => {
  if (!isLocalRequest(req)) { res.status(403).send("OpenAI OAuth sign-in is only available when running locally on http://localhost."); return; }
  const returnTo = typeof req.query.return === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(req.query.return) ? req.query.return : `http://${req.headers.host}/`;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  pending = { verifier, state, returnTo };
  try {
    await ensureCallbackServer();
  } catch (e) {
    res.status(500).send(`Could not listen on port ${OAUTH_PORT} for the OAuth callback (${(e as Error).message}). Close other apps using it (e.g. Codex CLI) and retry.`);
    return;
  }
  const q = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  });
  res.redirect(`${OAUTH_ISSUER}/oauth/authorize?${q.toString()}`);
});

router.post("/ai/openai/logout", (_req: Request, res: Response) => {
  writeAuth(null);
  res.json({ ok: true });
});

router.get("/ai/openai/models", async (req: Request, res: Response) => {
  if (readAuth() && isLocalRequest(req)) {
    try {
      const auth = await validAuth();
      const r = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=0.50.0", {
        headers: { authorization: `Bearer ${auth.access_token}`, ...(auth.account_id ? { "chatgpt-account-id": auth.account_id } : {}), originator: "codex_cli_rs" },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const j = (await r.json()) as { models?: { slug?: string; id?: string }[] };
        const ids = (j.models ?? []).map((m) => m.slug ?? m.id).filter(Boolean) as string[];
        if (ids.length) { res.json({ models: ids, source: "remote" }); return; }
      }
    } catch { /* fall through to static */ }
    res.json({ models: OAUTH_MODELS, source: "static" });
    return;
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
      const j = (await r.json()) as { data?: { id: string }[] };
      const ids = (j.data ?? []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id) && !/audio|realtime|tts|transcribe|image|search/.test(id)).sort();
      res.json({ models: ids, source: "api-key" });
      return;
    } catch { /* ignore */ }
  }
  res.json({ models: OAUTH_MODELS, source: "static" });
});

// ─── live hazards (fires / storms / volcanoes / earthquakes) ─────────────────

interface Hazard { id: string; kind: string; title: string; lat: number; lon: number; date: string; magnitude: number | null; unit: string | null }
const hazardCache = new Map<string, { at: number; data: Hazard[]; inflight?: Promise<Hazard[]> }>();
const HAZARD_TTL = 10 * 60 * 1000;
const EONET_CAT: Record<string, string> = { fires: "wildfires", storms: "severeStorms", volcanoes: "volcanoes" };

async function loadHazards(kind: string): Promise<Hazard[]> {
  if (kind === "earthquakes") {
    const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", { signal: AbortSignal.timeout(20_000) });
    const j = (await r.json()) as { features: { id: string; properties: { mag: number; place: string; time: number }; geometry: { coordinates: [number, number, number] } }[] };
    return j.features.map((f) => ({
      id: f.id, kind, title: f.properties.place, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      date: new Date(f.properties.time).toISOString(), magnitude: f.properties.mag, unit: "Mw",
    }));
  }
  const cat = EONET_CAT[kind];
  if (!cat) throw new HttpError(400, "unknown hazard kind");
  const r = await fetch(`https://eonet.gsfc.nasa.gov/api/v3/events?category=${cat}&status=open&days=45&limit=1000`, { signal: AbortSignal.timeout(25_000) });
  const j = (await r.json()) as { events: { id: string; title: string; geometry: { date: string; type: string; coordinates: unknown; magnitudeValue?: number | null; magnitudeUnit?: string | null }[] }[] };
  const out: Hazard[] = [];
  for (const ev of j.events ?? []) {
    const g = ev.geometry?.[ev.geometry.length - 1];
    if (!g || g.type !== "Point") continue;
    const [lon, lat] = g.coordinates as [number, number];
    out.push({ id: ev.id, kind, title: ev.title, lat, lon, date: g.date, magnitude: g.magnitudeValue ?? null, unit: g.magnitudeUnit ?? null });
  }
  return out;
}

router.get("/ai/hazards", async (req: Request, res: Response) => {
  const kind = String(req.query.kind ?? "fires");
  const hit = hazardCache.get(kind);
  if (hit && Date.now() - hit.at < HAZARD_TTL) { res.json({ kind, events: hit.data, cached: true }); return; }
  try {
    const inflight = hit?.inflight ?? loadHazards(kind);
    hazardCache.set(kind, { at: hit?.at ?? 0, data: hit?.data ?? [], inflight });
    const data = await inflight;
    hazardCache.set(kind, { at: Date.now(), data });
    res.json({ kind, events: data, cached: false });
  } catch (e) {
    if (hit?.data.length) { hazardCache.set(kind, { at: hit.at, data: hit.data }); res.json({ kind, events: hit.data, stale: true }); return; }
    hazardCache.delete(kind);
    res.status(502).json({ error: String((e as Error).message) });
  }
});

// ─── routing proxy (foot / bike / car) ───────────────────────────────────────

const routeCache = new Map<string, unknown>();
router.get("/ai/route", async (req: Request, res: Response) => {
  const profile = ["foot", "bike", "car"].includes(String(req.query.profile)) ? String(req.query.profile) : "car";
  const coords = String(req.query.coords ?? "");
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?(;-?\d+(\.\d+)?,-?\d+(\.\d+)?)+$/.test(coords)) { res.status(400).json({ error: "coords=lon,lat;lon,lat" }); return; }
  const key = `${profile}:${coords}`;
  if (routeCache.has(key)) { res.json(routeCache.get(key)); return; }
  try {
    const r = await fetch(`https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {
      headers: { "user-agent": "worldview-osint/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json()) as { routes?: { distance: number; duration: number; geometry: { type: "LineString"; coordinates: number[][] } }[] };
    const route = j.routes?.[0];
    if (!route) { res.status(404).json({ error: "no route" }); return; }
    const out = { distanceM: route.distance, durationS: route.duration, geometry: route.geometry };
    if (routeCache.size > 200) routeCache.clear();
    routeCache.set(key, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message) });
  }
});

export default router;
