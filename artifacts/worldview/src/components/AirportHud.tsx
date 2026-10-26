import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Airport } from "../lib/airports";
import { PHASE_COLOR, formatAltitude, phaseLabel, type AirportContact, type ContactPhase } from "../lib/airport-traffic";

export type AirportCameraPreset = "overview" | "top" | "spotter";
export type FeedState = "connecting" | "live" | "stale" | "error";

interface InfoAirport { name?: string; iata?: string; icao?: string; city?: string; country?: string }
export interface AircraftInfo {
  aircraft: {
    type?: string;
    icaoType?: string;
    manufacturer?: string;
    registration?: string;
    owner?: string;
    ownerCountry?: string;
    photo?: string;
  } | null;
  route: { airline?: string | null; origin: InfoAirport | null; destination: InfoAirport | null } | null;
}

interface Props {
  airport: Airport;
  contacts: AirportContact[];
  selected: AirportContact | null;
  selectedInfo: AircraftInfo | "loading" | null;
  feed: FeedState;
  lastUpdate: number | null;
  tilesReady: boolean;
  following: boolean;
  visible: boolean;
  onSelect: (hex: string | null) => void;
  onToggleFollow: () => void;
  onPreset: (p: AirportCameraPreset) => void;
  onExit: () => void;
}

const FONT = "'Share Tech Mono','Courier New',monospace";
const CYAN = "#00ffff";
const DIM = "rgba(125,249,255,0.5)";

const card: CSSProperties = {
  background: "rgba(2,4,8,0.86)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(0,255,255,0.18)",
  borderRadius: 2,
  boxShadow: "0 0 24px rgba(0,0,0,0.55)",
  pointerEvents: "auto",
};

type Filter = "all" | "ground" | "air";

const FEED_LABEL: Record<FeedState, { text: string; color: string }> = {
  connecting: { text: "ACQUIRING FEED", color: "#ffd34d" },
  live: { text: "LIVE", color: "#7dff9a" },
  stale: { text: "FEED DEGRADED", color: "#ffd34d" },
  error: { text: "FEED OFFLINE", color: "#ff5b5b" },
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 9, letterSpacing: "0.22em", color: DIM, textTransform: "uppercase" }}>{children}</div>;
}

