import type { BridgeRef } from "./bridge";
import { ACTION_TOOLS, TOOL_DECLS } from "./tools";
import { executeTool, sceneContext } from "./executor";
import { parseLocalIntent } from "./fast-intents";

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface AiMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  images?: string[];
  toolCalls?: ToolCall[];
  toolResults?: { id: string; name: string; result: unknown }[];
  raw?: unknown;
}

export type Provider = "gemini" | "openai";

export interface Quota { rpm: number; rpd: number; usedMinute: number; usedToday: number; cooldownSec: number }

export type AgentEvent =
  | { type: "tool"; name: string; args: Record<string, unknown>; say?: string; ok: boolean }
  | { type: "thinking"; round: number };

export class AgentError extends Error {
  constructor(message: string, public retryAfterSec: number | null) { super(message); }
}

const SYSTEM = `You are WORLDVIEW COPILOT, the voice operator of a live 3D geospatial intelligence console (MapLibre globe + Cesium photorealistic 3D).
You can DIRECT the camera, ANNOTATE the world, INTERROGATE live data (ADS-B aircraft, AIS ships, satellites, infrastructure, hazards, launches, CCTV) and OPERATE every panel, using the tools.

Rules:
- Act, don't ask. Call tools immediately; batch every independent tool call in ONE response (e.g. fly_to + set_vision_mode together).
- Each user turn ends with [SCENE] JSON (camera, open panels, selection, live counts). Use it to resolve "here", "this", "that plane".
- "this/that" + entity = the selected entity; use inspect_selected for "what's this?".
- Live questions: call the query_* tool, then answer from its numbers only. Never invent data. If a feed is empty, say so.
- "planes overhead" / "show me X here": query with region "view", then frame_results.
- "What happened in the last hour" / sitrep / brief me -> event_brief, then relay its brief text as-is. Specific news / airspace closure / NOTAM / maritime warning questions -> query_events. Always mention live correlations (aircraft inside restricted airspace, ships inside warning zones) when present.
- Routes: draw_route (walking/driving/cycling). "Fly the route" -> fly_route.
- Place names go to a literal OpenStreetMap geocoder, so YOU must disambiguate them with your own knowledge before calling a tool:
  * Always pass fully qualified names: "Landmark, City, Country" (e.g. "Empire State Building, New York, USA"). Infer the city from the other endpoint, the [SCENE] camera, or the conversation.
  * Use the CURRENT real name of the intended place, not a nickname or a place that no longer exists. "Twin Towers" with New York context -> "One World Trade Center, New York, USA" (the original towers were destroyed in 2001; say so briefly). "Twin Towers" with Malaysia context -> "Petronas Towers, Kuala Lumpur, Malaysia". "the Capitol" -> the capitol of the city in context.
  * Fix casing and typos ("TWIN TOWER" -> the landmark), never pass the user's raw words when you know the real place.
- "Draw X then fly it": call draw_route AND fly_route in the same batch (draw first). fly_route is skipped automatically if the draw fails.
- If draw_route fails or resolves the wrong place, retry ONCE with a better qualified name (and fly_route again if the user asked to fly).
- Outlining a state/country/park/building -> annotate_place. Distances -> measure_distance.
- Visual questions at street level -> capture_view, then describe ONLY clearly legible signs/buildings; say when something is unreadable.
- Replies are spoken aloud: 1-2 short sentences, plain text, no markdown, no lists, round numbers, no ids unless asked.`;

const MAX_ROUNDS = 5;
const MAX_HISTORY = 16;
const SCENE_MARK = "\n\n[SCENE] ";

/** Keep the last N messages starting at a user turn; drop old images and old scene blobs to save tokens. */
function trimHistory(history: AiMessage[]): AiMessage[] {
  let start = Math.max(0, history.length - MAX_HISTORY);
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start).map((m) => ({
    ...m,
    images: undefined,
    text: m.role === "user" && m.text?.includes(SCENE_MARK) ? m.text.slice(0, m.text.indexOf(SCENE_MARK)) : m.text,
  }));
}

/** Hosts and proxies reply with `{ error: "..." }`, `{ error: { code, message } }`, or plain text/HTML. */
export function errorText(error: unknown, status: number): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const o = error as { message?: unknown; code?: unknown };
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.code === "string") return `${o.code} (HTTP ${status})`;
  }
  if (status === 404) return "The AI server isn't available on this deployment (HTTP 404). It runs with the dev server; reload the preview.";
  if (status >= 500) return `The AI server didn't respond (HTTP ${status}). It may still be starting; try again in a moment.`;
  return `Request failed (HTTP ${status}).`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(base: string, provider: Provider, model: string | undefined, messages: AiMessage[]) {
  type ChatReply = { text?: string; toolCalls?: ToolCall[]; raw?: unknown; model?: string; quota?: Quota | null; error?: unknown; retryAfterSec?: number | null };
  const body = JSON.stringify({ provider, model, system: SYSTEM, messages, tools: TOOL_DECLS });
  let res: Response | null = null;
  let j: ChatReply = {};
  // One retry for transient gateway failures (preview waking up / dev server restarting). Not for 429 or app errors.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${base}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch {
      res = null;
    }
    j = res ? ((await res.json().catch(() => ({}))) as ChatReply) : {};
    const transient = !res || ([502, 503, 504].includes(res.status) && typeof j.error !== "string") || (res.status === 500 && j.error === undefined);
    if (!transient || attempt === 1) break;
    await sleep(2500);
  }
  if (!res) throw new AgentError("Couldn't reach the AI server. Check your connection and try again.", null);
  if (!res.ok) throw new AgentError(errorText(j.error, res.status), j.retryAfterSec ?? null);
  return { text: j.text ?? "", toolCalls: j.toolCalls ?? [], raw: j.raw, model: j.model ?? model ?? "", quota: j.quota ?? null };
}

