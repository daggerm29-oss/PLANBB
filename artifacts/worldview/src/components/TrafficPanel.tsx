import type { TrafficStatus } from "../hooks/use-traffic-status";
import { ROAD_MODES, type RoadMode, type TrafficStats } from "../lib/traffic";

const MONO = "'Share Tech Mono','Courier New',monospace";
const CYAN_DIM = "rgba(0,255,255,0.6)";
const MUTED = "rgba(180,200,210,0.6)";

const ROAD_MODE_INFO: Record<RoadMode, { label: string; hint: string }> = {
  hybrid: { label: "HYBRID", hint: "TomTom roads + OSM fill where TomTom has no coverage" },
  tomtom: { label: "TOMTOM", hint: "Only TomTom-measured road segments" },
  osm: { label: "OSM", hint: "OpenStreetMap roads with TomTom flow matched onto them" },
};

const DENSITIES = [
  { value: 0.5, label: "0.5×" },
  { value: 1, label: "1×" },
  { value: 2, label: "2×" },
];

const LEGEND = [
  { color: "#34d399", label: "FREE" },
  { color: "#ffd60a", label: "SLOW" },
  { color: "#ff9500", label: "HEAVY" },
  { color: "#ff2d55", label: "JAM" },
  { color: "#9b1c31", label: "CLOSED" },
];

export interface TrafficCity {
  id: string;
  label: string;
  lat: number;
  lon: number;
  zoom: number;
  bearing?: number;
}

/** Busy street-level spots (z >= MIN_ZOOM) so vehicles appear immediately after the fly-to. */
export const TRAFFIC_CITIES: TrafficCity[] = [
  { id: "blr-silk", label: "BENGALURU · SILK BOARD", lat: 12.9172, lon: 77.6229, zoom: 16.2, bearing: 20 },
  { id: "blr-mg", label: "BENGALURU · MG ROAD", lat: 12.9756, lon: 77.6066, zoom: 16.2, bearing: -30 },
  { id: "blr-orr", label: "BENGALURU · ORR MARATHAHALLI", lat: 12.9569, lon: 77.7011, zoom: 15.8 },
  { id: "mum", label: "MUMBAI · BKC", lat: 19.0656, lon: 72.8653, zoom: 15.8 },
  { id: "del", label: "DELHI · ITO", lat: 28.6289, lon: 77.2411, zoom: 15.8 },
  { id: "nyc", label: "NEW YORK · MIDTOWN", lat: 40.7549, lon: -73.984, zoom: 16, bearing: 29 },
  { id: "lon", label: "LONDON · CITY", lat: 51.5136, lon: -0.0889, zoom: 16 },
  { id: "aus", label: "AUSTIN · IH-35 / 6TH", lat: 30.2676, lon: -97.7356, zoom: 16.4, bearing: 15 },
];

interface Props {
  onJump: (city: TrafficCity) => void;
  status: TrafficStatus | null;
  stats: TrafficStats | null;
  roadMode: RoadMode;
  onRoadMode: (mode: RoadMode) => void;
  showFlow: boolean;
  onShowFlow: (on: boolean) => void;
  showLabels: boolean;
  onShowLabels: (on: boolean) => void;
  density: number;
  onDensity: (d: number) => void;
}

function Segmented<T extends string | number>({
  options, value, onChange, disabled,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: (v: T) => boolean;
}) {
  return (
    <div role="radiogroup" style={{ display: "flex", gap: 4 }}>
      {options.map((o) => {
        const active = o.value === value;
        const off = disabled?.(o.value) ?? false;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={off}
            title={o.title}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              padding: "5px 0",
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: 1,
              cursor: off ? "not-allowed" : "pointer",
              opacity: off ? 0.35 : 1,
              color: active ? "#020408" : "#bff",
              background: active ? "#00ffff" : "rgba(0,255,255,0.06)",
              border: `1px solid ${active ? "#00ffff" : "rgba(0,255,255,0.25)"}`,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 8 }}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "#00ffff", width: 14, height: 14, cursor: "pointer" }}
      />
    </label>
  );
}

function Row({ k, v, color = "#fff" }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ color: MUTED }}>{k}</span>
      <span style={{ color, textAlign: "right" }}>{v}</span>
    </div>
  );
}

