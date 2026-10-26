import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiBase } from "../lib/cctv";
import type { InfraOsmStatus } from "../hooks/use-infrastructure";
import {
  INFRA_COLORS, INFRA_LAYER_INFO, formatMw,
  type CableDetail, type CableRoute, type Dam, type DataCenter, type InfraLayerId, type InfraSelection,
  type InfraSummary, type LandingDetail, type LandingPoint,
} from "../lib/infrastructure";

const MONO = "'Share Tech Mono','Courier New',monospace";
const CYAN_DIM = "rgba(0,255,255,0.6)";
const MUTED = "rgba(180,200,210,0.6)";
const BORDER = "1px solid rgba(0,255,255,0.18)";

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface Props {
  summary: InfraSummary | null;
  status: Record<"cables" | "datacenters" | "dams", LoadStatus>;
  osmStatus: InfraOsmStatus;
  enabled: Record<InfraLayerId, boolean>;
  onToggle: (id: InfraLayerId, on: boolean) => void;
  showLabels: boolean;
  onShowLabels: (on: boolean) => void;
  cableColorMode: "uniform" | "operator";
  onCableColorMode: (m: "uniform" | "operator") => void;
  cables: CableRoute[];
  landings: LandingPoint[];
  datacenters: DataCenter[];
  dams: Dam[];
  selection: InfraSelection | null;
  onSelect: (sel: InfraSelection | null) => void;
  onFly: (lon: number, lat: number, zoom: number) => void;
  onView360: (sel: InfraSelection) => void;
}

interface Hotspot { id: string; label: string; lon: number; lat: number; zoom: number }
const HOTSPOTS: Hotspot[] = [
  { id: "bahamas", label: "BAHAMAS · CABLE CORRIDOR", lon: -77.2, lat: 24.6, zoom: 6.4 },
  { id: "marseille", label: "MARSEILLE · LANDING HUB", lon: 5.37, lat: 43.3, zoom: 8 },
  { id: "suez", label: "RED SEA · SUEZ CHOKEPOINT", lon: 35.5, lat: 24.5, zoom: 4.6 },
  { id: "singapore", label: "SINGAPORE · STRAIT", lon: 103.9, lat: 1.3, zoom: 8.5 },
  { id: "ashburn", label: "ASHBURN · DATA CENTER ALLEY", lon: -77.49, lat: 39.02, zoom: 10.5 },
  { id: "frankfurt", label: "FRANKFURT · DE-CIX", lon: 8.68, lat: 50.11, zoom: 10 },
  { id: "three-gorges", label: "THREE GORGES DAM", lon: 111.003, lat: 30.823, zoom: 12.5 },
  { id: "yangtze", label: "CHINA · HYDRO BASINS", lon: 104, lat: 30, zoom: 4.6 },
  { id: "itaipu", label: "ITAIPU DAM", lon: -54.589, lat: -25.408, zoom: 12 },
];

