import { useEffect, useState, type ReactNode } from "react";
import type maplibregl from "maplibre-gl";
import { Crosshair, RefreshCw } from "lucide-react";
import { FloatingPanel } from "./FloatingPanel";
import { SignalsLayer } from "./SignalsLayer";
import { AtcConsole } from "./AtcConsole";
import {
  DEFAULT_SIGNAL_LAYERS,
  formatAlt,
  SQUAWK_COLOR,
  useGpsJam,
  useLightning,
  useRadar,
  type AtcTranscript,
  type SignalLayers,
  type SquawkAlert,
} from "../lib/signals";

const FONT = "'Share Tech Mono','Courier New',monospace";
const ACCENT = "#a3e635";
const DIM = "rgba(217,249,157,0.55)";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  onClose: () => void;
  alerts: SquawkAlert[];
  alertsUpdatedAt: number | null;
  onSelectAlert: (a: SquawkAlert) => void;
  focusIcao: string | null;
  onAtcFlagged: (t: AtcTranscript) => void;
}

/** Signals & RF workspace: emergency squawks, GNSS jamming, radar, lightning and live ATC. */
export function SignalsWorkspace({ map, mapLoaded, onClose, alerts, alertsUpdatedAt, onSelectAlert, focusIcao, onAtcFlagged }: Props) {
  const [layers, setLayers] = useState<SignalLayers>(DEFAULT_SIGNAL_LAYERS);
  const [jamDate, setJamDate] = useState<string | null>(null);
  const [radarLoop, setRadarLoop] = useState(false);
  const [radarOpacity, setRadarOpacity] = useState(0.6);
  const [radarIdx, setRadarIdx] = useState<number | null>(null);

  const jam = useGpsJam(layers.jam, jamDate);
  const radar = useRadar(layers.radar);
  const lightning = useLightning(layers.lightning);

  const frames = radar.data?.frames ?? [];
  const frameIdx = radarIdx == null || radarIdx >= frames.length ? frames.length - 1 : radarIdx;
  const frame = frames[frameIdx] ?? null;

  useEffect(() => {
    if (!radarLoop || frames.length < 2) return;
    const id = setInterval(() => setRadarIdx((i) => ((i ?? frames.length - 1) + 1) % frames.length), 700);
    return () => clearInterval(id);
  }, [radarLoop, frames.length]);

  const toggle = (k: keyof SignalLayers) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const strikes = lightning.data?.strikes ?? [];
  const recentStrikes = strikes.filter((s) => Date.now() - s.t < 60_000).length;

  return (
    <>
      <FloatingPanel title="SIGNALS / RF" initialX={54} initialY={14} width={340} accentColor={ACCENT} onClose={onClose}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "10px 12px 14px", fontFamily: FONT, color: "#ecfccb", overflowY: "auto", minHeight: 0 }}>
          <Section title="EMERGENCY SQUAWKS" right={alertsUpdatedAt ? `${alerts.length} ACTIVE` : "SCANNING"}>
            {alerts.length === 0 ? (
              <p style={{ margin: 0, fontSize: 9.5, color: DIM }}>No aircraft squawking 7500 / 7600 / 7700 worldwide. Alerts appear here and on the map instantly.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {alerts.map((a) => (
                  <li key={a.hex}>
                    <button
                      type="button"
                      onClick={() => onSelectAlert(a)}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer", textAlign: "left", fontFamily: FONT, color: "#ecfccb", background: "rgba(239,68,68,0.07)", border: `1px solid ${SQUAWK_COLOR[a.squawk]}55` }}
                    >
                      <span style={{ fontSize: 13, color: "#05090a", background: SQUAWK_COLOR[a.squawk], padding: "2px 5px", letterSpacing: "0.06em" }}>{a.squawk}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 11, letterSpacing: "0.1em" }}>{a.flight || a.reg || a.hex.toUpperCase()} <span style={{ color: DIM }}>{a.type}</span></span>
                        <span style={{ display: "block", fontSize: 9, color: SQUAWK_COLOR[a.squawk], letterSpacing: "0.12em" }}>{a.meaning} · {formatAlt(a.alt)}{a.gs ? ` · ${Math.round(a.gs)} KT` : ""}</span>
                      </span>
                      <Crosshair size={13} color={DIM} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="RF / WEATHER LAYERS">
            <LayerRow
              label="GPS JAMMING"
              on={layers.jam}
              onToggle={() => toggle("jam")}
              status={jam.status === "loading" && !jam.data ? "LOADING" : jam.error && !jam.data ? "OFFLINE" : jam.data ? `${jam.data.high} HIGH · ${jam.data.medium} MED` : ""}
            >
              {layers.jam && jam.data && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <label htmlFor="jam-date" className="sr-only">GPS jamming day</label>
                  <select
                    id="jam-date"
                    value={jam.data.date}
                    onChange={(e) => setJamDate(e.target.value)}
                    style={{ fontFamily: FONT, fontSize: 9.5, background: "#05090a", color: "#ecfccb", border: `1px solid ${ACCENT}33`, padding: "3px 2px" }}
                  >
                    {[...jam.data.dates].reverse().map((d) => <option key={d} value={d}>{d} UTC</option>)}
                  </select>
                  <Legend color="#facc15" label="2–10%" />
                  <Legend color="#ef4444" label=">10%" />
                  <span style={{ fontSize: 8.5, color: DIM }}>gpsjam.org · 24h aggregate</span>
                </div>
              )}
              {layers.jam && jam.error && !jam.data && <p style={{ margin: 0, fontSize: 9, color: "#fca5a5" }}>{jam.error}</p>}
            </LayerRow>

            <LayerRow
              label="WEATHER RADAR"
              on={layers.radar}
              onToggle={() => toggle("radar")}
              status={radar.status === "loading" && !radar.data ? "LOADING" : frame ? `${new Date(frame.time).toISOString().slice(11, 16)}Z` : radar.error ? "OFFLINE" : ""}
            >
              {layers.radar && frames.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button type="button" onClick={() => setRadarLoop((v) => !v)} aria-pressed={radarLoop} style={chip(radarLoop)}>{radarLoop ? "PAUSE" : "LOOP 2H"}</button>
                    <label htmlFor="radar-frame" className="sr-only">Radar frame</label>
                    <input
                      id="radar-frame"
                      type="range"
                      min={0}
                      max={frames.length - 1}
                      value={frameIdx}
                      onChange={(e) => { setRadarLoop(false); setRadarIdx(Number(e.target.value)); }}
                      style={{ flex: 1, accentColor: ACCENT }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label htmlFor="radar-opacity" style={{ fontSize: 8.5, color: DIM, letterSpacing: "0.14em" }}>OPACITY</label>
                    <input id="radar-opacity" type="range" min={0.15} max={1} step={0.05} value={radarOpacity} onChange={(e) => setRadarOpacity(Number(e.target.value))} style={{ flex: 1, accentColor: ACCENT }} />
                    <span style={{ fontSize: 8.5, color: DIM }}>RainViewer</span>
                  </div>
                </div>
              )}
            </LayerRow>

            <LayerRow
              label="LIGHTNING"
              on={layers.lightning}
              onToggle={() => toggle("lightning")}
              status={lightning.status === "loading" && !lightning.data ? "CONNECTING" : lightning.data ? `${strikes.length} / 15M` : lightning.error ? "OFFLINE" : ""}
            >
              {layers.lightning && lightning.data && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9.5, color: recentStrikes ? "#fde047" : DIM }}>{recentStrikes} strikes in the last minute</span>
                  <Legend color="#ffffff" label="now" />
                  <Legend color="#fb923c" label="5m" />
                  <Legend color="#dc2626" label="15m" />
                  <span style={{ fontSize: 8.5, color: DIM }}>Blitzortung.org</span>
                </div>
              )}
            </LayerRow>
          </Section>

          <Section title="LIVE ATC · LIVEATC.NET">
            <AtcConsole map={map} focusIcao={focusIcao} onFlagged={onAtcFlagged} />
          </Section>
        </div>
      </FloatingPanel>

      <SignalsLayer
        map={map}
        mapLoaded={mapLoaded}
        layers={layers}
        jam={jam.data}
        radarFrame={frame}
        radarOpacity={radarOpacity}
        strikes={strikes}
      />
    </>
  );
}

