import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { formatAlt, SQUAWK_COLOR, type SquawkAlert } from "../lib/signals";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  alerts: SquawkAlert[];
  onSelect: (a: SquawkAlert) => void;
}

/** Pulsing global markers for aircraft squawking 7500 / 7600 / 7700. Always mounted. */
export function SquawkMarkers({ map, mapLoaded, alerts, onSelect }: Props) {
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  useEffect(() => {
    if (!map || !mapLoaded) return;
    const live = new Set<string>();
    for (const a of alerts) {
      live.add(a.hex);
      let m = markers.current.get(a.hex);
      if (!m) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sqk-marker";
        el.innerHTML = `<span class="sqk-ring"></span><span class="sqk-ring sqk-ring-2"></span><span class="sqk-core"></span><span class="sqk-tag"></span>`;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const cur = alertsRef.current.find((x) => x.hex === el.dataset.hex);
          if (cur) onSelectRef.current(cur);
        });
        m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([a.lon, a.lat]).addTo(map);
        markers.current.set(a.hex, m);
      }
      const el = m.getElement();
      const label = `${a.flight || a.reg || a.hex.toUpperCase()} · squawk ${a.squawk} ${a.meaning} · ${a.type || "unknown type"} · ${formatAlt(a.alt)}`;
      el.dataset.hex = a.hex;
      el.style.setProperty("--sqk", SQUAWK_COLOR[a.squawk] ?? "#ef4444");
      el.setAttribute("aria-label", label);
      el.title = label;
      (el.querySelector(".sqk-tag") as HTMLElement).textContent = `${a.squawk} ${a.flight || a.hex.toUpperCase()}`;
      m.setLngLat([a.lon, a.lat]);
    }
    for (const [hex, m] of markers.current) {
      if (!live.has(hex)) { m.remove(); markers.current.delete(hex); }
    }
  }, [map, mapLoaded, alerts]);

  useEffect(() => () => {
    for (const m of markers.current.values()) m.remove();
    markers.current.clear();
  }, []);

  return null;
}
