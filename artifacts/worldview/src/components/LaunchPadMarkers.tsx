import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import { isLiveWindow, type Launch } from "../lib/launches";
import { rocketSvg } from "../lib/rocket-icon";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  launches: Launch[];
  selectedId: string | null;
  onSelect: (l: Launch) => void;
}

/** Labelled rocket markers on the launch pads of the next missions (one per pad, earliest first). */
export function LaunchPadMarkers({ map, mapLoaded, launches, selectedId, onSelect }: Props) {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const byPad = new Map<string, Launch>();
    for (const l of launches) {
      const key = `${l.pad.lat.toFixed(3)},${l.pad.lon.toFixed(3)}`;
      if (!byPad.has(key) || l.id === selectedId) byPad.set(key, l);
    }
    const markers: maplibregl.Marker[] = [];
    for (const l of byPad.values()) {
      const live = isLiveWindow(l);
      const sel = l.id === selectedId;
      const color = live ? "#f43f5e" : sel ? "#ffffff" : "#22d3ee";
      const el = document.createElement("button");
      el.type = "button";
      el.setAttribute("aria-label", `${l.rocket} launch from ${l.pad.name}`);
      el.style.cssText = `display:flex;align-items:flex-end;gap:6px;background:none;border:none;padding:0;cursor:pointer;font-family:'Share Tech Mono','Courier New',monospace;filter:drop-shadow(0 0 6px ${color}99)`;
      el.innerHTML = `
        <span style="width:14px;height:21px;display:inline-block">${rocketSvg(color, { size: 14, glow: false })}</span>
        <span style="display:flex;flex-direction:column;align-items:flex-start;border-left:2px solid ${color};background:rgba(2,6,12,0.82);padding:2px 6px;margin-bottom:6px">
          <span style="font-size:10px;letter-spacing:.14em;color:${sel ? "#ffffff" : "#a5f3fc"};white-space:nowrap">${l.rocket.toUpperCase()}</span>
          <span style="font-size:8.5px;letter-spacing:.12em;color:rgba(125,249,255,0.6);white-space:nowrap">${live ? "● LIVE" : l.net.slice(0, 10)}</span>
        </span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect(l);
      });
      markers.push(new maplibregl.Marker({ element: el, anchor: "bottom-left", offset: [-7, 0] }).setLngLat([l.pad.lon, l.pad.lat]).addTo(map));
    }
    return () => markers.forEach((m) => m.remove());
  }, [map, mapLoaded, launches, selectedId, onSelect]);

  return null;
}
