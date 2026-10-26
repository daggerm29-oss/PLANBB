import { useMemo, useState } from "react";
import { CCTV_SOURCE_COLORS, type CctvCamera, type CctvSourceId, type CctvSourceInfo } from "../lib/cctv";
import type { OsmStatus } from "../hooks/use-cctv";
import type { CoverageMode } from "../lib/viewshed";
import type { ViewshedStats } from "./CctvViewshedLayer";

const MONO = "'Share Tech Mono','Courier New',monospace";

interface Props {
  sources: CctvSourceInfo[];
  cameras: CctvCamera[];
  loading: boolean;
  error: string | null;
  enabledSources: CctvSourceId[];
  onToggleSource: (id: CctvSourceId) => void;
  osmStatus: OsmStatus;
  osmCount: number;
  onSelect: (camera: CctvCamera) => void;
  coverage: CoverageMode;
  onCoverage: (mode: CoverageMode) => void;
  viewshedStats: ViewshedStats | null;
}

const COVERAGE_MODES: { id: CoverageMode; label: string; hint: string }[] = [
  { id: "off", label: "OFF", hint: "Camera dots only" },
  { id: "cone", label: "CONE", hint: "Nominal field of view (no occlusion)" },
  { id: "viewshed", label: "VIEWSHED", hint: "Line-of-sight clipped by buildings, blind zones in red" },
];

const HEADING_SOURCE_LABEL = { feed: "FEED DIRECTION", osm: "OSM camera:direction", none: "UNKNOWN · 360° LOS" } as const;

function ViewshedSummary({ stats, coverage }: { stats: ViewshedStats | null; coverage: CoverageMode }) {
  if (coverage === "off" || !stats) return null;
  if (stats.status === "zoom-in") {
    return (
      <div style={{ fontSize: 9, color: "#e8b04a" }}>
        Zoom to street level (z{coverage === "viewshed" ? 13 : 12}+) to draw coverage
      </div>
    );
  }
  if (stats.status !== "ready") return null;
  const row = (k: string, v: string, color = "#fff") => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ color: "rgba(180,200,210,0.6)" }}>{k}</span>
      <span style={{ color, textAlign: "right" }}>{v}</span>
    </div>
  );
  const sel = stats.selected;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10 }}>
      {row("CAMERAS DRAWN", stats.cameras.toLocaleString())}
      {row("AIMED / 360° LOS", `${stats.aimed} / ${stats.cameras - stats.aimed}`)}
      {coverage === "viewshed" && row("OCCLUDERS", `${stats.occluders.toLocaleString()} bldg`)}
      {coverage === "viewshed" &&
        row("MEAN VISIBLE", `${Math.round(stats.meanVisible * 100)}%`, stats.meanVisible < 0.6 ? "#ff2d55" : "#34d399")}
      {sel && (
        <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid rgba(0,255,255,0.15)", display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ color: "rgba(0,255,255,0.6)", letterSpacing: 1, fontSize: 9 }}>SELECTED · EST. POSE</span>
          {row("PROFILE", sel.pose.profile)}
          {row("HEADING", sel.pose.headingDeg === null ? "—" : `${Math.round(sel.pose.headingDeg).toString().padStart(3, "0")}°`)}
          {row("HDG SOURCE", HEADING_SOURCE_LABEL[sel.pose.headingSource], sel.pose.headingSource === "none" ? "#e8b04a" : "#fff")}
          {row("FOV / RANGE", `${Math.round(sel.pose.fovDeg)}° / ${Math.round(sel.pose.rangeM)} m`)}
          {row("MOUNT", `${sel.pose.mountM} m`)}
          {coverage === "viewshed" &&
            row("VISIBLE", `${Math.round(sel.visibleFrac * 100)}% · blind ${Math.round((1 - sel.visibleFrac) * 100)}%`,
              sel.visibleFrac < 0.6 ? "#ff2d55" : "#34d399")}
        </div>
      )}
    </div>
  );
}

const OSM_HINT: Record<OsmStatus, string> = {
  off: "Disabled",
  "zoom-in": "Zoom in to street level (z12+) to scan",
  loading: "Scanning viewport…",
  ready: "Viewport scanned",
  error: "Overpass busy — retrying on next move",
};