function ago(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

export function TrafficPanel({
  status, stats, roadMode, onRoadMode, showFlow, onShowFlow, showLabels, onShowLabels, density, onDensity, onJump,
}: Props) {
  const live = status?.mode === "live";
  const sourceLine = !status
    ? "Checking traffic source…"
    : live
      ? `${status.provider} · refresh ${status.ttlSec}s`
      : status.hasKey
        ? `TomTom upstream error ${status.upstreamError ?? ""} · simulating`
        : "No TomTom key on server · simulated flow on OSM roads";

  return (
    <div style={{ fontFamily: MONO, color: "#bff", fontSize: 11, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: live ? "#34d399" : "#e8b04a",
            boxShadow: `0 0 8px ${live ? "#34d399" : "#e8b04a"}`,
          }}
        />
        <span style={{ color: live ? "#34d399" : "#e8b04a", letterSpacing: 2 }}>{live ? "LIVE FLOW" : "SIMULATION"}</span>
        <span style={{ marginLeft: "auto", color: "#fff", fontSize: 16 }}>{stats?.vehicles.toLocaleString() ?? "—"}</span>
      </div>
      <div style={{ fontSize: 9, color: MUTED, marginTop: -6, lineHeight: 1.5 }}>
        {sourceLine}
        <span style={{ float: "right" }}>VEHICLES</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="traffic-city" style={{ color: CYAN_DIM, letterSpacing: 1 }}>JUMP TO HOTSPOT</label>
        <select
          id="traffic-city"
          value=""
          onChange={(e) => {
            const city = TRAFFIC_CITIES.find((c) => c.id === e.target.value);
            if (city) onJump(city);
          }}
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: 1,
            padding: "5px 6px",
            color: "#bff",
            background: "rgba(2,4,8,0.9)",
            border: "1px solid rgba(0,255,255,0.25)",
            cursor: "pointer",
          }}
        >
          <option value="" disabled>
            SELECT CITY…
          </option>
          {TRAFFIC_CITIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: CYAN_DIM, letterSpacing: 1 }}>ROAD SOURCE</span>
        <Segmented
          options={ROAD_MODES.map((m) => ({ value: m, label: ROAD_MODE_INFO[m].label, title: ROAD_MODE_INFO[m].hint }))}
          value={live ? roadMode : "osm"}
          onChange={onRoadMode}
          disabled={(m) => !live && m !== "osm"}
        />
        <span style={{ fontSize: 9, color: MUTED }}>{ROAD_MODE_INFO[live ? roadMode : "osm"].hint}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: CYAN_DIM, letterSpacing: 1 }}>VEHICLE DENSITY</span>
        <Segmented options={DENSITIES} value={density} onChange={onDensity} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Toggle label="CONGESTION LINES" checked={showFlow} onChange={onShowFlow} />
        <Toggle label="VEHICLE LABELS (z16.5+)" checked={showLabels} onChange={onShowLabels} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingTop: 8, borderTop: "1px solid rgba(0,255,255,0.15)" }}>
        {stats?.status === "zoom-in" ? (
          <div style={{ fontSize: 9, color: "#e8b04a" }}>Zoom to street level (z13.5+) to see vehicles</div>
        ) : stats?.status === "loading" ? (
          <div style={{ fontSize: 9, color: MUTED }}>Loading road network…</div>
        ) : stats ? (
          <>
            <Row k="ROAD LANES" v={stats.lanes.toLocaleString()} />
            {live && <Row k="LIVE / MATCHED / SIM" v={`${stats.liveLanes} / ${stats.matchedLanes} / ${stats.simLanes}`} />}
            <Row k="MEAN SPEED" v={`${Math.round(stats.meanKmh)} km/h`} />
            <Row
              k="FLOW VS FREE-FLOW"
              v={`${Math.round(stats.meanLevel * 100)}%`}
              color={stats.meanLevel < 0.5 ? "#ff2d55" : stats.meanLevel < 0.75 ? "#ffd60a" : "#34d399"}
            />
            <Row k="CONGESTED ROAD" v={`${Math.round(stats.jammedFrac * 100)}%`} color={stats.jammedFrac > 0.25 ? "#ff9500" : "#fff"} />
            <Row k="CLOSURES" v={String(stats.closures)} color={stats.closures ? "#ff2d55" : "#fff"} />
            <Row k="UPDATED" v={ago(stats.updatedAt)} />
          </>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 9 }}>
        {LEGEND.map((l) => (
          <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: MUTED }}>
            <span aria-hidden style={{ width: 12, height: 3, background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
