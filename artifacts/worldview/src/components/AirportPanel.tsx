import { useMemo, useState } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { searchAirports, type Airport } from "../lib/airports";

const FONT = "'Share Tech Mono','Courier New',monospace";
const DIM = "rgba(125,249,255,0.5)";

interface PanelProps {
  onClose: () => void;
  onEnter: (airport: Airport) => void;
  onDropAtCenter: () => void;
}

/** Airport picker: search the curated list, or drop the 3D airport camera at the current map centre. */
export function AirportPanel({ onClose, onEnter, onDropAtCenter }: PanelProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchAirports(query), [query]);

  return (
    <FloatingPanel title="LIVE AIRPORTS" initialX={54} initialY={14} width={300} maxHeight="calc(100vh - 28px)" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontFamily: FONT }}>
        <div style={{ padding: "10px 12px 8px" }}>
          <p style={{ margin: "0 0 8px", fontSize: 10, color: DIM, lineHeight: 1.5 }}>
            Drop the camera into an airport to see live ADS-B traffic in photorealistic 3D, including aircraft taxiing and parked on the ground.
          </p>
          <label htmlFor="airport-search" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Search airports
          </label>
          <input
            id="airport-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ICAO / IATA / CITY…"
            autoComplete="off"
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: FONT,
              fontSize: 11,
              letterSpacing: "0.1em",
              padding: "8px 10px",
              background: "rgba(0,255,255,0.04)",
              border: "1px solid rgba(0,255,255,0.22)",
              color: "#d8fbff",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={onDropAtCenter}
            title="Open the live 3D airport view at the centre of the map"
            style={{
              width: "100%",
              marginTop: 8,
              fontFamily: FONT,
              fontSize: 10,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              padding: "9px 0",
              background: "rgba(0,255,255,0.08)",
              border: "1px solid rgba(0,255,255,0.4)",
              color: "#00ffff",
              cursor: "pointer",
            }}
          >
            [+] Drop camera at map centre
          </button>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: "0 6px 8px", overflowY: "auto", minHeight: 0, flex: 1 }}>
          {results.length === 0 && (
            <li style={{ fontSize: 10, color: DIM, padding: 12, textAlign: "center" }}>NO MATCH — USE “DROP CAMERA” FOR ANY AIRFIELD</li>
          )}
          {results.map((a) => (
            <li key={a.icao}>
              <button
                type="button"
                onClick={() => onEnter(a)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  textAlign: "left",
                  fontFamily: FONT,
                  padding: "7px 8px",
                  background: "transparent",
                  border: "1px solid transparent",
                  color: "#d8fbff",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(0,255,255,0.07)";
                  e.currentTarget.style.borderColor = "rgba(0,255,255,0.25)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderColor = "transparent";
                }}
              >
                <span style={{ fontSize: 12, color: "#00ffff", letterSpacing: "0.1em", minWidth: 44 }}>{a.icao}</span>
                <span style={{ flex: 1, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                <span style={{ fontSize: 9, color: DIM }}>{a.iata}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </FloatingPanel>
  );
}

interface ChipProps {
  airport: Airport;
  onEnter: (airport: Airport) => void;
}

/** Shown when the 2D map is zoomed in over a known airport. */
export function AirportProximityChip({ airport, onEnter }: ChipProps) {
  return (
    <button
      type="button"
      onClick={() => onEnter(airport)}
      style={{
        position: "absolute",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: FONT,
        fontSize: 11,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        padding: "10px 16px",
        background: "rgba(2,4,8,0.9)",
        border: "1px solid rgba(0,255,255,0.55)",
        color: "#00ffff",
        cursor: "pointer",
        boxShadow: "0 0 22px rgba(0,255,255,0.25)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "#7dff9a", boxShadow: "0 0 8px #7dff9a" }} />
      {airport.icao} detected — enter live airport 3D
    </button>
  );
}
