import { useMemo, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Pause, Play, Radio, RotateCcw, X } from "lucide-react";
import type { Launch, LaunchPlayMode } from "../lib/launches";
import { formatMissionClock, formatUtc, isLiveWindow, missionTitle, statusColor } from "../lib/launches";
import type { Trajectory } from "../lib/launch-trajectory";
import { playbackForMissionTime, type ShotId, type Timeline } from "../lib/launch-director";
import { rocketSvg } from "../lib/rocket-icon";
import type { ReplayControls } from "./LaunchReplayView";

export interface ReplayTelemetry {
  mode: LaunchPlayMode;
  t: number;
  p: number;
  totalP: number;
  paused: boolean;
  speed: number;
  director: "auto" | "free";
  intro: boolean;
  shotIndex: number;
  shotCount: number;
  cam: string;
  shotLabel: string;
  variant: ShotId;
  cutCount: number;
  altKm: number;
  velMs: number;
  downrangeKm: number;
  phase: string;
  booster: { altKm: number; velMs: number; landed: boolean; burning: boolean } | null;
  toast: string | null;
  toastAt: number;
  utcMs: number;
  tilesReady: boolean;
}

interface Props {
  launch: Launch;
  trajectory: Trajectory;
  timeline: Timeline;
  telemetry: ReplayTelemetry | null;
  visible: boolean;
  index: number;
  count: number;
  speeds: number[];
  trackerRef: RefObject<HTMLDivElement | null>;
  boosterTagRef: RefObject<HTMLDivElement | null>;
  controls: RefObject<ReplayControls | null>;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
}

const FONT = "'Share Tech Mono','Courier New',monospace";
const CYAN = "#22d3ee";
const CYAN_DIM = "rgba(125,249,255,0.55)";
const AMBER = "#fbbf24";
const PANEL_BG = "rgba(3,9,16,0.78)";
const BORDER = "1px solid rgba(34,211,238,0.28)";

const MODE_STYLE: Record<LaunchPlayMode, { label: string; color: string }> = {
  live: { label: "LIVE · REAL-TIME TRACK", color: "#f43f5e" },
  replay: { label: "REPLAY · RECONSTRUCTION", color: CYAN },
  simulation: { label: "SIMULATION · PREDICTED", color: "#a78bfa" },
};

const STYLE_TAG = `
@keyframes lr-cut { 0% { opacity: 1 } 35% { opacity: .85 } 100% { opacity: 0 } }
@keyframes lr-scan { 0% { transform: translateY(-10vh) } 100% { transform: translateY(110vh) } }
@keyframes lr-toast { 0% { opacity: 0; letter-spacing: .9em } 12% { opacity: 1; letter-spacing: .42em } 80% { opacity: 1 } 100% { opacity: 0 } }
@keyframes lr-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
@keyframes lr-spin { to { transform: rotate(360deg) } }
@keyframes lr-bracket { 0%,100% { transform: translate(-50%,-50%) scale(1) } 50% { transform: translate(-50%,-50%) scale(1.12) } }
  .lr-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: ${FONT}; background: rgba(34,211,238,0.06); border: 1px solid rgba(34,211,238,0.38); color: ${CYAN}; letter-spacing: .18em; font-size: 10px; text-transform: uppercase; padding: 8px 10px; cursor: pointer; transition: background .15s, box-shadow .15s, color .15s; }
.lr-btn:hover { background: rgba(34,211,238,0.16); box-shadow: 0 0 14px rgba(34,211,238,0.35); color: #e6fdff; }
.lr-btn:focus-visible { outline: 1px solid #e6fdff; outline-offset: 2px; }
.lr-btn[data-active="true"] { background: rgba(34,211,238,0.2); color: #e6fdff; box-shadow: inset 0 0 10px rgba(34,211,238,0.35); }
.lr-btn[data-danger="true"] { color: #fb7185; border-color: rgba(251,113,133,0.5); background: rgba(251,113,133,0.06); }
.lr-range { -webkit-appearance: none; appearance: none; width: 100%; height: 2px; background: rgba(34,211,238,0.3); outline: none; }
.lr-range::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: ${CYAN}; box-shadow: 0 0 10px ${CYAN}; cursor: pointer; }
.lr-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: ${CYAN}; border: none; box-shadow: 0 0 10px ${CYAN}; cursor: pointer; }
`;