export function CctvPanel({
  sources, cameras, loading, error, enabledSources, onToggleSource, osmStatus, osmCount, onSelect,
  coverage, onCoverage, viewshedStats,
}: Props) {
  const [query, setQuery] = useState("");
  const enabled = useMemo(() => new Set(enabledSources), [enabledSources]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: CctvCamera[] = [];
    for (const c of cameras) {
      if (!enabled.has(c.source)) continue;
      if (`${c.name} ${c.area ?? ""}`.toLowerCase().includes(q)) {
        out.push(c);
        if (out.length >= 40) break;
      }
    }
    return out;
  }, [query, cameras, enabled]);

  const total = useMemo(
    () => sources.reduce((sum, s) => sum + (enabled.has(s.id) ? s.count ?? 0 : 0), 0),
    [sources, enabled],
  );

  return (
    <div style={{ fontFamily: MONO, color: "#bff", fontSize: 11, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ color: "rgba(0,255,255,0.6)", letterSpacing: 1 }}>LIVE FEEDS ON MAP</span>
        <span style={{ color: "#fff", fontSize: 16 }}>{loading && cameras.length === 0 ? "…" : total.toLocaleString()}</span>
      </div>

      {error && <div style={{ color: "#ff9500" }}>Feed error: {error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ color: "rgba(0,255,255,0.6)", letterSpacing: 1 }}>COVERAGE</span>
          <span style={{ fontSize: 9, color: "rgba(180,200,210,0.5)" }}>press V to cycle</span>
        </div>
        <div role="radiogroup" aria-label="Camera coverage mode" style={{ display: "flex" }}>
          {COVERAGE_MODES.map((m) => {
            const on = coverage === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                title={m.hint}
                onClick={() => onCoverage(m.id)}
                style={{
                  flex: 1, padding: "6px 0", fontFamily: MONO, fontSize: 10, letterSpacing: 1, cursor: "pointer",
                  color: on ? (m.id === "viewshed" ? "#34d399" : "#fff") : "rgba(180,200,210,0.55)",
                  background: on ? "rgba(52,211,153,0.1)" : "transparent",
                  border: `1px solid ${on ? "rgba(52,211,153,0.6)" : "rgba(255,255,255,0.08)"}`,
                  marginLeft: -1,
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <ViewshedSummary stats={viewshedStats} coverage={coverage} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sources.map((s) => {
          const on = enabled.has(s.id);
          const color = CCTV_SOURCE_COLORS[s.id];
          const disabled = !s.enabled;
          return (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              onClick={() => onToggleSource(s.id)}
              aria-pressed={on}
              title={disabled ? `Set ${s.requiresKey} on the api-server to enable` : s.attribution}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", textAlign: "left",
                cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, fontFamily: MONO,
                color: on ? "#fff" : "rgba(180,200,210,0.55)",
                background: on ? "rgba(0,255,255,0.06)" : "transparent",
                border: `1px solid ${on ? color + "88" : "rgba(255,255,255,0.08)"}`,
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: on ? color : "transparent", border: `1px solid ${color}`, flex: "none" }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block" }}>{s.label}</span>
                <span style={{ display: "block", fontSize: 9, color: "rgba(180,200,210,0.55)" }}>
                  {s.id === "osm"
                    ? OSM_HINT[on ? osmStatus : "off"]
                    : disabled
                      ? `needs ${s.requiresKey}`
                      : s.error
                        ? `error: ${s.error.slice(0, 40)}`
                        : s.region}
                </span>
              </span>
              <span style={{ color: s.error ? "#ff9500" : "rgba(0,255,255,0.8)" }}>
                {s.id === "osm" ? (on ? osmCount.toLocaleString() : "") : s.count?.toLocaleString() ?? ""}
              </span>
            </button>
          );
        })}
      </div>

      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cameras (e.g. Broadway, I-5, Orchard)…"
          aria-label="Search cameras"
          style={{
            width: "100%", boxSizing: "border-box", padding: "6px 8px", fontFamily: MONO, fontSize: 11,
            color: "#fff", background: "rgba(0,0,0,0.5)", border: "1px solid rgba(0,255,255,0.25)", outline: "none",
          }}
        />
        {matches.length > 0 && (
          <div style={{ maxHeight: 170, overflowY: "auto", marginTop: 4, border: "1px solid rgba(255,255,255,0.08)" }}>
            {matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c)}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "5px 8px", cursor: "pointer",
                  fontFamily: MONO, fontSize: 10, color: "#bff", background: "transparent", border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <span style={{ color: CCTV_SOURCE_COLORS[c.source] }}>● </span>
                {c.name}
                {c.area ? <span style={{ color: "rgba(180,200,210,0.5)" }}> · {c.area}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontSize: 9, lineHeight: 1.5, color: "rgba(180,200,210,0.5)" }}>
        Public DOT / city open-data feeds only. Click any dot to watch. Orange OSM dots are camera
        locations (no video). Coverage is an estimate: pose from the feed&apos;s direction text and
        camera class, occlusion from OSM building heights. Data: NYC DOT, TfL, Caltrans, LTA/data.gov.sg, City of Austin, © OpenStreetMap contributors.
      </div>
    </div>
  );
}