function Row({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, padding: "3px 0" }}>
      <span style={{ color: DIM, letterSpacing: "0.12em" }}>{label}</span>
      <span style={{ color: color ?? "#d8fbff", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function HudButton({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: FONT,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        padding: "8px 12px",
        color: active ? "#020408" : CYAN,
        background: active ? CYAN : "transparent",
        border: `1px solid ${active ? CYAN : "rgba(0,255,255,0.3)"}`,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function airportLine(a: InfoAirport | null): string {
  if (!a) return "—";
  const code = a.iata || a.icao || "";
  return `${code}${a.city ? ` · ${a.city}` : a.name ? ` · ${a.name}` : ""}`;
}

export function AirportHud({
  airport,
  contacts,
  selected,
  selectedInfo,
  feed,
  lastUpdate,
  tilesReady,
  following,
  visible,
  onSelect,
  onToggleFollow,
  onPreset,
  onExit,
}: Props) {
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c: Record<ContactPhase, number> & { vehicle: number } = { parked: 0, taxi: 0, takeoff: 0, airborne: 0, vehicle: 0 };
    for (const x of contacts) {
      if (x.vehicle) c.vehicle++;
      else c[x.phase]++;
    }
    return c;
  }, [contacts]);

  const list = useMemo(() => {
    const filtered = contacts.filter((c) => (filter === "all" ? true : filter === "ground" ? c.onGround : !c.onGround));
    const rank: Record<ContactPhase, number> = { takeoff: 0, taxi: 1, airborne: 2, parked: 3 };
    return filtered.sort((a, b) => rank[a.phase] - rank[b.phase] || a.callsign.localeCompare(b.callsign));
  }, [contacts, filter]);

  const feedLabel = FEED_LABEL[feed];
  const ageSec = lastUpdate ? Math.max(0, Math.round((now - lastUpdate) / 1000)) : null;
  const utc = new Date(now).toISOString().slice(11, 19);
  const info = selectedInfo && selectedInfo !== "loading" ? selectedInfo : null;

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
        transition: "opacity 0.5s ease",
      }}
    >
      {/* LEFT COLUMN — airport header, counts, live contact list */}
      <section
        aria-label={`Live airport view ${airport.icao}`}
        style={{ position: "absolute", left: 56, top: 14, width: 300, display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 110px)" }}
      >
        <div style={{ ...card, padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <SectionTitle>Live airport // ADS-B surface</SectionTitle>
            <span style={{ fontSize: 9, color: DIM }}>{utc}Z</span>
          </div>
          <h2 style={{ margin: "6px 0 2px", fontSize: 22, letterSpacing: "0.12em", color: CYAN, fontWeight: 400 }}>
            {airport.icao}
            {airport.iata && <span style={{ fontSize: 13, color: DIM, marginLeft: 8 }}>{airport.iata}</span>}
          </h2>
          <div style={{ fontSize: 11, color: "#d8fbff" }}>{airport.name}</div>
          <div style={{ fontSize: 10, color: DIM, marginTop: 2 }}>
            {airport.city} · {airport.lat.toFixed(4)}, {airport.lon.toFixed(4)}
            {!airport.custom && ` · ELEV ${airport.elevFt} FT`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 10, letterSpacing: "0.16em" }}>
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: "50%", background: feedLabel.color, boxShadow: `0 0 8px ${feedLabel.color}`, animation: feed === "live" ? "pulse-glow 2s ease-in-out infinite" : undefined }}
            />
            <span style={{ color: feedLabel.color }}>{feedLabel.text}</span>
            <span style={{ color: DIM, marginLeft: "auto" }}>
              {ageSec === null ? "—" : `${ageSec}s AGO`} · {tilesReady ? "3D TILES" : "LOADING 3D"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginTop: 10 }}>
            {(
              [
                ["PARK", counts.parked, PHASE_COLOR.parked],
                ["TAXI", counts.taxi, PHASE_COLOR.taxi],
                ["ROLL", counts.takeoff, PHASE_COLOR.takeoff],
                ["AIR", counts.airborne, PHASE_COLOR.airborne],
                ["VEH", counts.vehicle, "#ffd34d"],
              ] as const
            ).map(([label, n, color]) => (
              <div key={label} style={{ textAlign: "center", padding: "6px 0", border: "1px solid rgba(0,255,255,0.08)", background: "rgba(0,255,255,0.025)" }}>
                <div style={{ fontSize: 16, color }}>{n}</div>
                <div style={{ fontSize: 8, letterSpacing: "0.18em", color: DIM }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ ...card, display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div role="tablist" aria-label="Contact filter" style={{ display: "flex", borderBottom: "1px solid rgba(0,255,255,0.12)" }}>
            {(["all", "ground", "air"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                style={{
                  flex: 1,
                  fontFamily: FONT,
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  padding: "8px 0",
                  background: filter === f ? "rgba(0,255,255,0.1)" : "transparent",
                  color: filter === f ? CYAN : DIM,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {f === "all" ? `All ${contacts.length}` : f === "ground" ? "On ground" : "Airborne"}
              </button>
            ))}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 4, overflowY: "auto", minHeight: 0 }}>
            {list.length === 0 && (
              <li style={{ fontSize: 10, color: DIM, padding: 12, textAlign: "center", letterSpacing: "0.14em" }}>
                {feed === "connecting" ? "ACQUIRING CONTACTS…" : "NO CONTACTS IN RANGE"}
              </li>
            )}
            {list.map((c) => {
              const isSel = selected?.hex === c.hex;
              const color = c.military ? "#ff7a3d" : c.vehicle ? "#ffd34d" : PHASE_COLOR[c.phase];
              return (
                <li key={c.hex}>
                  <button
                    type="button"
                    onClick={() => onSelect(isSel ? null : c.hex)}
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 2,
                      textAlign: "left",
                      fontFamily: FONT,
                      padding: "6px 8px",
                      marginBottom: 2,
                      background: isSel ? "rgba(0,255,255,0.1)" : "transparent",
                      border: `1px solid ${isSel ? "rgba(0,255,255,0.4)" : "transparent"}`,
                      color: "#d8fbff",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 12, letterSpacing: "0.08em" }}>{c.callsign}</span>
                    <span style={{ fontSize: 9, color, letterSpacing: "0.16em", alignSelf: "center" }}>
                      {c.vehicle ? "VEHICLE" : phaseLabel(c)}
                    </span>
                    <span style={{ fontSize: 9, color: DIM }}>{c.type ?? c.category ?? "—"}{c.registration ? ` · ${c.registration}` : ""}</span>
                    <span style={{ fontSize: 9, color: DIM, textAlign: "right" }}>
                      {formatAltitude(c)}{c.gsKt !== null ? ` · ${Math.round(c.gsKt)}kt` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* RIGHT — selected contact card */}
      {selected && (
        <aside aria-label={`Selected aircraft ${selected.callsign}`} style={{ ...card, position: "absolute", right: 14, top: 70, width: 290, padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <SectionTitle>{selected.military ? "Military contact" : selected.vehicle ? "Surface vehicle" : "Contact"}</SectionTitle>
            <button
              type="button"
              onClick={() => onSelect(null)}
              aria-label="Close contact"
              style={{ fontFamily: FONT, fontSize: 10, background: "none", border: "none", color: DIM, cursor: "pointer" }}
            >
              [X]
            </button>
          </div>
          <div style={{ fontSize: 20, color: selected.military ? "#ff7a3d" : CYAN, letterSpacing: "0.1em", margin: "4px 0 2px" }}>{selected.callsign}</div>
          <div style={{ fontSize: 10, color: PHASE_COLOR[selected.phase], letterSpacing: "0.18em", marginBottom: 8 }}>
            {selected.vehicle ? "VEHICLE" : phaseLabel(selected)}
          </div>
          {info?.aircraft?.photo && (
            <img
              src={info.aircraft.photo}
              alt={`Photo of ${info.aircraft.registration ?? selected.callsign}`}
              referrerPolicy="no-referrer"
              style={{ width: "100%", height: 120, objectFit: "cover", border: "1px solid rgba(0,255,255,0.15)", marginBottom: 8 }}
            />
          )}
          {selectedInfo === "loading" && <div style={{ fontSize: 9, color: DIM, letterSpacing: "0.16em", marginBottom: 6 }}>ENRICHING…</div>}
          {info?.route && (
            <div style={{ border: "1px solid rgba(0,255,255,0.12)", padding: "6px 8px", marginBottom: 8, background: "rgba(0,255,255,0.03)" }}>
              {info.route.airline && <div style={{ fontSize: 10, color: DIM, marginBottom: 4 }}>{info.route.airline}</div>}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, gap: 8 }}>
                <span>{airportLine(info.route.origin)}</span>
                <span aria-hidden style={{ color: CYAN }}>{"→"}</span>
                <span style={{ textAlign: "right" }}>{airportLine(info.route.destination)}</span>
              </div>
            </div>
          )}
          <Row label="HEX" value={selected.hex.toUpperCase()} />
          <Row label="REG" value={info?.aircraft?.registration ?? selected.registration ?? "—"} />
          <Row label="TYPE" value={info?.aircraft?.type ?? selected.desc ?? selected.type ?? "—"} />
          {info?.aircraft?.owner && <Row label="OPERATOR" value={info.aircraft.owner} />}
          <Row label="ALTITUDE" value={formatAltitude(selected)} />
          <Row label="GROUND SPD" value={selected.gsKt === null ? "—" : `${Math.round(selected.gsKt)} kt`} />
          <Row label="HEADING" value={`${Math.round(selected.headingDeg)}°`} />
          {selected.vsFpm !== null && !selected.onGround && <Row label="V/S" value={`${selected.vsFpm > 0 ? "+" : ""}${selected.vsFpm} fpm`} />}
          <Row label="SQUAWK" value={selected.squawk ?? "—"} color={selected.squawk === "7700" || selected.squawk === "7600" || selected.squawk === "7500" ? "#ff5b5b" : undefined} />
          <Row label="POSITION" value={`${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`} />
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <HudButton active={following} onClick={onToggleFollow} title="Keep the camera with this aircraft">
              {following ? "Following" : "Follow"}
            </HudButton>
            <HudButton onClick={() => onSelect(selected.hex)} title="Fly the camera to this aircraft">
              Focus
            </HudButton>
          </div>
        </aside>
      )}

      {/* BOTTOM — camera presets + exit */}
      <nav
        aria-label="Airport camera"
        style={{ ...card, position: "absolute", left: "50%", bottom: 18, transform: "translateX(-50%)", display: "flex", gap: 6, padding: 6 }}
      >
        <HudButton onClick={() => onPreset("overview")}>Overview</HudButton>
        <HudButton onClick={() => onPreset("top")}>Top-down</HudButton>
        <HudButton onClick={() => onPreset("spotter")}>Spotter</HudButton>
        <HudButton onClick={onExit} title="Exit airport view (Esc)">
          Exit [Esc]
        </HudButton>
      </nav>
    </div>
  );
}