function Section({ title, right, children }: { title: string; right?: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9.5, fontWeight: 400, letterSpacing: "0.24em", color: ACCENT, borderBottom: `1px solid ${ACCENT}22`, paddingBottom: 4 }}>
        <span>{title}</span>
        {right && <span style={{ color: DIM, letterSpacing: "0.14em" }}>{right}</span>}
      </h3>
      {children}
    </section>
  );
}

function LayerRow({ label, on, onToggle, status, children }: { label: string; on: boolean; onToggle: () => void; status: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "7px 8px", border: `1px solid ${on ? `${ACCENT}44` : "rgba(255,255,255,0.06)"}`, background: on ? "rgba(163,230,53,0.04)" : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${label} layer`}
          onClick={onToggle}
          style={{ position: "relative", width: 28, height: 14, borderRadius: 99, border: `1px solid ${on ? ACCENT : "rgba(255,255,255,0.25)"}`, background: on ? `${ACCENT}33` : "transparent", cursor: "pointer", padding: 0 }}
        >
          <span aria-hidden style={{ position: "absolute", top: 2, left: on ? 15 : 2, width: 8, height: 8, borderRadius: 99, background: on ? ACCENT : "rgba(255,255,255,0.4)", transition: "left 120ms" }} />
        </button>
        <span style={{ flex: 1, fontSize: 10.5, letterSpacing: "0.16em", color: on ? "#ecfccb" : DIM }}>{label}</span>
        {on && status && (
          <span style={{ fontSize: 9, letterSpacing: "0.1em", color: status === "OFFLINE" ? "#fca5a5" : DIM, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {(status === "LOADING" || status === "CONNECTING") && <RefreshCw size={10} className="animate-spin" aria-hidden />}
            {status}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 8.5, color: DIM }}>
      <span aria-hidden style={{ width: 8, height: 8, background: color, opacity: 0.85 }} />
      {label}
    </span>
  );
}

function chip(active: boolean) {
  return {
    fontFamily: FONT, fontSize: 9, letterSpacing: "0.14em", padding: "3px 8px", cursor: "pointer",
    color: active ? "#05090a" : ACCENT, background: active ? ACCENT : "transparent", border: `1px solid ${ACCENT}66`,
  } as const;
}
