import type { CSSProperties, ReactNode } from "react";
import { toDms, type InfraSite, type NearbySite } from "../lib/infra-site";

export type SiteCameraPreset = "orbit" | "low" | "top" | "wide";

export interface SiteTelemetry {
  headingDeg: number;
  pitchDeg: number;
  rangeM: number;
  groundM: number | null;
  /** Completed revolutions (1 = one full 360° sweep). */
  sweep: number;
  userControl: boolean;
}

interface Props {
  site: InfraSite;
  nearby: NearbySite[];
  telemetry: SiteTelemetry;
  tilesReady: boolean;
  locked: boolean;
  rotating: boolean;
  speed: number;
  lens: boolean;
  visible: boolean;
  onToggleRotate: () => void;
  onSpeed: (s: number) => void;
  onLens: (on: boolean) => void;
  onPreset: (p: SiteCameraPreset) => void;
  onZoom: (factor: number) => void;
  onSite: (site: InfraSite) => void;
  onExit: () => void;
}

const FONT = "'Share Tech Mono','Courier New',monospace";
const CYAN = "#00ffff";
const DIM = "rgba(125,249,255,0.5)";
const SPEEDS = [0.5, 1, 2, 4];
const PRESETS: { id: SiteCameraPreset; label: string; key: string }[] = [
  { id: "orbit", label: "ORBIT", key: "1" },
  { id: "low", label: "LOW", key: "2" },
  { id: "top", label: "TOP", key: "3" },
  { id: "wide", label: "WIDE", key: "4" },
];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const card: CSSProperties = {
  background: "rgba(2,4,8,0.86)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(0,255,255,0.18)",
  borderRadius: 2,
  boxShadow: "0 0 24px rgba(0,0,0,0.55)",
  pointerEvents: "auto",
};

