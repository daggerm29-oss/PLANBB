import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Mic, MicOff, Send, Volume2, VolumeX, X, Radio, LogIn, LogOut, Zap, Loader2 } from "lucide-react";
import type { BridgeRef } from "../lib/ai/bridge";
import { AgentError, runTurn, type AiMessage, type Provider, type Quota } from "../lib/ai/agent";
import { listenOnce, speak, speechInputSupported, speechOutputSupported, stopSpeaking, type ListenHandle } from "../lib/ai/voice";
import { bindAnnotations } from "../lib/ai/annotations";

interface Status {
  gemini: { configured: boolean; defaultModel: string; models: string[]; quota: Record<string, Quota> };
  openai: { local: boolean; oauth: { signedIn: boolean; email: string | null }; apiKey: boolean; models: string[] };
}

type LogEntry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "ai"; text: string; meta?: string }
  | { id: number; kind: "tool"; text: string; ok: boolean }
  | { id: number; kind: "error"; text: string };
type NewLogEntry = LogEntry extends infer T ? (T extends LogEntry ? Omit<T, "id"> : never) : never;

const PREFS_KEY = "worldview.ai.prefs";
const ACCENT = "#7df9ff";
const FONT = "'Share Tech Mono','Courier New',monospace";

const TOOL_LABEL: Record<string, string> = {
  fly_to: "FLY", set_camera: "CAMERA", zoom_out_globe: "GLOBE", orbit: "ORBIT", stop_camera: "STOP", frame_results: "FRAME",
  track_entity: "TRACK", select_entity: "SELECT", exit_view: "EXIT", fly_route: "FLY ROUTE", set_vision_mode: "SENSOR",
  toggle_panel: "PANEL", set_aircraft_feed: "FEED", set_infrastructure_layer: "LAYER", set_cctv_coverage: "VIEWSHED",
  open_airport_view: "AIRPORT", open_infrastructure_360: "360", play_launch: "LAUNCH", annotate_place: "ANNOTATE",
  draw_pin: "PIN", draw_route: "ROUTE", measure_distance: "MEASURE", draw_circle: "RING", draw_polygon: "POLYGON",
  clear_annotations: "CLEAR", query_aircraft: "QUERY ADS-B", query_ships: "QUERY AIS", query_satellites: "QUERY SATS",
  query_infrastructure: "QUERY INFRA", query_hazards: "QUERY HAZARDS", query_launches: "QUERY LAUNCHES", query_cctv: "QUERY CCTV",
  inspect_selected: "INSPECT", describe_view: "CONTEXT", capture_view: "VISUAL",
};

function readPrefs(): { provider: Provider; geminiModel: string; openaiModel: string; speakOn: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { provider: p.provider === "openai" ? "openai" : "gemini", geminiModel: p.geminiModel ?? "", openaiModel: p.openaiModel ?? "", speakOn: p.speakOn !== false };
  } catch {
    return { provider: "gemini", geminiModel: "", openaiModel: "", speakOn: true };
  }
}

function argSummary(args: Record<string, unknown>): string {
  const v = args.place ?? args.query ?? args.region ?? args.mode ?? args.panel ?? args.kind ?? (args.from && args.to ? `${args.from} → ${args.to}` : undefined);
  return v ? ` ${String(v)}` : "";
}

let logSeq = 0;

