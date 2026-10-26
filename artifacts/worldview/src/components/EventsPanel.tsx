import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLink, Crosshair, Sparkles, RefreshCw, Plane, Ship as ShipIcon } from "lucide-react";
import {
  EVENT_SOURCES,
  SOURCE_META,
  STANDING_SOURCES,
  relativeAge,
  type Correlation,
  type EventBrief,
  type EventFilters,
  type EventsPayload,
  type WorldEvent,
} from "../lib/events";

const FONT = "'Share Tech Mono','Courier New',monospace";
const CYAN = "#22d3ee";
const DIM = "rgba(125,249,255,0.5)";
const WINDOWS = [
  { hours: 1, label: "1H" },
  { hours: 6, label: "6H" },
  { hours: 24, label: "24H" },
  { hours: 0, label: "ALL" },
];

interface Props {
  data: EventsPayload | null;
  status: "idle" | "loading" | "ready" | "error";
  onReload: () => void;
  events: WorldEvent[];
  filters: EventFilters;
  onFilters: (f: EventFilters) => void;
  correlations: Map<string, Correlation>;
  darkShipCount: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFly: (e: WorldEvent) => void;
  brief: { state: "idle" | "loading" | "ready" | "error"; value: EventBrief | null; error: string | null };
  onBrief: () => void;
}

type Sort = "latest" | "severity" | "correlated";

