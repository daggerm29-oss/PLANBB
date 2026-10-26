import { Pause, Play, Plane, ScanEye, X } from "lucide-react";
import type { Route3D } from "../lib/route-3d";

export type RoutePhase = "loading" | "overview" | "intro" | "flying" | "paused" | "arrived";

export interface RouteTelemetry {
  phase: RoutePhase;
  progress: number;
  aglM: number | null;
  headingDeg: number;
  tilesReady: boolean;
}

const ACCENT = "#7df9ff";
const FONT = "'Share Tech Mono','Courier New',monospace";

const PHASE_LABEL: Record<RoutePhase, string> = {
  loading: "ACQUIRING",
  overview: "OVERVIEW",
  intro: "TAKE-OFF",
  flying: "DRONE FLIGHT",
  paused: "HOLD",
  arrived: "ON STATION",
};

interface Props {
  route: Route3D;
  telemetry: RouteTelemetry;
  visible: boolean;
  onFly: () => void;
  onPause: () => void;
  onOverview: () => void;
  onExit: () => void;
}

function Btn({ onClick, label, children, primary }: { onClick: () => void; label: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        fontFamily: FONT,
        fontSize: 11,
        letterSpacing: 1,
        color: primary ? "#02060c" : ACCENT,
        background: primary ? ACCENT : "rgba(125,249,255,0.08)",
        border: `1px solid ${primary ? ACCENT : "rgba(125,249,255,0.35)"}`,
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function Route3DHud({ route, telemetry, visible, onFly, onPause, onOverview, onExit }: Props) {
  const { phase, progress, aglM, headingDeg, tilesReady } = telemetry;
  const flying = phase === "flying" || phase === "paused" || phase === "intro";
  const km = route.distanceKm;
  const dist = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

  return (
    <section
      aria-label="3D route view"
      style={{
        position: "fixed",
        top: "max(calc(9vh + 14px), 184px)",
        right: 16,
        zIndex: 60,
        width: 300,
        maxWidth: "calc(100vw - 32px)",
        padding: 14,
        fontFamily: FONT,
        color: "#e6f6ff",
        background: "rgba(2,6,12,0.82)",
        border: "1px solid rgba(125,249,255,0.3)",
        borderRadius: 6,
        backdropFilter: "blur(6px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 600ms ease",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ color: ACCENT, fontSize: 11, letterSpacing: 2 }}>ROUTE · PHOTOREALISTIC 3D</span>
        <button
          type="button"
          onClick={onExit}
          aria-label="Exit 3D route view"
          style={{ background: "transparent", border: "none", color: ACCENT, cursor: "pointer", padding: 2 }}
        >
          <X size={16} />
        </button>
      </header>

      <h2 style={{ margin: 0, fontSize: 14, lineHeight: 1.35, fontWeight: 600, textWrap: "balance" }}>{route.label}</h2>
      <p style={{ margin: "6px 0 10px", fontSize: 11, color: "rgba(230,246,255,0.7)" }}>
        {dist}
        {route.durationMin !== null ? ` · ${route.durationMin} min` : ""} · {route.mode.toUpperCase()}
      </p>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>
        <span style={{ color: phase === "flying" ? "#39ff88" : ACCENT }}>
          {tilesReady ? PHASE_LABEL[phase] : "LOADING 3D TILES"}
        </span>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Route flight progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        style={{ height: 3, background: "rgba(125,249,255,0.15)", borderRadius: 2, overflow: "hidden" }}
      >
        <div style={{ width: `${progress * 100}%`, height: "100%", background: route.color, transition: "width 200ms linear" }} />
      </div>

      <dl style={{ display: "flex", gap: 16, margin: "10px 0 12px", fontSize: 10 }}>
        <div>
          <dt style={{ color: "rgba(230,246,255,0.55)" }}>HDG</dt>
          <dd style={{ margin: 0 }}>{String(Math.round(headingDeg)).padStart(3, "0")}°</dd>
        </div>
        <div>
          <dt style={{ color: "rgba(230,246,255,0.55)" }}>AGL</dt>
          <dd style={{ margin: 0 }}>{aglM !== null ? `${Math.round(aglM)} m` : "—"}</dd>
        </div>
      </dl>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {flying ? (
          <Btn onClick={onPause} label={phase === "paused" ? "Resume flight" : "Pause flight"} primary>
            {phase === "paused" ? <Play size={12} /> : <Pause size={12} />}
            {phase === "paused" ? "RESUME" : "PAUSE"}
          </Btn>
        ) : (
          <Btn onClick={onFly} label="Fly the route" primary>
            <Plane size={12} />
            {phase === "arrived" ? "REPLAY" : "FLY ROUTE"}
          </Btn>
        )}
        <Btn onClick={onOverview} label="Show route overview">
          <ScanEye size={12} />
          OVERVIEW
        </Btn>
      </div>
    </section>
  );
}