export interface TurnResult {
  reply: string;
  history: AiMessage[];
  modelCalls: number;
  quota: Quota | null;
  model: string | null;
  local: boolean;
}

export async function runTurn(opts: {
  text: string;
  history: AiMessage[];
  provider: Provider;
  model?: string;
  bridgeRef: BridgeRef;
  base: string;
  onEvent?: (e: AgentEvent) => void;
}): Promise<TurnResult> {
  const { text, bridgeRef, base, onEvent } = opts;
  const ctx = { bridgeRef, base };

  // 1) Zero-cost local commands.
  const local = parseLocalIntent(text);
  // Routes need real-world knowledge to resolve nicknames ("Twin Towers"), so a local route that can't resolve
  // falls through to the model instead of failing.
  const localRoute = local?.some((c) => c.name === "draw_route") ?? false;
  if (local) {
    const says: string[] = [];
    let localFailed = false;
    for (const c of local) {
      let out;
      try {
        out = await executeTool(c.name, c.args, ctx);
      } catch (e) {
        out = { result: { ok: false, error: String((e as Error).message) }, say: `That failed: ${(e as Error).message}.` };
      }
      const ok = (out.result as { ok?: boolean })?.ok !== false;
      if (!ok && localRoute && c.name === "draw_route") { localFailed = true; break; }
      onEvent?.({ type: "tool", name: c.name, args: c.args, say: out.say, ok });
      if (out.say) says.push(out.say);
      // Don't fly a route that failed to draw.
      if (!ok) break;
    }
    if (!localFailed) {
      const reply = says.join(" ") || "Done.";
      return { reply, history: [...opts.history, { role: "user", text }, { role: "assistant", text: reply }], modelCalls: 0, quota: null, model: null, local: true };
    }
  }

  // 2) Model loop.
  const messages = trimHistory(opts.history);
  messages.push({ role: "user", text: text + SCENE_MARK + JSON.stringify(sceneContext(bridgeRef.current)) });
  let reply = "";
  let quota: Quota | null = null;
  let model: string | null = null;
  let calls = 0;
  let lastSays: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onEvent?.({ type: "thinking", round });
    const out = await callModel(base, opts.provider, opts.model, messages);
    calls++;
    quota = out.quota ?? quota;
    model = out.model || model;
    messages.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls.length ? out.toolCalls : undefined, raw: out.raw });
    // Lighter models sometimes return an empty final turn after a data tool; fall back to the tool's own summary.
    if (!out.toolCalls.length) { reply = out.text.trim() || lastSays.join(" "); break; }

    const results: { id: string; name: string; result: unknown }[] = [];
    const images: string[] = [];
    const says: string[] = [];
    let routeFailed = false;
    let anyFailed = false;
    for (const c of out.toolCalls) {
      let res: { result: unknown; say?: string; image?: string };
      if (c.name === "fly_route" && routeFailed) {
        // Otherwise fly_route falls back to the previous route and flies somewhere unrelated.
        res = { result: { ok: false, error: "skipped: the draw_route in this batch failed, nothing new to fly" } };
      } else {
        try {
          res = await executeTool(c.name, c.args ?? {}, ctx);
        } catch (e) {
          res = { result: { ok: false, error: String((e as Error).message) } };
        }
      }
      const ok = (res.result as { ok?: boolean })?.ok !== false;
      if (!ok) { anyFailed = true; if (c.name === "draw_route") routeFailed = true; }
      onEvent?.({ type: "tool", name: c.name, args: c.args ?? {}, say: res.say, ok });
      results.push({ id: c.id, name: c.name, result: res.result });
      if (res.image) images.push(res.image);
      if (res.say && ok) says.push(res.say);
    }
    messages.push({ role: "tool", toolResults: results, images: images.length ? images : undefined });
    lastSays = says;

    // Only successful console actions this round: confirmations are already known, skip the follow-up request.
    // On a failure, give the model another round so it can retry with a better place name or explain.
    if (!anyFailed && out.toolCalls.every((c) => ACTION_TOOLS.has(c.name))) {
      reply = out.text || says.join(" ") || "Done.";
      messages.push({ role: "assistant", text: reply });
      break;
    }
    if (round === MAX_ROUNDS - 1) {
      reply = out.text || says.join(" ") || "Done.";
      messages.push({ role: "assistant", text: reply });
    }
  }

  return { reply: reply || "Done.", history: messages, modelCalls: calls, quota, model, local: false };
}