export function AiCopilot({ bridgeRef, base }: { bridgeRef: BridgeRef; base: string }) {
  const prefs = useRef(readPrefs()).current;
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(prefs.provider);
  const [geminiModel, setGeminiModel] = useState(prefs.geminiModel);
  const [openaiModel, setOpenaiModel] = useState(prefs.openaiModel);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [speakOn, setSpeakOn] = useState(prefs.speakOn && speechOutputSupported());
  const [handsFree, setHandsFree] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [stats, setStats] = useState({ local: 0, calls: 0 });

  const historyRef = useRef<AiMessage[]>([]);
  const listenRef = useRef<ListenHandle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const busyRef = useRef(false);

  const model = provider === "gemini" ? geminiModel : openaiModel;
  const cooldownSec = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    bindAnnotations(bridgeRef.current?.map ?? null);
  });

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ provider, geminiModel, openaiModel, speakOn }));
  }, [provider, geminiModel, openaiModel, speakOn]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [log, interim]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const push = useCallback((e: NewLogEntry) => {
    setLog((l) => [...l.slice(-80), { ...e, id: ++logSeq } as LogEntry]);
  }, []);

  const refreshStatus = useCallback(async () => {
    // The status call can land while the preview is still waking up; retry briefly instead of
    // leaving the panel stuck on "connect a provider" until it's reopened.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${base}/api/ai/status`);
        if (r.ok) {
          const s = (await r.json()) as Status;
          if (s?.gemini) {
            setStatus(s);
            setQuota(s.gemini.quota[geminiModel || s.gemini.defaultModel] ?? null);
            return;
          }
        }
      } catch { /* not reachable yet */ }
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }, [base, geminiModel]);

  const loadOpenaiModels = useCallback(async () => {
    try {
      const r = await fetch(`${base}/api/ai/openai/models`);
      const j = (await r.json()) as { models: string[] };
      setOpenaiModels(j.models ?? []);
    } catch { /* ignore */ }
  }, [base]);

  const toggleOpen = useCallback((next?: boolean) => {
    setOpen((o) => {
      const v = next ?? !o;
      if (v) {
        void refreshStatus();
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      return v;
    });
  }, [refreshStatus]);

  const startListening = useCallback(() => {
    if (listenRef.current || !speechInputSupported()) return;
    stopSpeaking();
    setListening(true);
    setInterim("");
    listenRef.current = listenOnce(
      {
        onInterim: setInterim,
        onFinal: (t) => {
          setInterim("");
          void submitRef.current(t);
        },
        onError: (e) => {
          if (e !== "no-speech" && e !== "aborted") {
            push({ kind: "error", text: e.startsWith("Microphone") || e.startsWith("No microphone") ? e : `Mic: ${e}` });
          }
        },
        onEnd: () => {
          listenRef.current = null;
          setListening(false);
          setInterim("");
        },
      },
      base
    );
    if (!listenRef.current) setListening(false);
  }, [base, push]);

  const stopListening = useCallback(() => {
    listenRef.current?.stop();
  }, []);

  const submit = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    if (cooldownUntil > Date.now()) {
      push({ kind: "error", text: `Quota cooling down — ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s. Local commands (fly to, zoom out, sensors, panels) still work.` });
    }
    busyRef.current = true;
    setBusy(true);
    setInput("");
    stopSpeaking();
    push({ kind: "user", text });
    try {
      const res = await runTurn({
        text,
        history: historyRef.current,
        provider,
        model: model || undefined,
        bridgeRef,
        base,
        onEvent: (e) => {
          if (e.type === "tool") push({ kind: "tool", text: `${TOOL_LABEL[e.name] ?? e.name}${argSummary(e.args)}`, ok: e.ok });
        },
      });
      historyRef.current = res.history;
      if (res.quota) setQuota(res.quota);
      setStats((s) => ({ local: s.local + (res.local ? 1 : 0), calls: s.calls + res.modelCalls }));
      push({ kind: "ai", text: res.reply, meta: res.local ? "LOCAL · 0 CALLS" : `${(res.model ?? "").toUpperCase()} · ${res.modelCalls} CALL${res.modelCalls === 1 ? "" : "S"}` });
      if (speakOn) await speak(res.reply);
    } catch (e) {
      const err = e as AgentError;
      if (err.retryAfterSec) setCooldownUntil(Date.now() + err.retryAfterSec * 1000);
      setNow(Date.now());
      push({ kind: "error", text: typeof err?.message === "string" && err.message ? err.message : "That request failed. Try again in a moment." });
      void refreshStatus();
      if (speakOn) void speak(err.retryAfterSec ? "I'm rate limited. Try again shortly." : "That request failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (handsFreeRef.current) setTimeout(() => startListening(), 250);
    }
  }, [base, bridgeRef, cooldownUntil, model, provider, push, speakOn, startListening]);

  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Global hotkeys: "/" opens + focuses, "`" toggles the mic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); toggleOpen(true); }
      else if (e.key === "`") {
        e.preventDefault();
        if (!open) toggleOpen(true);
        if (listenRef.current) stopListening(); else startListening();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, startListening, stopListening, toggleOpen]);

  const signIn = () => {
    window.location.href = `${base}/api/ai/openai/login?return=${encodeURIComponent(window.location.href)}`;
  };
  const signOut = async () => {
    await fetch(`${base}/api/ai/openai/logout`, { method: "POST" });
    void refreshStatus();
  };

  const chooseProvider = (p: Provider) => {
    setProvider(p);
    historyRef.current = [];
    if (p === "openai") void loadOpenaiModels();
    void refreshStatus();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggleOpen(true)}
        aria-label="Open AI copilot (press /)"
        style={{
          position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 45,
          display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderRadius: 999,
          background: "rgba(2,4,8,0.82)", border: `1px solid ${ACCENT}55`, color: ACCENT, fontFamily: FONT,
          fontSize: 12, letterSpacing: "0.22em", cursor: "pointer", backdropFilter: "blur(10px)",
          boxShadow: `0 0 18px ${ACCENT}22`,
        }}
      >
        <Bot size={15} aria-hidden="true" />
        AI COPILOT
        <kbd style={{ fontFamily: FONT, fontSize: 10, color: `${ACCENT}99`, border: `1px solid ${ACCENT}44`, borderRadius: 4, padding: "0 5px" }}>/</kbd>
      </button>
    );
  }

  const gemModels = status?.gemini.models ?? ["gemini-flash-latest", "gemini-flash-lite-latest"];
  const oaModels = openaiModels.length ? openaiModels : status?.openai.models ?? [];
  const openaiReady = !!status && (status.openai.apiKey || (status.openai.local && status.openai.oauth.signedIn));
  const providerReady = provider === "gemini" ? !!status?.gemini.configured : openaiReady;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px", fontFamily: FONT, fontSize: 10.5, letterSpacing: "0.16em", cursor: "pointer", borderRadius: 4,
    border: `1px solid ${active ? ACCENT : `${ACCENT}33`}`, background: active ? `${ACCENT}22` : "transparent", color: active ? ACCENT : `${ACCENT}99`,
  });
  const iconBtn = (active = false): React.CSSProperties => ({
    display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 6, cursor: "pointer",
    border: `1px solid ${active ? ACCENT : `${ACCENT}33`}`, background: active ? `${ACCENT}22` : "transparent", color: active ? ACCENT : `${ACCENT}aa`,
  });

  return (
    <section
      aria-label="AI copilot"
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 45,
        width: "min(600px, calc(100vw - 140px))", display: "flex", flexDirection: "column",
        background: "rgba(2,4,8,0.9)", border: `1px solid ${ACCENT}44`, borderRadius: 10, color: "#d8faff",
        fontFamily: FONT, backdropFilter: "blur(14px)", boxShadow: `0 0 32px ${ACCENT}1f, inset 0 0 18px ${ACCENT}0d`,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${ACCENT}22`, flexWrap: "wrap" }}>
        <Bot size={15} color={ACCENT} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: "0.28em", color: ACCENT, fontWeight: 400 }}>COPILOT</h2>
        <div role="group" aria-label="AI provider" style={{ display: "flex", gap: 4, marginLeft: 6 }}>
          <button type="button" style={chip(provider === "gemini")} onClick={() => chooseProvider("gemini")} aria-pressed={provider === "gemini"}>GEMINI</button>
          <button type="button" style={chip(provider === "openai")} onClick={() => chooseProvider("openai")} aria-pressed={provider === "openai"}>OPENAI</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 140 }}>
          <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Model</span>
          <input
            list={`ai-models-${provider}`}
            value={model}
            placeholder={provider === "gemini" ? status?.gemini.defaultModel ?? "gemini-flash-latest" : oaModels[0] ?? "gpt-5.1"}
            onChange={(e) => (provider === "gemini" ? setGeminiModel(e.target.value) : setOpenaiModel(e.target.value))}
            onFocus={() => { if (provider === "openai" && !openaiModels.length) void loadOpenaiModels(); }}
            style={{ width: "100%", background: "rgba(125,249,255,0.05)", border: `1px solid ${ACCENT}33`, borderRadius: 4, color: ACCENT, fontFamily: FONT, fontSize: 11, padding: "4px 8px" }}
          />
          <datalist id={`ai-models-${provider}`}>
            {(provider === "gemini" ? gemModels : oaModels).map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
        <button type="button" style={iconBtn(speakOn)} onClick={() => { if (speakOn) stopSpeaking(); setSpeakOn((v) => !v); }} aria-pressed={speakOn} aria-label={speakOn ? "Mute voice replies" : "Speak replies"} disabled={!speechOutputSupported()}>
          {speakOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <button type="button" style={iconBtn(handsFree)} onClick={() => { const v = !handsFree; setHandsFree(v); if (v) startListening(); else stopListening(); }} aria-pressed={handsFree} aria-label="Hands-free voice mode" disabled={!speechInputSupported()}>
          <Radio size={14} />
        </button>
        <button type="button" style={iconBtn()} onClick={() => { stopListening(); stopSpeaking(); setHandsFree(false); toggleOpen(false); }} aria-label="Close copilot">
          <X size={14} />
        </button>
      </header>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", fontSize: 10, letterSpacing: "0.14em", color: `${ACCENT}88`, borderBottom: `1px solid ${ACCENT}14`, flexWrap: "wrap" }}>
        {provider === "gemini" ? (
          status && !status.gemini.configured ? (
            <span style={{ color: "#ffb4a8" }}>GEMINI_KEY NOT SET ON SERVER</span>
          ) : (
            <span>
              <Zap size={10} style={{ verticalAlign: -1, marginRight: 4 }} aria-hidden="true" />
              {quota ? `${quota.usedMinute}/${quota.rpm} RPM · ${quota.usedToday}/${quota.rpd} TODAY` : "FREE TIER"}
            </span>
          )
        ) : !status ? null : status.openai.local ? (
          status.openai.oauth.signedIn ? (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              CHATGPT · {status.openai.oauth.email ?? "SIGNED IN"}
              <button type="button" onClick={signOut} style={{ ...chip(false), padding: "2px 8px", display: "flex", alignItems: "center", gap: 4 }}><LogOut size={10} />SIGN OUT</button>
            </span>
          ) : (
            <button type="button" onClick={signIn} style={{ ...chip(true), display: "flex", alignItems: "center", gap: 6 }}><LogIn size={11} />SIGN IN WITH CHATGPT</button>
          )
        ) : status.openai.apiKey ? (
          <span>OPENAI_API_KEY</span>
        ) : (
          <span style={{ color: "#ffd39a" }}>OPENAI OAUTH RUNS LOCALLY ONLY — START THE APP ON LOCALHOST</span>
        )}
        <span style={{ marginLeft: "auto" }}>{stats.local} LOCAL · {stats.calls} MODEL CALLS</span>
        {cooldownSec > 0 && <span style={{ color: "#ffb347" }}>COOLDOWN {cooldownSec}s</span>}
      </div>

      <div role="log" aria-live="polite" style={{ maxHeight: "34vh", minHeight: 64, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, lineHeight: 1.45 }}>
        {log.length === 0 && (
          <p style={{ margin: 0, color: `${ACCENT}77`, fontSize: 11.5 }}>
            {'Try: "Take me to Tokyo" · "How many flights are over Texas?" · "Outline the state of Texas" · "Draw the walking route from the Texas Capitol to Zilker Park" then "Fly the route" · "Biggest fire near Los Angeles?" · "Switch to night vision". Press ` to talk.'}
          </p>
        )}
        {log.map((e) =>
          e.kind === "user" ? (
            <div key={e.id} style={{ alignSelf: "flex-end", maxWidth: "85%", background: `${ACCENT}14`, border: `1px solid ${ACCENT}2a`, borderRadius: 8, padding: "5px 10px", color: "#eafcff" }}>{e.text}</div>
          ) : e.kind === "tool" ? (
            <div key={e.id} style={{ fontSize: 10.5, letterSpacing: "0.12em", color: e.ok ? "#39ff88cc" : "#ff8a80cc" }}>{e.ok ? "▸" : "✕"} {e.text}</div>
          ) : e.kind === "error" ? (
            <div key={e.id} role="alert" style={{ color: "#ff9f8f", fontSize: 11.5 }}>{e.text}</div>
          ) : (
            <div key={e.id} style={{ maxWidth: "92%" }}>
              <div style={{ color: "#d8faff" }}>{e.text}</div>
              {e.meta && <div style={{ fontSize: 9.5, letterSpacing: "0.16em", color: `${ACCENT}66`, marginTop: 2 }}>{e.meta}</div>}
            </div>
          ),
        )}
        {interim && <div style={{ alignSelf: "flex-end", color: `${ACCENT}aa`, fontStyle: "italic" }}>{interim}…</div>}
        {busy && <div style={{ display: "flex", alignItems: "center", gap: 6, color: `${ACCENT}99`, fontSize: 11 }}><Loader2 size={12} className="animate-spin" aria-hidden="true" />WORKING</div>}
        <div ref={logEndRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(input); }}
        style={{ display: "flex", gap: 6, padding: 8, borderTop: `1px solid ${ACCENT}22` }}
      >
        <button
          type="button"
          onClick={() => (listening ? stopListening() : startListening())}
          aria-label={listening ? "Stop listening" : "Talk (press `)"}
          aria-pressed={listening}
          disabled={!speechInputSupported()}
          title={speechInputSupported() ? "Push to talk ( ` )" : "Speech input not supported in this browser"}
          style={{ ...iconBtn(listening), width: 38, height: 36, color: listening ? "#ff5f57" : iconBtn().color, borderColor: listening ? "#ff5f57" : `${ACCENT}33`, boxShadow: listening ? "0 0 14px #ff5f5755" : "none" }}
        >
          {listening ? <Mic size={16} /> : speechInputSupported() ? <Mic size={16} /> : <MicOff size={16} />}
        </button>
        <label style={{ flex: 1, display: "flex" }}>
          <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Command</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
              if (e.key === "Escape") toggleOpen(false);
            }}
            placeholder={providerReady ? "Command the console…" : "Local commands work; connect a provider for questions"}
            autoComplete="off"
            style={{ flex: 1, background: "rgba(125,249,255,0.05)", border: `1px solid ${ACCENT}33`, borderRadius: 6, color: "#eafcff", fontFamily: FONT, fontSize: 13, padding: "0 10px", outline: "none" }}
          />
        </label>
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send" style={{ ...iconBtn(!!input.trim()), width: 38, height: 36, opacity: busy ? 0.5 : 1 }}>
          <Send size={15} />
        </button>
      </form>
    </section>
  );
}
