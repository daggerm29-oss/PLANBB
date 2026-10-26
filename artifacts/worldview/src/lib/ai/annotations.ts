import type maplibregl from "maplibre-gl";
import type { LngLat } from "./geo";

/**
 * AI-drawn overlays (pins, labels, routes, measure lines, polygons, circles) on one GeoJSON source.
 * Layers are re-added after style reloads; the feature list lives here so it survives.
 */

export type AnnotationKind = "pin" | "line" | "polygon";

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  label: string;
  color: string;
  coords: LngLat[] | LngLat[][] | LngLat[][][];
  /** Extra metadata echoed back to the model (distance, duration…). */
  meta?: Record<string, unknown>;
}

const SRC = "ai-annotations";
const LAYERS = ["ai-ann-fill", "ai-ann-outline", "ai-ann-line-glow", "ai-ann-line", "ai-ann-pin-halo", "ai-ann-pin", "ai-ann-label"] as const;

const store = new Map<string, Annotation>();
let seq = 0;
let boundMap: maplibregl.Map | null = null;

export const annotationColors = { default: "#ffd60a", route: "#39ff88", measure: "#ff9f0a", region: "#ffd60a", hazard: "#ff453a", entity: "#64d2ff" };

export function newAnnotationId(prefix = "ann") {
  seq += 1;
  return `${prefix}-${seq}`;
}

function toFeatures(): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const a of store.values()) {
    const props = { id: a.id, label: a.label, color: a.color, kind: a.kind };
    if (a.kind === "pin") {
      out.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: (a.coords as LngLat[])[0] } });
    } else if (a.kind === "line") {
      const line = a.coords as LngLat[];
      out.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: line } });
      if (a.label) out.push({ type: "Feature", properties: { ...props, kind: "line-label" }, geometry: { type: "Point", coordinates: line[Math.floor(line.length / 2)] } });
    } else {
      const c = a.coords as LngLat[][] | LngLat[][][];
      const isMulti = Array.isArray(c[0]?.[0]?.[0]);
      out.push({
        type: "Feature",
        properties: props,
        geometry: isMulti ? { type: "MultiPolygon", coordinates: c as LngLat[][][] } : { type: "Polygon", coordinates: c as LngLat[][] },
      });
    }
  }
  return out;
}

// map.isStyleLoaded() is false whenever ANY source is still fetching (live aircraft/ship feeds, tiles during a
// flyTo), which is most of the time. Only the style document itself has to be parsed to add sources/layers.
function styleReady(map: maplibregl.Map) {
  const style = map.style as unknown as { _loaded?: boolean } | undefined;
  return !!style && (style._loaded ?? map.isStyleLoaded());
}

function ensureLayers(map: maplibregl.Map) {
  if (!styleReady(map)) return false;
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Large countries/states often come back from Nominatim as MultiPolygon / MultiLineString.
  const polyFilter: maplibregl.FilterSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
  const lineFilter: maplibregl.FilterSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
  const pinFilter: maplibregl.FilterSpecification = ["==", ["get", "kind"], "pin"];
  const add = (spec: maplibregl.LayerSpecification) => { if (!map.getLayer(spec.id)) map.addLayer(spec); };
  add({ id: "ai-ann-fill", type: "fill", source: SRC, filter: polyFilter, paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 } });
  add({ id: "ai-ann-outline", type: "line", source: SRC, filter: polyFilter, paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [3, 2] } });
  add({ id: "ai-ann-line-glow", type: "line", source: SRC, filter: lineFilter, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 9, "line-opacity": 0.25, "line-blur": 4 } });
  add({ id: "ai-ann-line", type: "line", source: SRC, filter: lineFilter, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 3 } });
  add({ id: "ai-ann-pin-halo", type: "circle", source: SRC, filter: pinFilter, paint: { "circle-radius": 13, "circle-color": ["get", "color"], "circle-opacity": 0.18, "circle-blur": 0.6 } });
  add({ id: "ai-ann-pin", type: "circle", source: SRC, filter: pinFilter, paint: { "circle-radius": 5.5, "circle-color": ["get", "color"], "circle-stroke-color": "#020408", "circle-stroke-width": 2 } });
  add({
    id: "ai-ann-label",
    type: "symbol",
    source: SRC,
    filter: ["any", pinFilter, ["==", ["get", "kind"], "line-label"], ["==", ["get", "kind"], "polygon"]],
    layout: {
      "text-field": ["get", "label"],
      "text-size": 13,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-allow-overlap": true,
      "text-font": ["Noto Sans Regular"],
      "symbol-placement": "point",
    },
    paint: { "text-color": ["get", "color"], "text-halo-color": "#020408", "text-halo-width": 2 },
  });
  return true;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function sync() {
  const map = boundMap;
  if (!map) return;
  let ready = false;
  try {
    ready = ensureLayers(map);
    if (ready) {
      (map.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: toFeatures() });
      for (const id of LAYERS) if (map.getLayer(id)) map.moveLayer(id);
    }
  } catch (e) {
    console.warn("[worldview] annotation sync failed, retrying", e);
    ready = false;
  }
  // Never drop an update: retry until the style (e.g. after a vision-mode setStyle) is ready.
  if (!ready && !retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = null; sync(); }, 250);
  }
}

const onStyle = () => sync();

export function bindAnnotations(map: maplibregl.Map | null) {
  if (boundMap === map) return;
  boundMap?.off("styledata", onStyle);
  boundMap = map;
  map?.on("styledata", onStyle);
  sync();
}

export function addAnnotation(a: Omit<Annotation, "id"> & { id?: string }): Annotation {
  const full: Annotation = { ...a, id: a.id ?? newAnnotationId(a.kind) };
  store.set(full.id, full);
  sync();
  return full;
}

export function removeAnnotation(id: string) {
  const ok = store.delete(id);
  sync();
  return ok;
}

export function clearAnnotations() {
  const n = store.size;
  store.clear();
  sync();
  return n;
}

export function getAnnotation(id: string) {
  return store.get(id);
}

export function listAnnotations() {
  return [...store.values()].map((a) => ({ id: a.id, kind: a.kind, label: a.label, ...(a.meta ?? {}) }));
}

/** Last drawn line (for "fly the route"). */
export function lastLine(): Annotation | undefined {
  return [...store.values()].reverse().find((a) => a.kind === "line");
}