function Row({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, padding: "2px 0" }}>
      <span style={{ color: DIM, letterSpacing: "0.12em", flexShrink: 0 }}>{label}</span>
      <span style={{ color: color ?? "#d8fbff", textAlign: "right", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function Btn({ children, active, onClick, label, accent = CYAN }: { children: ReactNode; active?: boolean; onClick: () => void; label?: string; accent?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      style={{
        fontFamily: FONT,
        fontSize: 10,
        letterSpacing: "0.14em",
        padding: "6px 9px",
        minWidth: 30,
        cursor: "pointer",
        color: active ? "#020408" : "#cffcff",
        background: active ? accent : "rgba(0,255,255,0.05)",
        border: `1px solid ${active ? accent : "rgba(0,255,255,0.25)"}`,
        borderRadius: 2,
      }}
    >
      {children}
    </button>
  );
}

const fmtRange = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const cardinal = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

/** Scrolling heading tape: ticks every 15°, cardinals labelled, centred on the camera heading. */
function HeadingTape({ heading }: { heading: number }) {
  const PX_PER_DEG = 3;
  const ticks: ReactNode[] = [];
  for (let d = Math.floor((heading - 70) / 15) * 15; d <= heading + 70; d += 15) {
    const norm = ((d % 360) + 360) % 360;
    const x = (d - heading) * PX_PER_DEG;
    const major = norm % 45 === 0;
    ticks.push(
      <div key={d} style={{ position: "absolute", left: `calc(50% + ${x}px)`, top: 0, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 1, height: major ? 9 : 5, background: major ? CYAN : DIM }} />
        {major && <span style={{ fontSize: 9, color: norm === 0 ? "#ff6b6b" : "#cffcff", marginTop: 1 }}>{COMPASS[norm / 45]}</span>}
      </div>,
    );
  }
  return (
    <div aria-hidden style={{ position: "relative", width: 420, maxWidth: "70vw", height: 24, overflow: "hidden", maskImage: "linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)", WebkitMaskImage: "linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)" }}>
      {ticks}
      <div style={{ position: "absolute", left: "50%", top: 0, width: 0, height: 0, transform: "translateX(-50%)", borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: `6px solid ${CYAN}` }} />
    </div>
  );
}

/** Ring that fills as the camera completes one 360° revolution. */
function SweepRing({ fraction, revolutions }: { fraction: number; revolutions: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden>
        <circle cx="19" cy="19" r={r} fill="none" stroke="rgba(0,255,255,0.15)" strokeWidth="3" />
        <circle cx="19" cy="19" r={r} fill="none" stroke={CYAN} strokeWidth="3" strokeDasharray={`${c * fraction} ${c}`} transform="rotate(-90 19 19)" strokeLinecap="round" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
        <span style={{ fontSize: 9, color: DIM, letterSpacing: "0.2em" }}>360° SWEEP</span>
        <span style={{ fontSize: 13, color: "#fff" }}>
          {Math.round(fraction * 100)}%{revolutions > 0 && <span style={{ color: DIM, fontSize: 10 }}>{` · ${revolutions} REV`}</span>}
        </span>
      </div>
    </div>
  );
}

export function InfraSiteHud(props: Props) {
  const { site, nearby, telemetry: t, tilesReady, locked, rotating, speed, lens, visible } = props;
  const revolutions = Math.floor(t.sweep);
  const fraction = t.sweep - revolutions;
  const status = !tilesReady ? { text: "STREAMING 3D TILES", color: "#ffd34d" }
    : !locked ? { text: "ACQUIRING SITE", color: "#ffd34d" }
      : t.userControl ? { text: "MANUAL · ORBIT RESUMES", color: "#ffd34d" }
        : rotating ? { text: "AUTO-ORBIT LOCKED", color: "#7dff9a" }
          : { text: "ORBIT HELD", color: "#cffcff" };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        pointerEvents: "none",
        fontFamily: FONT,
        color: "#d8fbff",
        opacity: visible ? 1 : 0,
        transition: "opacity 600ms ease",
      }}
    >
      {/* Site intel */}
      <section aria-label="Site intel" style={{ ...card, position: "absolute", top: 16, left: 60, width: 300, maxWidth: "calc(100vw - 76px)", padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: site.color, boxShadow: `0 0 8px ${site.color}` }} />
          <span style={{ fontSize: 9, letterSpacing: "0.22em", color: site.color }}>{`SITE 360° // ${site.kindLabel}`}</span>
        </div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 400, color: "#fff", lineHeight: 1.25, letterSpacing: "0.04em" }}>{site.name}</h2>
        {site.subtitle && <div style={{ fontSize: 11, color: DIM }}>{site.subtitle}</div>}
        <div style={{ borderTop: "1px solid rgba(0,255,255,0.14)", marginTop: 4, paddingTop: 6 }}>
          {site.rows.map(([k, v]) => <Row key={k} label={k} value={v} />)}
          <Row label="LAT" value={toDms(site.lat, "N", "S")} />
          <Row label="LON" value={toDms(site.lon, "E", "W")} />
          <Row label="GROUND" value={t.groundM === null ? "SAMPLING…" : `${Math.round(t.groundM)} m ELL`} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, letterSpacing: "0.16em", color: status.color, marginTop: 2 }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: status.color, boxShadow: `0 0 6px ${status.color}` }} />
          <span role="status">{status.text}</span>
        </div>
      </section>

      {/* Heading tape + sweep progress */}
      <div style={{ position: "absolute", top: 58, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <HeadingTape heading={t.headingDeg} />
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 16, padding: "6px 12px" }}>
          <SweepRing fraction={fraction} revolutions={revolutions} />
          <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
            <span><span style={{ color: DIM }}>HDG </span>{`${String(Math.round(t.headingDeg) % 360).padStart(3, "0")}° ${cardinal(t.headingDeg)}`}</span>
            <span><span style={{ color: DIM }}>TILT </span>{`${Math.round(-t.pitchDeg)}°`}</span>
            <span><span style={{ color: DIM }}>RNG </span>{fmtRange(t.rangeM)}</span>
          </div>
        </div>
      </div>

      {/* Nearby installations */}
      <section aria-label="Nearby installations" style={{ ...card, position: "absolute", top: 16, right: 16, width: 270, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 140px)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 9, letterSpacing: "0.22em", color: DIM }}>NEARBY · 30 KM</span>
          <span style={{ fontSize: 14, color: "#fff" }}>{nearby.length}</span>
        </div>
        {nearby.length === 0 ? (
          <span style={{ fontSize: 10, color: DIM }}>No other mapped installations in range.</span>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
            {nearby.map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  onClick={() => props.onSite(n)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", background: "rgba(0,255,255,0.03)", border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 10, color: "#e0fbff", textAlign: "left" }}
                >
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: n.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
                  <span style={{ color: DIM, flexShrink: 0 }}>{`${n.distKm < 10 ? n.distKm.toFixed(1) : Math.round(n.distKm)} km ${cardinal(n.bearingDeg)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Controls */}
      <div role="toolbar" aria-label="360 view controls" style={{ ...card, position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 6, padding: 8, maxWidth: "calc(100vw - 32px)" }}>
        <Btn onClick={props.onToggleRotate} active={rotating} label={rotating ? "Pause orbit" : "Resume orbit"}>
          {rotating ? "❚❚ ORBIT" : "▶ ORBIT"}
        </Btn>
        <span aria-hidden style={{ width: 1, height: 20, background: "rgba(0,255,255,0.2)" }} />
        {SPEEDS.map((s) => (
          <Btn key={s} onClick={() => props.onSpeed(s)} active={speed === s} label={`Orbit speed ${s}x`}>{`${s}×`}</Btn>
        ))}
        <span aria-hidden style={{ width: 1, height: 20, background: "rgba(0,255,255,0.2)" }} />
        {PRESETS.map((p) => (
          <Btn key={p.id} onClick={() => props.onPreset(p.id)} label={`${p.label} view (key ${p.key})`}>{p.label}</Btn>
        ))}
        <span aria-hidden style={{ width: 1, height: 20, background: "rgba(0,255,255,0.2)" }} />
        <Btn onClick={() => props.onZoom(0.75)} label="Zoom in">+</Btn>
        <Btn onClick={() => props.onZoom(1.33)} label="Zoom out">−</Btn>
        <Btn onClick={() => props.onLens(!lens)} active={lens} label="Toggle lens aperture">LENS</Btn>
        <span aria-hidden style={{ width: 1, height: 20, background: "rgba(0,255,255,0.2)" }} />
        <Btn onClick={props.onExit} label="Exit 360 view" accent="#ff6b6b">EXIT ⎋</Btn>
      </div>

      <div style={{ position: "absolute", bottom: 64, left: 60, fontSize: 9, letterSpacing: "0.14em", color: DIM, lineHeight: 1.7 }}>
        DRAG ORBIT · WHEEL ZOOM · SPACE PAUSE
        <br />
        1–4 VIEWS · CLICK A STEM TO HOP · ESC EXIT
      </div>
    </div>
  );
}