function Toggle({ label, hint, color, checked, count, status, onChange }: {
  label: string; hint?: string; color?: string; checked: boolean; count?: string; status?: LoadStatus; onChange: (on: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
      {color && (
        <span aria-hidden style={{ width: 8, height: 8, marginTop: 3, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
      )}
      <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
          <span style={{ letterSpacing: 1 }}>{label}</span>
          <span style={{ color: status === "error" ? "#ff6b6b" : MUTED }}>
            {status === "loading" ? "LOADING…" : status === "error" ? "ERROR" : count ?? ""}
          </span>
        </span>
        {hint && <span style={{ fontSize: 9, color: MUTED }}>{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "#00ffff", width: 14, height: 14, cursor: "pointer", marginTop: 1 }}
      />
    </label>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: MUTED, flexShrink: 0 }}>{k}</span>
      <span style={{ color: "#fff", textAlign: "right", overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

const fmt = (n: number | undefined) => (n == null ? undefined : n.toLocaleString());

function useDetail<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: boolean }>({ path: null, data: null, error: false });
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    setState({ path, data: null, error: false });
    fetch(`${apiBase()}${path}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: T) => setState({ path, data, error: false }))
      .catch((err) => { if (err.name !== "AbortError") setState({ path, data: null, error: true }); });
    return () => ctrl.abort();
  }, [path]);
  return state.path === path ? state : { path, data: null, error: false };
}

function SelectionCard({ selection, landings, cables, onSelect, onFly, onView360 }: {
  selection: InfraSelection; landings: LandingPoint[]; cables: CableRoute[];
  onSelect: (sel: InfraSelection | null) => void; onFly: Props["onFly"]; onView360: Props["onView360"];
}) {
  const cable = useDetail<CableDetail>(selection.kind === "cable" ? `/api/proxy/infra/cable/${selection.cable.id}` : null);
  const landing = useDetail<LandingDetail>(selection.kind === "landing" ? `/api/proxy/infra/landing/${selection.landing.id}` : null);
  const landingById = useMemo(() => new Map(landings.map((l) => [l.id, l])), [landings]);
  const cableById = useMemo(() => new Map(cables.map((c) => [c.id, c])), [cables]);

  const kindLabel = { cable: "SUBMARINE CABLE", landing: "CABLE LANDING", datacenter: "DATA CENTRE", dam: "DAM" }[selection.kind];
  const color = { cable: INFRA_COLORS.cables, landing: INFRA_COLORS.landings, datacenter: INFRA_COLORS.datacenters, dam: INFRA_COLORS.dams }[selection.kind];
  const title =
    selection.kind === "cable" ? selection.cable.name
      : selection.kind === "landing" ? selection.landing.name
        : selection.kind === "datacenter" ? selection.dc.name ?? selection.dc.operator ?? "Unnamed data centre"
          : selection.dam.name ?? "Unnamed dam";

  const linkBtn = {
    background: "none", border: "none", padding: 0, color: "#a5f3fc", fontFamily: MONO, fontSize: 10,
    cursor: "pointer", textAlign: "left" as const, textDecoration: "underline", textUnderlineOffset: 2,
  };

  return (
    <section aria-label="Selected infrastructure" style={{ border: `1px solid ${color}55`, background: "rgba(2,8,14,0.7)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color, fontSize: 9, letterSpacing: 2 }}>{kindLabel}</span>
        <button type="button" onClick={() => onSelect(null)} aria-label="Clear selection" style={{ marginLeft: "auto", ...linkBtn, textDecoration: "none", color: MUTED }}>
          ✕
        </button>
      </div>
      <div style={{ color: "#fff", fontSize: 13, lineHeight: 1.3 }}>{title}</div>

      {selection.kind === "cable" && (
        cable.error ? <span style={{ color: MUTED }}>Details unavailable</span>
          : !cable.data ? <span style={{ color: MUTED }}>Querying TeleGeography…</span>
            : (
              <>
                {cable.data.length && <Row k="LENGTH" v={cable.data.length} />}
                {cable.data.rfs && <Row k="READY FOR SERVICE" v={`${cable.data.rfs}${cable.data.is_planned ? " (planned)" : ""}`} />}
                {cable.data.owners && <Row k="OWNERS" v={cable.data.owners} />}
                {cable.data.suppliers && <Row k="SUPPLIER" v={cable.data.suppliers} />}
                <span style={{ color: CYAN_DIM, letterSpacing: 1, marginTop: 2 }}>LANDINGS · {cable.data.landing_points.length}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 120, overflowY: "auto" }}>
                  {cable.data.landing_points.map((lp) => {
                    const pt = landingById.get(lp.id);
                    return (
                      <button
                        key={lp.id}
                        type="button"
                        style={linkBtn}
                        disabled={!pt}
                        onClick={() => {
                          if (!pt) return;
                          onSelect({ kind: "landing", landing: pt });
                          onFly(pt.lon, pt.lat, 8);
                        }}
                      >
                        {lp.name}
                      </button>
                    );
                  })}
                </div>
                {cable.data.url && (
                  <a href={cable.data.url} target="_blank" rel="noopener noreferrer" style={{ ...linkBtn, color: CYAN_DIM }}>
                    OPERATOR SITE ↗
                  </a>
                )}
              </>
            )
      )}

      {selection.kind === "landing" && (
        <>
          <Row k="POSITION" v={`${selection.landing.lat.toFixed(3)}, ${selection.landing.lon.toFixed(3)}`} />
          {landing.error ? <span style={{ color: MUTED }}>Details unavailable</span>
            : !landing.data ? <span style={{ color: MUTED }}>Querying TeleGeography…</span>
              : (
                <>
                  <Row k="COUNTRY" v={landing.data.country} />
                  <span style={{ color: CYAN_DIM, letterSpacing: 1, marginTop: 2 }}>CABLES · {landing.data.cables.length}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 140, overflowY: "auto" }}>
                    {landing.data.cables.map((c) => {
                      const route = cableById.get(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          style={linkBtn}
                          disabled={!route}
                          onClick={() => route && onSelect({ kind: "cable", cable: route, lon: selection.landing.lon, lat: selection.landing.lat })}
                        >
                          {c.name}{c.rfs_year ? ` · ${c.rfs_year}` : ""}{c.is_planned ? " (planned)" : ""}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
        </>
      )}

      {selection.kind === "datacenter" && (
        <>
          {selection.dc.operator && <Row k="OPERATOR" v={selection.dc.operator} />}
          {(selection.dc.city || selection.dc.country) && <Row k="LOCATION" v={[selection.dc.city, selection.dc.country].filter(Boolean).join(", ")} />}
          <Row k="POSITION" v={`${selection.dc.lat.toFixed(4)}, ${selection.dc.lon.toFixed(4)}`} />
          <Row k="SOURCE" v={selection.dc.osm ? "OSM · live" : "OSM · snapshot"} />
        </>
      )}

      {selection.kind === "dam" && (
        <>
          {selection.dam.mw != null && <Row k="HYDRO CAPACITY" v={formatMw(selection.dam.mw)} />}
          {selection.dam.heightM != null && <Row k="HEIGHT" v={`${selection.dam.heightM} m`} />}
          {selection.dam.river && <Row k="RIVER" v={selection.dam.river} />}
          {selection.dam.year != null && <Row k="COMPLETED" v={selection.dam.year} />}
          {selection.dam.owner && <Row k="OPERATOR" v={selection.dam.owner} />}
          <Row k="POSITION" v={`${selection.dam.lat.toFixed(4)}, ${selection.dam.lon.toFixed(4)}`} />
          {selection.dam.wikidata && (
            <a href={`https://www.wikidata.org/wiki/${selection.dam.wikidata}`} target="_blank" rel="noopener noreferrer" style={{ ...linkBtn, color: CYAN_DIM }}>
              WIKIDATA {selection.dam.wikidata} ↗
            </a>
          )}
        </>
      )}

      {selection.kind !== "cable" && (
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <button
            type="button"
            onClick={() => onView360(selection)}
            style={{ flex: 1, padding: "6px 0", fontFamily: MONO, fontSize: 10, letterSpacing: 1, color: "#020408", background: color, border: "none", cursor: "pointer" }}
          >
            360° 3D VIEW
          </button>
          <button
            type="button"
            onClick={() => {
              const p = selection.kind === "landing" ? selection.landing : selection.kind === "datacenter" ? selection.dc : selection.dam;
              onFly(p.lon, p.lat, selection.kind === "landing" ? 11 : 14);
            }}
            style={{ flex: 1, padding: "6px 0", fontFamily: MONO, fontSize: 10, letterSpacing: 1, color, background: "transparent", border: `1px solid ${color}`, cursor: "pointer" }}
          >
            FLY TO SITE
          </button>
        </div>
      )}
    </section>
  );
}