/** Live open-web event feed: news events, airspace NOTAMs, maritime warnings and quakes, correlated with live sensors. */
export function EventsPanel({ data, status, onReload, events, filters, onFilters, correlations, darkShipCount, selectedId, onSelect, onFly, brief, onBrief }: Props) {
  const [sort, setSort] = useState<Sort>("latest");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
  }, [events]);

  const sorted = useMemo(() => {
    const list = [...events];
    if (sort === "severity") list.sort((a, b) => b.severity - a.severity || Date.parse(b.time) - Date.parse(a.time));
    else if (sort === "correlated") list.sort((a, b) => (correlations.get(b.id)?.count ?? 0) - (correlations.get(a.id)?.count ?? 0) || b.severity - a.severity);
    else list.sort((a, b) => (STANDING_SOURCES.has(a.source) ? 1 : 0) - (STANDING_SOURCES.has(b.source) ? 1 : 0) || Date.parse(b.time) - Date.parse(a.time));
    return list.slice(0, 250);
  }, [events, sort, correlations]);

  const aircraftHits = [...correlations.values()].filter((c) => c.kind === "aircraft_in_tfr");
  const shipHits = [...correlations.values()].filter((c) => c.kind === "ships_in_warning");
  const aircraftTotal = aircraftHits.reduce((a, c) => a + c.count, 0);
  const shipTotal = shipHits.reduce((a, c) => a + c.count, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", fontFamily: FONT, color: "#e6fdff" }}>
      <div style={{ padding: "10px 12px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          onClick={onBrief}
          disabled={brief.state === "loading" || !data}
          style={{
            fontFamily: FONT, fontSize: 10.5, letterSpacing: "0.24em", padding: "9px 0", cursor: brief.state === "loading" ? "wait" : "pointer",
            color: "#02060c", background: CYAN, border: "none", boxShadow: "0 0 18px rgba(34,211,238,0.45)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: !data ? 0.5 : 1,
          }}
        >
          <Sparkles size={13} aria-hidden />
          {brief.state === "loading" ? "ANALYST BRIEFING…" : `AI BRIEF · LAST ${filters.hours ? `${filters.hours}H` : "24H"}`}
        </button>

        {(brief.value || brief.error) && (
          <section
            aria-live="polite"
            aria-label="AI situation brief"
            style={{ border: "1px solid rgba(34,211,238,0.35)", background: "rgba(34,211,238,0.06)", padding: "8px 10px", fontSize: 10.5, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}
          >
            {brief.error ? (
              <span style={{ color: "#fb7185" }}>{brief.error}</span>
            ) : (
              <>
                {brief.value!.text}
                <div style={{ fontSize: 8.5, color: "rgba(125,249,255,0.4)", marginTop: 6, letterSpacing: "0.1em" }}>
                  {brief.value!.model.toUpperCase()} · {new Date(brief.value!.generatedAt).toISOString().slice(11, 16)}Z · MACHINE-GENERATED, VERIFY SOURCES
                </div>
              </>
            )}
          </section>
        )}

        {(aircraftTotal > 0 || shipTotal > 0 || darkShipCount > 0) && (
          <div role="status" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {aircraftTotal > 0 && (
              <Alert color="#a78bfa" onClick={() => setSort("correlated")}>
                <Plane size={11} aria-hidden /> {aircraftTotal} AIRCRAFT IN {aircraftHits.length} TFR{aircraftHits.length > 1 ? "S" : ""}
              </Alert>
            )}
            {shipTotal > 0 && (
              <Alert color="#38bdf8" onClick={() => setSort("correlated")}>
                <ShipIcon size={11} aria-hidden /> {shipTotal} SHIPS IN {shipHits.length} WARNING ZONE{shipHits.length > 1 ? "S" : ""}
              </Alert>
            )}
            {darkShipCount > 0 && <Alert color="#fb923c">{darkShipCount} AIS-DARK VESSELS</Alert>}
          </div>
        )}

        <div role="group" aria-label="Event sources" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
          {EVENT_SOURCES.map((s) => {
            const on = filters.sources[s];
            const meta = SOURCE_META[s];
            const st = data?.sources[s];
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => onFilters({ ...filters, sources: { ...filters.sources, [s]: !on } })}
                title={st?.error ? `${meta.origin}: ${st.error}` : `${meta.origin} · ${st?.count ?? 0} in feed`}
                style={{
                  fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.12em", padding: "6px 8px", cursor: "pointer", textAlign: "left",
                  display: "flex", alignItems: "center", gap: 6,
                  color: on ? "#e6fdff" : DIM,
                  background: on ? `${meta.color}1f` : "transparent",
                  border: `1px solid ${on ? `${meta.color}99` : "rgba(34,211,238,0.18)"}`,
                }}
              >
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: st?.error && !st.ok ? "#64748b" : meta.color, boxShadow: on ? `0 0 6px ${meta.color}` : "none", flexShrink: 0 }} />
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.label.toUpperCase()}</span>
                <span style={{ color: on ? meta.color : DIM }}>{on ? counts[s] ?? 0 : "–"}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div role="radiogroup" aria-label="Report window" style={{ display: "flex", gap: 4 }}>
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                role="radio"
                aria-checked={filters.hours === w.hours}
                onClick={() => onFilters({ ...filters, hours: w.hours })}
                style={{
                  fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.14em", padding: "4px 7px", cursor: "pointer",
                  color: filters.hours === w.hours ? "#02060c" : DIM,
                  background: filters.hours === w.hours ? CYAN : "transparent",
                  border: `1px solid ${filters.hours === w.hours ? CYAN : "rgba(34,211,238,0.25)"}`,
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 9, color: DIM, letterSpacing: "0.14em", display: "flex", alignItems: "center", gap: 4 }}>
            SORT
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              style={{ fontFamily: FONT, fontSize: 9.5, background: "#02080e", color: "#e6fdff", border: "1px solid rgba(34,211,238,0.3)", padding: "3px 4px" }}
            >
              <option value="latest">LATEST</option>
              <option value="severity">SEVERITY</option>
              <option value="correlated">CORRELATED</option>
            </select>
          </label>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "2px 12px 12px" }}>
        {status === "loading" && !data && <p style={{ fontSize: 10, color: DIM, letterSpacing: "0.2em" }}>INGESTING OPEN-WEB FEEDS…</p>}
        {status === "error" && !data && (
          <div style={{ fontSize: 10, color: "#fb7185", letterSpacing: "0.14em" }}>
            EVENT FEEDS UNAVAILABLE.{" "}
            <button type="button" onClick={onReload} style={{ fontFamily: FONT, background: "none", border: "none", color: CYAN, cursor: "pointer", textDecoration: "underline" }}>
              RETRY
            </button>
          </div>
        )}
        {data && sorted.length === 0 && <p style={{ fontSize: 10, color: DIM, letterSpacing: "0.14em" }}>NO EVENTS IN THIS WINDOW. WIDEN THE WINDOW OR ENABLE MORE SOURCES.</p>}

        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sorted.map((e) => (
            <EventRow key={e.id} e={e} now={now} corr={correlations.get(e.id)} selected={selectedId === e.id} onSelect={onSelect} onFly={onFly} />
          ))}
        </ul>

        {data && (
          <p style={{ fontSize: 8.5, color: "rgba(125,249,255,0.35)", letterSpacing: "0.1em", marginTop: 10, lineHeight: 1.6 }}>
            SOURCES · GDELT 2.0 · FAA TFR · NGA MSI · USGS · NOTAMS &amp; NAV WARNINGS SHOWN WHILE ACTIVE · UPDATED {new Date(data.fetchedAt).toISOString().slice(11, 16)}Z{" "}
            <button type="button" onClick={onReload} aria-label="Refresh feeds" style={{ background: "none", border: "none", color: CYAN, cursor: "pointer", padding: 0, verticalAlign: "middle" }}>
              <RefreshCw size={10} aria-hidden />
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function Alert({ color, onClick, children }: { color: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.12em", padding: "4px 8px", cursor: onClick ? "pointer" : "default",
        display: "inline-flex", alignItems: "center", gap: 5, color, background: `${color}14`, border: `1px solid ${color}80`,
      }}
    >
      {children}
    </button>
  );
}