function Corners({ color = CYAN, size = 8 }: { color?: string; size?: number }) {
  const b = `1px solid ${color}`;
  const s: CSSProperties = { position: "absolute", width: size, height: size, pointerEvents: "none" };
  return (
    <>
      <span style={{ ...s, top: -1, left: -1, borderTop: b, borderLeft: b }} />
      <span style={{ ...s, top: -1, right: -1, borderTop: b, borderRight: b }} />
      <span style={{ ...s, bottom: -1, left: -1, borderBottom: b, borderLeft: b }} />
      <span style={{ ...s, bottom: -1, right: -1, borderBottom: b, borderRight: b }} />
    </>
  );
}

function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        position: "relative",
        background: PANEL_BG,
        border: BORDER,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        boxShadow: "0 0 24px rgba(0,0,0,0.5), inset 0 0 18px rgba(34,211,238,0.05)",
        ...style,
      }}
    >
      <Corners />
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9.5, letterSpacing: "0.28em", color: CYAN_DIM, textTransform: "uppercase", marginBottom: 8 }}>
      <span>{children}</span>
      <span style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(34,211,238,0.4), transparent)" }} />
    </div>
  );
}

function Readout({ label, value, unit, accent = "#e6fdff" }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, letterSpacing: "0.26em", color: CYAN_DIM }}>{label}</span>
      <span style={{ fontSize: 19, color: accent, letterSpacing: "0.04em", textShadow: `0 0 12px ${accent}55`, fontVariantNumeric: "tabular-nums" }}>
        {value}
        {unit && <span style={{ fontSize: 10, color: CYAN_DIM, marginLeft: 5, letterSpacing: "0.2em" }}>{unit}</span>}
      </span>
    </div>
  );
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "--");

