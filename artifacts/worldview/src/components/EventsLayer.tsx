import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { eventFallbackImage, eventImage, SOURCE_META, type Correlation, type WorldEvent } from "../lib/events";
import { EventDetailCard } from "./EventDetailCard";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  events: WorldEvent[];
  correlations: Map<string, Correlation>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFly: (e: WorldEvent) => void;
}

const SRC_AREAS = "wev-areas";
const LAYERS = ["wev-area-fill", "wev-area-line", "wev-area-hot"] as const;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const colorExpr: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "source"],
  "gdelt", SOURCE_META.gdelt.color,
  "notam", SOURCE_META.notam.color,
  "maritime", SOURCE_META.maritime.color,
  "usgs", SOURCE_META.usgs.color,
  "#e6fdff",
];

const BADGE: Record<WorldEvent["source"], string> = { gdelt: "N", notam: "A", maritime: "M", usgs: "Q" };

interface MarkerEntry {
  marker: maplibregl.Marker;
  el: HTMLButtonElement;
}

function buildMarkerEl(e: WorldEvent, onClick: () => void): HTMLButtonElement {
  const meta = SOURCE_META[e.source];
  const size = 28 + e.severity * 3;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "wev-marker";
  el.style.setProperty("--wev-size", `${size}px`);
  el.style.setProperty("--wev-accent", meta.color);
  el.dataset.z = String(e.severity * 10);
  el.style.zIndex = el.dataset.z;
  el.setAttribute("aria-label", `${meta.short}: ${e.title}`);
  el.title = e.title;

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.src = eventImage(e);
  img.addEventListener("error", () => {
    const fb = eventFallbackImage(e);
    if (!img.src.endsWith(fb)) img.src = fb;
  });

  const badge = document.createElement("span");
  badge.className = "wev-marker-badge";
  badge.textContent = BADGE[e.source];

  el.append(img, badge);
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return el;
}

/** Open-web events on the globe: photo-thumbnail markers, airspace / maritime zones as outlined polygons. */
export function EventsLayer({ map, mapLoaded, events, correlations, selectedId, onSelect, onFly }: Props) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const markersRef = useRef(new Map<string, MarkerEntry>());

  useEffect(() => {
    if (!map || !mapLoaded) return;
    if (!map.getSource(SRC_AREAS)) map.addSource(SRC_AREAS, { type: "geojson", data: EMPTY });
    const add = (spec: maplibregl.LayerSpecification) => {
      if (!map.getLayer(spec.id)) map.addLayer(spec);
    };
    add({ id: "wev-area-fill", type: "fill", source: SRC_AREAS, paint: { "fill-color": colorExpr, "fill-opacity": ["case", ["==", ["get", "hot"], true], 0.2, 0.07] } });
    add({
      id: "wev-area-line", type: "line", source: SRC_AREAS,
      paint: { "line-color": colorExpr, "line-width": 1.2, "line-opacity": 0.75, "line-dasharray": [3, 2] },
    });
    add({
      id: "wev-area-hot", type: "line", source: SRC_AREAS, filter: ["==", ["get", "hot"], true],
      paint: { "line-color": "#fde047", "line-width": 2, "line-blur": 1.5, "line-opacity": 0.9 },
    });

    const click = (e: maplibregl.MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") onSelectRef.current(id);
    };
    const enter = () => (map.getCanvas().style.cursor = "pointer");
    const leave = () => (map.getCanvas().style.cursor = "");
    map.on("click", "wev-area-fill", click);
    map.on("mouseenter", "wev-area-fill", enter);
    map.on("mouseleave", "wev-area-fill", leave);

    const markers = markersRef.current;
    return () => {
      map.off("click", "wev-area-fill", click);
      map.off("mouseenter", "wev-area-fill", enter);
      map.off("mouseleave", "wev-area-fill", leave);
      for (const { marker } of markers.values()) marker.remove();
      markers.clear();
      if (!map.style) return;
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC_AREAS)) map.removeSource(SRC_AREAS);
    };
  }, [map, mapLoaded]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC_AREAS) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: events
        .filter((e) => e.polygon && e.polygon.length >= 4)
        .map((e) => ({
          type: "Feature",
          properties: { id: e.id, source: e.source, hot: correlations.has(e.id) },
          geometry: { type: "Polygon", coordinates: [e.polygon!] },
        })),
    });

    const markers = markersRef.current;
    const live = new Set(events.map((e) => e.id));
    for (const [id, { marker }] of markers) {
      if (!live.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
    for (const e of events) {
      let entry = markers.get(e.id);
      if (!entry) {
        const el = buildMarkerEl(e, () => onSelectRef.current(e.id));
        const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([e.lon, e.lat]).addTo(map);
        entry = { marker, el };
        markers.set(e.id, entry);
      }
      entry.el.classList.toggle("is-hot", correlations.has(e.id));
    }
  }, [map, mapLoaded, events, correlations]);

  useEffect(() => {
    for (const [id, { el }] of markersRef.current) {
      const sel = id === selectedId;
      el.classList.toggle("is-selected", sel);
      el.setAttribute("aria-pressed", String(sel));
      el.style.zIndex = sel ? "999" : (el.dataset.z ?? "10");
    }
  }, [selectedId, events]);

  const selected = selectedId ? events.find((e) => e.id === selectedId) : undefined;
  if (!map || !mapLoaded || !selected) return null;
  return (
    <EventDetailCard
      key={selected.id}
      map={map}
      event={selected}
      correlation={correlations.get(selected.id)}
      onClose={() => onSelectRef.current(null)}
      onFly={onFly}
    />
  );
}