function Severity({ value, color }: { value: number; color: string }) {
  return (
    <span aria-label={`Severity ${value} of 5`} style={{ display: "inline-flex", gap: 2, alignItems: "flex-end" }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden style={{ width: 3, height: 3 + i * 1.5, background: i <= value ? color : "rgba(125,249,255,0.15)" }} />
      ))}
    </span>
  );
}

function EventRow({ e, now, corr, selected, onSelect, onFly }: { e: WorldEvent; now: number; corr?: Correlation; selected: boolean; onSelect: (id: string | null) => void; onFly: (e: WorldEvent) => void }) {
  const meta = SOURCE_META[e.source];
  const standing = STANDING_SOURCES.has(e.source);
  return (
    <li
      style={{
        marginBottom: 5,
        border: `1px solid ${selected ? `${meta.color}cc` : corr ? "rgba(253,224,71,0.45)" : "rgba(34,211,238,0.14)"}`,
        background: selected ? `${meta.color}14` : "rgba(2,8,14,0.6)",
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(selected ? null : e.id)}
        aria-expanded={selected}
        style={{ display: "flex", width: "100%", gap: 8, padding: "7px 9px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: FONT, color: "#e6fdff" }}
      >
        <span aria-hidden style={{ width: 3, alignSelf: "stretch", background: meta.color, boxShadow: `0 0 6px ${meta.color}`, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 8.5, letterSpacing: "0.16em", color: meta.color }}>
            <span>
              {meta.short} · {e.category.toUpperCase()}
            </span>
            <span style={{ color: DIM }}>{standing ? "ACTIVE" : relativeAge(e.time, now)}</span>
          </span>
          <span
            style={{ display: "-webkit-box", WebkitLineClamp: selected ? 4 : 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 10.5, lineHeight: 1.4, marginTop: 2 }}
          >
            {e.title}
          </span>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 3 }}>
            <span style={{ fontSize: 8.5, color: DIM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.summary}</span>
            <Severity value={e.severity} color={meta.color} />
          </span>
          {corr && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, fontSize: 9, letterSpacing: "0.12em", color: "#fde047" }}>
              {corr.kind === "aircraft_in_tfr" ? <Plane size={10} aria-hidden /> : <ShipIcon size={10} aria-hidden />}
              {corr.count} {corr.kind === "aircraft_in_tfr" ? "AIRCRAFT INSIDE" : "VESSELS INSIDE"}
            </span>
          )}
        </span>
      </button>

      {selected && (
        <div style={{ padding: "0 10px 10px 20px", fontSize: 9.5, lineHeight: 1.55, color: "#cfefff" }}>
          {corr && (
            <p style={{ margin: "0 0 6px", color: "#fde047" }}>
              {corr.kind === "aircraft_in_tfr" ? "LIVE ADS-B INSIDE RESTRICTED AIRSPACE: " : "LIVE AIS INSIDE WARNING ZONE: "}
              {corr.sample.join(", ")}
              {corr.count > corr.sample.length ? ` +${corr.count - corr.sample.length}` : ""}
            </p>
          )}
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "1px 10px", margin: 0 }}>
            <dt style={{ color: DIM }}>SOURCE</dt>
            <dd style={{ margin: 0 }}>{meta.origin}</dd>
            <dt style={{ color: DIM }}>{standing ? "ISSUED" : "REPORTED"}</dt>
            <dd style={{ margin: 0 }}>{e.time.slice(0, 16).replace("T", " ")}Z</dd>
            <dt style={{ color: DIM }}>POSITION</dt>
            <dd style={{ margin: 0 }}>
              {e.lat.toFixed(2)}, {e.lon.toFixed(2)}
              {e.polygon ? " · AREA" : ""}
            </dd>
            {e.source === "gdelt" && (
              <>
                <dt style={{ color: DIM }}>COVERAGE</dt>
                <dd style={{ margin: 0 }}>
                  {String(e.meta.mentions ?? 0)} mentions · Goldstein {String(e.meta.goldstein ?? "–")}
                  {e.meta.corroborated === false ? " · UNCORROBORATED CODING" : ""}
                </dd>
              </>
            )}
          </dl>
          {e.source === "maritime" && typeof e.meta.text === "string" && (
            <pre style={{ margin: "6px 0 0", fontFamily: FONT, fontSize: 9, color: DIM, whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{e.meta.text}</pre>
          )}
          <div style={{ display: "grid", gridTemplateColumns: e.url ? "1fr 1fr" : "1fr", gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => onFly(e)}
              style={{ fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.2em", padding: "7px 0", cursor: "pointer", color: "#02060c", background: meta.color, border: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              <Crosshair size={11} aria-hidden /> LOCATE
            </button>
            {e.url && (
              <a
                href={e.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.2em", padding: "7px 0", color: meta.color, border: `1px solid ${meta.color}80`, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                SOURCE <ExternalLink size={10} aria-hidden />
              </a>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