type SearchHit = { key: string; label: string; kind: string; color: string; sel: InfraSelection; lon: number; lat: number; zoom: number };

export function InfrastructurePanel(props: Props) {
  const {
    summary, status, osmStatus, enabled, onToggle, showLabels, onShowLabels, cableColorMode, onCableColorMode,
    cables, landings, datacenters, dams, selection, onSelect, onFly, onView360,
  } = props;
  const [query, setQuery] = useState("");

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: SearchHit[] = [];
    const push = (h: SearchHit) => { if (out.length < 10) out.push(h); };
    for (const c of cables) {
      if (!c.name.toLowerCase().includes(q)) continue;
      const mid = c.lines[0]?.[Math.floor((c.lines[0]?.length ?? 0) / 2)] ?? [0, 0];
      push({ key: `c:${c.id}`, label: c.name, kind: "CABLE", color: INFRA_COLORS.cables, sel: { kind: "cable", cable: c, lon: mid[0], lat: mid[1] }, lon: mid[0], lat: mid[1], zoom: 3 });
    }
    for (const l of landings) {
      if (out.length >= 10) break;
      if (l.name.toLowerCase().includes(q)) push({ key: `l:${l.id}`, label: l.name, kind: "LANDING", color: INFRA_COLORS.landings, sel: { kind: "landing", landing: l }, lon: l.lon, lat: l.lat, zoom: 9 });
    }
    for (const d of datacenters) {
      if (out.length >= 10) break;
      const label = d.name ?? d.operator;
      if (label?.toLowerCase().includes(q)) push({ key: d.id, label, kind: "DC", color: INFRA_COLORS.datacenters, sel: { kind: "datacenter", dc: d }, lon: d.lon, lat: d.lat, zoom: 13 });
    }
    for (const d of dams) {
      if (out.length >= 10) break;
      if (d.name?.toLowerCase().includes(q)) push({ key: d.id, label: d.name, kind: "DAM", color: INFRA_COLORS.dams, sel: { kind: "dam", dam: d }, lon: d.lon, lat: d.lat, zoom: 12.5 });
    }
    return out;
  }, [query, cables, landings, datacenters, dams]);

  const osmLine: Record<InfraOsmStatus, string> = {
    off: "Enable data centres or dams for live OSM top-up",
    "zoom-in": "Zoom in (z9+) to top up from live OpenStreetMap",
    loading: "Querying OpenStreetMap for this view…",
    ready: "Viewport topped up from live OpenStreetMap",
    error: "OpenStreetMap busy · showing snapshot",
  };
  const anyLoading = Object.values(status).includes("loading");

  return (
    <div style={{ fontFamily: MONO, color: "#bff", fontSize: 11, padding: 10, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: anyLoading ? "#e8b04a" : "#34d399", boxShadow: `0 0 8px ${anyLoading ? "#e8b04a" : "#34d399"}` }} />
        <span style={{ color: anyLoading ? "#e8b04a" : "#34d399", letterSpacing: 2 }}>{anyLoading ? "SYNCING" : "MAPPED INSTALLATIONS"}</span>
        {summary && (
          <span style={{ marginLeft: "auto", color: "#fff", fontSize: 14 }}>
            {(summary.cables.count + summary.cables.landings + summary.datacenters.count + summary.dams.count).toLocaleString()}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <Toggle
          label={INFRA_LAYER_INFO.cables.label}
          hint={summary ? `TeleGeography · ${summary.cables.live ? "live" : "snapshot"}` : INFRA_LAYER_INFO.cables.hint}
          color={INFRA_COLORS.cables}
          checked={enabled.cables}
          count={fmt(summary?.cables.count)}
          status={enabled.cables ? status.cables : undefined}
          onChange={(on) => onToggle("cables", on)}
        />
        <Toggle
          label={INFRA_LAYER_INFO.landings.label}
          hint={INFRA_LAYER_INFO.landings.hint}
          color={INFRA_COLORS.landings}
          checked={enabled.landings}
          count={fmt(summary?.cables.landings)}
          status={enabled.landings ? status.cables : undefined}
          onChange={(on) => onToggle("landings", on)}
        />
        <Toggle
          label={INFRA_LAYER_INFO.datacenters.label}
          hint={INFRA_LAYER_INFO.datacenters.hint}
          color={INFRA_COLORS.datacenters}
          checked={enabled.datacenters}
          count={fmt(datacenters.length || summary?.datacenters.count)}
          status={enabled.datacenters ? status.datacenters : undefined}
          onChange={(on) => onToggle("datacenters", on)}
        />
        <Toggle
          label={INFRA_LAYER_INFO.dams.label}
          hint={INFRA_LAYER_INFO.dams.hint}
          color={INFRA_COLORS.dams}
          checked={enabled.dams}
          count={fmt(dams.length || summary?.dams.count)}
          status={enabled.dams ? status.dams : undefined}
          onChange={(on) => onToggle("dams", on)}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: BORDER, paddingTop: 10 }}>
        <label style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
          <span>LABELS</span>
          <input type="checkbox" checked={showLabels} onChange={(e) => onShowLabels(e.target.checked)} style={{ accentColor: "#00ffff", width: 14, height: 14, cursor: "pointer" }} />
        </label>
        <div role="radiogroup" aria-label="Cable colour" style={{ display: "flex", gap: 4 }}>
          {(["uniform", "operator"] as const).map((m) => {
            const active = cableColorMode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onCableColorMode(m)}
                style={{
                  flex: 1, padding: "5px 0", fontFamily: MONO, fontSize: 10, letterSpacing: 1, cursor: "pointer",
                  color: active ? "#020408" : "#bff", background: active ? "#00ffff" : "rgba(0,255,255,0.06)",
                  border: `1px solid ${active ? "#00ffff" : "rgba(0,255,255,0.25)"}`,
                }}
              >
                {m === "uniform" ? "TACTICAL" : "SYSTEM COLOURS"}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 9, color: MUTED }}>{osmLine[osmStatus]}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="infra-search" style={{ color: CYAN_DIM, letterSpacing: 1 }}>SEARCH INSTALLATIONS</label>
        <input
          id="infra-search"
          type="search"
          value={query}
          placeholder="Cable, landing, dam, operator…"
          onChange={(e) => setQuery(e.target.value)}
          style={{ fontFamily: MONO, fontSize: 11, padding: "6px 8px", color: "#e0fbff", background: "rgba(2,4,8,0.9)", border: "1px solid rgba(0,255,255,0.25)", outline: "none" }}
        />
        {hits.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto" }}>
            {hits.map((h) => (
              <li key={h.key}>
                <button
                  type="button"
                  onClick={() => { onSelect(h.sel); onFly(h.lon, h.lat, h.zoom); setQuery(""); }}
                  style={{ width: "100%", display: "flex", gap: 8, alignItems: "center", padding: "4px 6px", background: "rgba(0,255,255,0.04)", border: "none", cursor: "pointer", fontFamily: MONO, fontSize: 10, color: "#e0fbff", textAlign: "left" }}
                >
                  <span style={{ color: h.color, width: 52, flexShrink: 0, letterSpacing: 1 }}>{h.kind}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && hits.length === 0 && <span style={{ fontSize: 9, color: MUTED }}>No matches in enabled layers</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="infra-hotspot" style={{ color: CYAN_DIM, letterSpacing: 1 }}>JUMP TO HOTSPOT</label>
        <select
          id="infra-hotspot"
          value=""
          onChange={(e) => {
            const h = HOTSPOTS.find((x) => x.id === e.target.value);
            if (h) onFly(h.lon, h.lat, h.zoom);
          }}
          style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, padding: "5px 6px", color: "#bff", background: "rgba(2,4,8,0.9)", border: "1px solid rgba(0,255,255,0.25)", cursor: "pointer" }}
        >
          <option value="" disabled>SELECT SITE…</option>
          {HOTSPOTS.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </div>

      {selection && <SelectionCard selection={selection} landings={landings} cables={cables} onSelect={onSelect} onFly={onFly} onView360={onView360} />}

      {summary && (
        <div style={{ fontSize: 8.5, color: MUTED, lineHeight: 1.5, borderTop: BORDER, paddingTop: 8 }}>
          {summary.attribution.map((a) => <div key={a}>{a}</div>)}
        </div>
      )}
    </div>
  );
}