export function LaunchReplayHud({ launch, trajectory: tr, timeline, telemetry: tm, visible, index, count, speeds, trackerRef, boosterTagRef, controls, onPrev, onNext, onExit }: Props) {
  const mode = tm?.mode ?? "replay";
  const ms = MODE_STYLE[mode];
  const t = tm?.t ?? -14;
  const canLive = isLiveWindow(launch);
  const core = launch.stages.find((s) => (s.type ?? "Core") === "Core") ?? launch.stages[0];

  const eventMarks = useMemo(
    () =>
      tr.events.map((ev) => ({
        ...ev,
        f: Math.min(1, playbackForMissionTime(timeline, ev.t) / timeline.totalP),
      })),
    [tr, timeline],
  );
  const eventLabels = useMemo(() => {
    const out: typeof eventMarks = [];
    let lastF = Number.NEGATIVE_INFINITY;
    for (const ev of [...eventMarks].sort((a, b) => a.f - b.f)) {
      if (ev.f - lastF < 0.085) continue;
      out.push(ev);
      lastF = ev.f;
    }
    return out;
  }, [eventMarks]);
  const shotMarks = useMemo(
    () => timeline.shots.filter((s) => s.id !== "hold").map((s, i) => ({ id: s.id, cam: s.cam, f: timeline.pStarts[i] / timeline.totalP, w: s.dur / timeline.totalP })),
    [timeline],
  );
  const progress = tm ? Math.min(1, (mode === "live" ? playbackForMissionTime(timeline, t) : tm.p) / timeline.totalP) : 0;
  const speedIdx = Math.max(0, speeds.indexOf(tm?.speed ?? 1));
  const inOrbit = t > tr.tInsert && tr.spec.kind !== "suborbital";
  const tagTitle = t < 0 ? `ON PAD · ${launch.rocket.toUpperCase()}` : inOrbit ? "EST. ORBIT POSITION" : `ASCENT ESTIMATE · ${launch.rocket.toUpperCase()}`;
  const nextEvent = tr.events.find((e) => e.t > t);

  const fade: CSSProperties = { opacity: visible ? 1 : 0, transition: "opacity 600ms ease" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 5000, pointerEvents: "none", fontFamily: FONT, color: "#e6fdff", ...fade }}>
      <style>{STYLE_TAG}</style>

      {/* Cinematic letterbox */}
      <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: "7vh", background: "linear-gradient(#000 70%, rgba(0,0,0,0.0))" }} />
      <div aria-hidden style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "9vh", background: "linear-gradient(rgba(0,0,0,0), #000 45%)" }} />
      <div aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,6,0.55) 100%)" }} />

      {/* Hard-cut flash between camera shots */}
      {tm && tm.cutCount > 0 && (
        <div key={tm.cutCount} aria-hidden style={{ position: "absolute", inset: 0, background: "#000", animation: "lr-cut 420ms ease-out forwards" }}>
          <div style={{ position: "absolute", left: 0, right: 0, height: 2, background: "rgba(125,249,255,0.8)", boxShadow: "0 0 18px #22d3ee", animation: "lr-scan 420ms linear forwards" }} />
        </div>
      )}

      {/* Screen-space tracker on the vehicle (positioned imperatively every frame) */}
      <div ref={trackerRef} style={{ position: "absolute", left: 0, top: 0, opacity: 0, willChange: "transform" }}>
        <div style={{ position: "absolute", width: 34, height: 34, transform: "translate(-50%,-50%)", animation: "lr-bracket 1.6s ease-in-out infinite" }}>
          <Corners color={inOrbit ? AMBER : CYAN} size={9} />
        </div>
        <div style={{ position: "absolute", left: 26, top: -16, whiteSpace: "nowrap", borderLeft: `2px solid ${inOrbit ? AMBER : CYAN}`, paddingLeft: 8, background: "rgba(2,6,12,0.72)", padding: "4px 8px" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.16em", color: inOrbit ? "#fde68a" : "#a5f3fc" }}>{tagTitle}</div>
          <div style={{ fontSize: 10, color: CYAN_DIM, letterSpacing: "0.12em" }}>{tm ? formatUtc(tm.utcMs) : ""}</div>
          <div style={{ fontSize: 10, color: "#e6fdff", letterSpacing: "0.12em" }}>
            {tm ? `ALT ${fmt(tm.altKm)} KM · ${fmt(tm.velMs / 1000, 2)} KM/S` : ""}
          </div>
        </div>
      </div>
      <div ref={boosterTagRef} style={{ position: "absolute", left: 0, top: 0, opacity: 0, willChange: "transform" }}>
        <div style={{ position: "absolute", width: 24, height: 24, transform: "translate(-50%,-50%)" }}>
          <Corners color={AMBER} size={7} />
        </div>
        <div style={{ position: "absolute", left: 20, top: -10, whiteSpace: "nowrap", fontSize: 10, letterSpacing: "0.14em", color: "#fde68a", background: "rgba(2,6,12,0.7)", padding: "3px 7px", borderLeft: `2px solid ${AMBER}` }}>
          BOOSTER {core?.serial ?? ""} · {tm?.booster ? `${fmt(tm.booster.altKm)} KM` : ""}
          {tm?.booster?.burning ? " · BURN" : ""}
        </div>
      </div>

      {/* Top-left: mission dossier */}
      <div style={{ position: "absolute", top: 18, left: 64, width: "min(380px, 40vw)", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            style={{ width: 30, height: 45, display: "inline-block", filter: "drop-shadow(0 0 8px rgba(34,211,238,0.6))" }}
            dangerouslySetInnerHTML={{ __html: rocketSvg(CYAN, { size: 30 }) }}
          />
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.34em", color: ms.color, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: ms.color, boxShadow: `0 0 10px ${ms.color}`, animation: "lr-pulse 1.2s ease-in-out infinite" }} />
              {ms.label}
            </div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 400, letterSpacing: "0.22em", color: "#ffffff", textShadow: "0 0 18px rgba(34,211,238,0.45)" }}>
              {launch.rocket.toUpperCase()}
            </h1>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#a5f3fc", letterSpacing: "0.14em", textTransform: "uppercase" }}>{missionTitle(launch)}</div>
        <div style={{ fontSize: 10, color: CYAN_DIM, letterSpacing: "0.14em", lineHeight: 1.6 }}>
          {launch.provider ?? ""} · {launch.pad.name}
          <br />
          {launch.pad.location ?? ""}
          <br />
          NET {formatUtc(Date.parse(launch.net))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", padding: "3px 7px", border: `1px solid ${statusColor(launch.status)}`, color: statusColor(launch.status) }}>
            {launch.statusName.toUpperCase()}
          </span>
          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", padding: "3px 7px", border: BORDER, color: "#a5f3fc" }}>
            {tr.spec.label} · {fmt(tr.spec.inclinationDeg, 1)}°
          </span>
        </div>
      </div>

      {/* Top-centre: active camera */}
      <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, letterSpacing: "0.3em" }}>
          <span style={{ color: "#f43f5e", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f43f5e", animation: "lr-pulse 1s steps(2) infinite" }} />
            REC
          </span>
          <span style={{ color: CYAN }}>{tm?.director === "free" ? "FREE CAM · 360°" : tm?.cam ?? "CAM --"}</span>
          <span style={{ color: CYAN_DIM }}>
            {tm ? `${Math.min(tm.shotIndex + 1, tm.shotCount)}/${tm.shotCount}` : ""}
          </span>
        </div>
        <div style={{ fontSize: 13, letterSpacing: "0.32em", color: "#e6fdff", textShadow: "0 0 12px rgba(34,211,238,0.6)" }}>
          {tm?.intro ? "ACQUIRING TARGET" : tm?.director === "free" ? "DRAG TO ORBIT · WHEEL TO ZOOM" : tm?.shotLabel ?? ""}
        </div>
      </div>

      {/* Top-right: mission clock */}
      <div style={{ position: "absolute", top: 16, right: 22, textAlign: "right" }}>
        <div style={{ fontSize: 10, letterSpacing: "0.32em", color: CYAN_DIM }}>MISSION ELAPSED</div>
        <div style={{ fontSize: 34, letterSpacing: "0.08em", color: t < 0 ? "#fde68a" : "#ffffff", textShadow: `0 0 20px ${t < 0 ? "rgba(251,191,36,0.5)" : "rgba(34,211,238,0.55)"}`, fontVariantNumeric: "tabular-nums" }}>
          {formatMissionClock(t)}
        </div>
        <div style={{ fontSize: 10, color: CYAN_DIM, letterSpacing: "0.16em" }}>{tm ? formatUtc(tm.utcMs) : ""}</div>
        <div style={{ fontSize: 10, color: "#a5f3fc", letterSpacing: "0.22em", marginTop: 4 }}>{tm?.phase ?? ""}</div>
      </div>

      {/* Left: flight telemetry */}
      <Panel style={{ position: "absolute", left: 64, top: "34vh", width: 214, padding: "12px 14px" }}>
        <SectionTitle>Flight telemetry</SectionTitle>
        <div style={{ display: "flex", gap: 14 }}>
          <AltitudeBar altKm={tm?.altKm ?? 0} maxKm={Math.max(250, tr.spec.insertAltM / 1000 * 1.2)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Readout label="ALTITUDE" value={fmt(tm?.altKm ?? 0)} unit="KM" />
            <Readout label="VELOCITY" value={fmt(((tm?.velMs ?? 0) * 3.6), 0)} unit="KM/H" />
            <Readout label="DOWNRANGE" value={fmt(tm?.downrangeKm ?? 0, 0)} unit="KM" />
            <Readout label="MACH" value={fmt((tm?.velMs ?? 0) / 295, 1)} accent="#a5f3fc" />
          </div>
        </div>
        {nextEvent && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(34,211,238,0.25)", fontSize: 10, letterSpacing: "0.14em", color: CYAN_DIM }}>
            NEXT · <span style={{ color: nextEvent.booster ? "#fde68a" : "#e6fdff" }}>{nextEvent.label}</span>
            <span style={{ float: "right", color: "#e6fdff" }}>{formatMissionClock(nextEvent.t - t).replace("T+", "−").replace("T-", "+")}</span>
          </div>
        )}
      </Panel>

      {/* Right: recovery + replay controls */}
      <Panel style={{ position: "absolute", right: 22, top: "17vh", width: "min(320px, 34vw)", padding: "12px 14px", pointerEvents: "auto", maxHeight: "68vh", overflowY: "auto" }}>
        <SectionTitle>Stage / re-entry / recovery</SectionTitle>
        <div role="table" aria-label="Stage recovery" style={{ fontSize: 10, letterSpacing: "0.08em" }}>
          <div role="row" style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr 1.2fr", color: CYAN_DIM, letterSpacing: "0.18em", fontSize: 9, paddingBottom: 4 }}>
            <span role="columnheader">STAGE</span>
            <span role="columnheader">STATUS</span>
            <span role="columnheader">FINAL POSITION</span>
          </div>
          {(launch.stages.length ? launch.stages : [null]).map((s, i) => {
            const status = !s
              ? "UNKNOWN"
              : s.landingAttempt === false
                ? "EXPENDED"
                : s.landingSuccess === true
                  ? "RECOVERED"
                  : s.landingSuccess === false
                    ? "LOST"
                    : s.landingAttempt
                      ? "ATTEMPT"
                      : "TBD";
            const col = status === "RECOVERED" ? "#34d399" : status === "LOST" ? "#f87171" : status === "EXPENDED" ? "#fb923c" : "#e6fdff";
            return (
              <div key={i} role="row" style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr 1.2fr", padding: "6px 0", borderTop: "1px solid rgba(34,211,238,0.12)" }}>
                <span role="cell">
                  {(s?.type ?? "Core")} · {s?.serial ?? "—"}
                  <br />
                  <span style={{ color: CYAN_DIM, fontSize: 9 }}>
                    {s?.flight ? `FLIGHT ${s.flight}` : ""}
                    {s?.reused ? " · REUSED" : s?.reused === false ? " · NEW" : ""}
                  </span>
                </span>
                <span role="cell" style={{ color: col }}>{status}</span>
                <span role="cell">
                  {s?.landingAttempt
                    ? `${s.landingName ?? s.landingType ?? "—"}${s.landingDownrangeKm ? ` · ${Math.round(s.landingDownrangeKm)} KM` : ""}`
                    : s?.landingAttempt === false
                      ? "OCEAN · UNRECOVERED"
                      : "—"}
                </span>
              </div>
            );
          })}
        </div>
        {tm?.booster && (
          <div style={{ marginTop: 8, display: "flex", gap: 14, fontSize: 10, color: "#fde68a", letterSpacing: "0.14em" }}>
            <span>B-ALT {fmt(tm.booster.altKm)} KM</span>
            <span>B-VEL {fmt(tm.booster.velMs * 3.6, 0)} KM/H</span>
            <span style={{ color: tm.booster.landed ? "#34d399" : tm.booster.burning ? "#fb923c" : "#fde68a" }}>
              {tm.booster.landed ? "TOUCHDOWN" : tm.booster.burning ? "BURN" : "COAST"}
            </span>
          </div>
        )}

        <div style={{ marginTop: 14, padding: "10px 12px", border: "1px solid rgba(34,211,238,0.22)", background: "rgba(34,211,238,0.03)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, letterSpacing: "0.26em", color: CYAN_DIM, marginBottom: 8 }}>
            <label htmlFor="lr-speed">REPLAY SPEED</label>
            <span style={{ color: "#e6fdff" }}>{mode === "live" ? "1.00× LIVE" : `${(tm?.speed ?? 1).toFixed(2)}×`}</span>
          </div>
          <input
            id="lr-speed"
            className="lr-range"
            type="range"
            min={0}
            max={speeds.length - 1}
            step={1}
            value={speedIdx}
            disabled={mode === "live"}
            onChange={(e) => controls.current?.setSpeed(speeds[Number(e.target.value)] ?? 1)}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: CYAN_DIM, marginTop: 4 }}>
            <span>{speeds[0]}×</span>
            <span>1×</span>
            <span>{speeds[speeds.length - 1]}×</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 6, marginTop: 10 }}>
          <button
            type="button"
            className="lr-btn"
            data-active={tm?.director === "free"}
            onClick={() => controls.current?.setDirector(tm?.director === "free" ? "auto" : "free")}
          >
            {tm?.director === "free" ? "Auto director" : "Free cam 360°"}
          </button>
          <button type="button" className="lr-btn" aria-label={tm?.paused ? "Play" : "Pause"} disabled={mode === "live"} onClick={() => controls.current?.togglePause()} style={{ minWidth: 40 }}>
            {tm?.paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
          </button>
          <button type="button" className="lr-btn" data-danger="true" aria-label="Exit replay" onClick={onExit} style={{ minWidth: 40 }}>
            <X size={14} aria-hidden />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 6, marginTop: 6, alignItems: "center" }}>
          <button type="button" className="lr-btn" onClick={onPrev} disabled={count < 2}>
            <ChevronLeft size={13} aria-hidden /> Prev
          </button>
          <span style={{ fontSize: 11, color: "#e6fdff", letterSpacing: "0.14em", padding: "0 6px" }}>
            {index + 1} / {count}
          </span>
          <button type="button" className="lr-btn" onClick={onNext} disabled={count < 2}>
            Next <ChevronRight size={13} aria-hidden />
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" className="lr-btn" style={{ flex: 1 }} onClick={() => controls.current?.restart()}>
            <RotateCcw size={12} aria-hidden /> Restart
          </button>
          {canLive && (
            <button type="button" className="lr-btn" data-active={mode === "live"} style={{ flex: 1 }} onClick={() => controls.current?.setMode(mode === "live" ? "replay" : "live")}>
              {mode === "live" ? "Leave live" : <><Radio size={12} aria-hidden /> Go live</>}
            </button>
          )}
          {launch.webcast && (
            <a className="lr-btn" style={{ flex: 1, textAlign: "center", textDecoration: "none" }} href={launch.webcast} target="_blank" rel="noreferrer">
              Webcast <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 9, color: "rgba(125,249,255,0.45)", lineHeight: 1.5, letterSpacing: "0.06em" }}>
          Trajectory is an estimate reconstructed from pad, target orbit and recovery data (Launch Library 2). Not flight telemetry.
        </p>
      </Panel>

      {/* Event toast */}
      {tm?.toast && (
        <div key={tm.toastAt} style={{ position: "absolute", top: "22vh", left: 0, right: 0, textAlign: "center", animation: "lr-toast 3.2s ease forwards" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 18, fontSize: 22, color: "#ffffff", letterSpacing: "0.42em", textShadow: "0 0 24px rgba(34,211,238,0.9)" }}>
            <span style={{ width: 70, height: 1, background: "linear-gradient(90deg, transparent, #22d3ee)" }} />
            {tm.toast}
            <span style={{ width: 70, height: 1, background: "linear-gradient(90deg, #22d3ee, transparent)" }} />
          </div>
        </div>
      )}

      {/* Final countdown */}
      {tm && !tm.intro && t < 0 && t > -10.5 && (
        <div aria-live="polite" style={{ position: "absolute", bottom: "26vh", left: 0, right: 0, textAlign: "center", fontSize: 64, color: "#fde68a", letterSpacing: "0.2em", textShadow: "0 0 30px rgba(251,191,36,0.6)", fontVariantNumeric: "tabular-nums" }}>
          T−{Math.ceil(-t)}
        </div>
      )}

      {/* Intro */}
      {tm?.intro && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14 }}>
          <div style={{ width: 90, height: 90, borderRadius: "50%", border: "1px solid rgba(34,211,238,0.3)", borderTopColor: CYAN, animation: "lr-spin 1.1s linear infinite", boxShadow: "0 0 30px rgba(34,211,238,0.25)" }} />
          <div style={{ fontSize: 12, letterSpacing: "0.5em", color: "#a5f3fc" }}>ACQUIRING · {launch.pad.name.toUpperCase()}</div>
          <div style={{ fontSize: 10, letterSpacing: "0.3em", color: CYAN_DIM }}>
            {launch.pad.lat.toFixed(4)}°, {launch.pad.lon.toFixed(4)}° · {tm.tilesReady ? "PHOTOREAL TILES LOCKED" : "STREAMING TILES"}
          </div>
        </div>
      )}

      {/* Bottom: mission timeline */}
      <div style={{ position: "absolute", left: 64, right: "calc(min(320px, 34vw) + 44px)", bottom: 22, pointerEvents: "auto" }}>
        <div style={{ position: "relative", height: 10, marginBottom: 4 }}>
          {shotMarks.map((s) => (
            <span
              key={s.id + s.f}
              title={s.cam}
              style={{
                position: "absolute",
                left: `${s.f * 100}%`,
                width: `calc(${s.w * 100}% - 2px)`,
                height: 3,
                top: 4,
                background: tm && tm.variant === s.id ? CYAN : "rgba(34,211,238,0.22)",
                boxShadow: tm && tm.variant === s.id ? "0 0 8px #22d3ee" : "none",
              }}
            />
          ))}
        </div>
        <div
          role="slider"
          aria-label="Mission timeline"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            controls.current?.seekFraction((e.clientX - r.left) / r.width);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") controls.current?.seekFraction(progress + 0.03);
            if (e.key === "ArrowLeft") controls.current?.seekFraction(progress - 0.03);
          }}
          style={{ position: "relative", height: 26, cursor: "pointer" }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: 12, height: 2, background: "rgba(34,211,238,0.18)" }} />
          <div style={{ position: "absolute", left: 0, width: `${progress * 100}%`, top: 12, height: 2, background: `linear-gradient(90deg, rgba(34,211,238,0.3), ${CYAN})`, boxShadow: "0 0 10px #22d3ee" }} />
          <div style={{ position: "absolute", left: `${progress * 100}%`, top: 6, width: 2, height: 14, background: "#ffffff", boxShadow: "0 0 10px #ffffff" }} />
          {eventMarks.map((ev) => (
            <button
              key={ev.id}
              type="button"
              title={`${ev.label} · ${formatMissionClock(ev.t)}`}
              onClick={(e) => {
                e.stopPropagation();
                controls.current?.seekMission(ev.t - 3);
              }}
              style={{
                position: "absolute",
                left: `calc(${ev.f * 100}% - 4px)`,
                top: 9,
                width: 8,
                height: 8,
                transform: "rotate(45deg)",
                padding: 0,
                cursor: "pointer",
                border: `1px solid ${ev.booster ? AMBER : CYAN}`,
                background: t >= ev.t ? (ev.booster ? AMBER : CYAN) : "#02060c",
              }}
            />
          ))}
        </div>
        <div style={{ position: "relative", height: 14 }}>
          {eventLabels.map((ev) => (
              <span key={ev.id} style={{ position: "absolute", left: `${ev.f * 100}%`, transform: "translateX(-50%)", fontSize: 8.5, letterSpacing: "0.14em", whiteSpace: "nowrap", color: t >= ev.t ? (ev.booster ? "#fde68a" : "#a5f3fc") : "rgba(125,249,255,0.38)" }}>
                {ev.label.split(" · ")[0]}
              </span>
            ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 9, letterSpacing: "0.2em", color: "rgba(125,249,255,0.4)" }}>
          SPACE PAUSE · F FREE CAM · R RESTART · +/− SPEED · [ ] PREV / NEXT · ESC EXIT
        </div>
      </div>
    </div>
  );
}

function AltitudeBar({ altKm, maxKm }: { altKm: number; maxKm: number }) {
  const f = Math.min(1, Math.max(0, altKm) / maxKm);
  const karman = Math.min(1, 100 / maxKm);
  return (
    <div aria-hidden style={{ position: "relative", width: 10, height: 170, border: "1px solid rgba(34,211,238,0.3)", background: "rgba(34,211,238,0.04)" }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${f * 100}%`, background: "linear-gradient(0deg, rgba(34,211,238,0.15), #22d3ee)", boxShadow: "0 0 10px #22d3ee" }} />
      <div style={{ position: "absolute", left: -4, right: -4, bottom: `${karman * 100}%`, height: 1, background: "#fbbf24" }} />
      <span style={{ position: "absolute", left: 14, bottom: `calc(${karman * 100}% - 5px)`, fontSize: 7.5, color: "#fbbf24", letterSpacing: "0.1em", whiteSpace: "nowrap" }}>KÁRMÁN</span>
    </div>
  );
}
