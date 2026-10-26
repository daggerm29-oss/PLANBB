import { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import { CCTV_SOURCE_COLORS, type CctvCamera, type CctvSourceId } from "../lib/cctv";
import {
  buildIndex,
  computeViewshed,
  estimatePose,
  makeFrame,
  type Building,
  type CameraPose,
  type CoverageMode,
  type Viewshed,
} from "../lib/viewshed";

export interface ViewshedStats {
  status: "off" | "zoom-in" | "ready";
  mode: CoverageMode;
  cameras: number;
  /** Mean visible fraction across drawn cameras (0–1). */
  meanVisible: number;
  aimed: number;
  occluders: number;
  selected: { pose: CameraPose; visibleFrac: number } | null;
}

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  cameras: CctvCamera[];
  osmCameras: CctvCamera[];
  enabledSources: CctvSourceId[];
  mode: CoverageMode;
  visible: boolean;
  selectedId: string | null;
  onStats: (stats: ViewshedStats) => void;
}

const GROUND_SRC = "cctv-vs-ground";
const BLIND_SRC = "cctv-vs-blind";
const VOLUME_SRC = "cctv-vs-volume";
const LAYERS = ["cctv-vs-buildings", "cctv-vs-blind-fill", "cctv-vs-blind-line", "cctv-vs-ground-fill", "cctv-vs-ground-line", "cctv-vs-volume"];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const MIN_ZOOM: Record<Exclude<CoverageMode, "off">, number> = { cone: 12, viewshed: 13 };
const MAX_CAMERAS: Record<Exclude<CoverageMode, "off">, number> = { cone: 250, viewshed: 120 };
const BLIND_COLOR = "#ff2d55";

/** Buildings from the basemap's own vector tiles act as occluders; no extra network requests. */
function readBuildings(map: maplibregl.Map, bbox: [number, number, number, number]): Building[] {
  if (!map.getSource("openmaptiles")) return [];
  const [w, s, e, n] = bbox;
  const out: Building[] = [];
  const feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "building" });
  for (const f of feats) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const rings of polys) {
      const p0 = rings[0]?.[0];
      if (!p0 || p0[0] < w || p0[0] > e || p0[1] < s || p0[1] > n) continue;
      const h = Number(f.properties?.render_height);
      out.push({ height: Number.isFinite(h) && h > 0 ? h : 8, rings: rings as [number, number][][] });
    }
  }
  return out;
}

function featureCollection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

const polygon = (ring: [number, number][], properties: GeoJSON.GeoJsonProperties): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring] },
  properties,
});

/**
 * Draws each CCTV camera's estimated coverage on the MapLibre map.
 * CONE: nominal frustum footprint. VIEWSHED: footprint clipped by building line-of-sight, blind zones in red,
 * a 3D wedge volume (falls from mount height to the ground at range) and extruded buildings as occluders.
 */
export function CctvViewshedLayer({
  map, mapLoaded, cameras, osmCameras, enabledSources, mode, visible, selectedId, onStats,
}: Props) {
  const enabled = useMemo(() => new Set(enabledSources), [enabledSources]);
  const pool = useMemo(() => {
    const list = cameras.filter((c) => enabled.has(c.source));
    if (enabled.has("osm")) list.push(...osmCameras);
    return list;
  }, [cameras, osmCameras, enabled]);

  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const active = visible && mode !== "off";

  // ── sources + layers ────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    for (const id of [GROUND_SRC, BLIND_SRC, VOLUME_SRC]) {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
    }
    const before = map.getLayer("cctv-osm-clusters") ? "cctv-osm-clusters" : undefined;
    if (!map.getLayer("cctv-vs-buildings") && map.getSource("openmaptiles")) {
      map.addLayer(
        {
          id: "cctv-vs-buildings",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 14,
          layout: { visibility: "none" },
          paint: {
            "fill-extrusion-color": "#13222c",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.85,
          },
        },
        before,
      );
    }
    if (!map.getLayer("cctv-vs-blind-fill")) {
      map.addLayer({
        id: "cctv-vs-blind-fill", type: "fill", source: BLIND_SRC,
        paint: { "fill-color": BLIND_COLOR, "fill-opacity": ["case", ["get", "selected"], 0.3, 0.14] },
      }, before);
    }
    if (!map.getLayer("cctv-vs-blind-line")) {
      map.addLayer({
        id: "cctv-vs-blind-line", type: "line", source: BLIND_SRC,
        paint: { "line-color": BLIND_COLOR, "line-width": 0.8, "line-opacity": 0.55, "line-dasharray": [2, 2] },
      }, before);
    }
    if (!map.getLayer("cctv-vs-ground-fill")) {
      map.addLayer({
        id: "cctv-vs-ground-fill", type: "fill", source: GROUND_SRC,
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "selected"], 0.38, 0.2] },
      }, before);
    }
    if (!map.getLayer("cctv-vs-ground-line")) {
      map.addLayer({
        id: "cctv-vs-ground-line", type: "line", source: GROUND_SRC,
        paint: {
          "line-color": ["case", ["get", "selected"], "#ffffff", ["get", "color"]],
          "line-width": ["case", ["get", "selected"], 1.6, 0.9],
          "line-opacity": 0.85,
        },
      }, before);
    }
    if (!map.getLayer("cctv-vs-volume")) {
      map.addLayer({
        id: "cctv-vs-volume", type: "fill-extrusion", source: VOLUME_SRC,
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.32,
        },
      }, before);
    }
    return () => {
      if (!map.style) return;
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [GROUND_SRC, BLIND_SRC, VOLUME_SRC]) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map, mapLoaded]);

  // ── layer visibility per mode ───────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const set = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    set("cctv-vs-ground-fill", active);
    set("cctv-vs-ground-line", active);
    set("cctv-vs-blind-fill", active && mode === "viewshed");
    set("cctv-vs-blind-line", active && mode === "viewshed");
    set("cctv-vs-volume", active && mode === "viewshed");
    set("cctv-vs-buildings", active && mode === "viewshed");
  }, [map, mapLoaded, active, mode]);

  // ── compute on view / data / tile changes ───────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const setData = (id: string, fc: GeoJSON.FeatureCollection) =>
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    const clear = () => {
      setData(GROUND_SRC, EMPTY);
      setData(BLIND_SRC, EMPTY);
      setData(VOLUME_SRC, EMPTY);
    };

    if (!active) {
      clear();
      onStatsRef.current({ status: "off", mode, cameras: 0, meanVisible: 0, aimed: 0, occluders: 0, selected: null });
      return;
    }
    const m = mode as Exclude<CoverageMode, "off">;

    const run = () => {
      const zoom = map.getZoom();
      const selectedCam = selectedId ? pool.find((c) => c.id === selectedId) : undefined;
      if (zoom < MIN_ZOOM[m]) {
        clear();
        onStatsRef.current({ status: "zoom-in", mode, cameras: 0, meanVisible: 0, aimed: 0, occluders: 0, selected: null });
        return;
      }
      const b = map.getBounds();
      const padLat = (b.getNorth() - b.getSouth()) * 0.15;
      const padLon = (b.getEast() - b.getWest()) * 0.15;
      const w = b.getWest() - padLon;
      const e = b.getEast() + padLon;
      const s = b.getSouth() - padLat;
      const n = b.getNorth() + padLat;
      const center = map.getCenter();

      const inView = pool.filter((c) => c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n);
      inView.sort(
        (a, c) =>
          (a.lat - center.lat) ** 2 + (a.lon - center.lng) ** 2 - ((c.lat - center.lat) ** 2 + (c.lon - center.lng) ** 2),
      );
      const picked = inView.slice(0, MAX_CAMERAS[m]);
      if (selectedCam && !picked.includes(selectedCam)) picked.push(selectedCam);

      const frame = makeFrame(center.lng, center.lat);
      // Occluder bbox: viewport plus the longest camera range (~0.01° ≈ 700 m).
      const buildings = m === "viewshed" ? readBuildings(map, [w - 0.01, s - 0.01, e + 0.01, n + 0.01]) : [];
      const index = buildings.length ? buildIndex(frame, buildings) : null;

      const ground: GeoJSON.Feature[] = [];
      const blind: GeoJSON.Feature[] = [];
      const volume: GeoJSON.Feature[] = [];
      let sumVisible = 0;
      let aimed = 0;
      let selected: ViewshedStats["selected"] = null;
      for (const cam of picked) {
        const pose = estimatePose(cam);
        const vs: Viewshed = computeViewshed(pose, index, frame);
        const isSel = cam.id === selectedId;
        const color = cam.source === "osm" ? CCTV_SOURCE_COLORS.osm : CCTV_SOURCE_COLORS[cam.source] ?? "#00ffff";
        const props = { id: cam.id, color, selected: isSel };
        ground.push(polygon(vs.visibleRing, props));
        if (m === "viewshed") {
          for (const r of vs.blindRings) blind.push(polygon(r, props));
          for (const band of vs.bands) volume.push(polygon(band.ring, { ...props, height: band.height }));
        }
        sumVisible += vs.visibleFrac;
        if (pose.headingDeg !== null) aimed++;
        if (isSel) selected = { pose, visibleFrac: vs.visibleFrac };
      }
      setData(GROUND_SRC, featureCollection(ground));
      setData(BLIND_SRC, featureCollection(blind));
      setData(VOLUME_SRC, featureCollection(volume));
      onStatsRef.current({
        status: "ready",
        mode,
        cameras: picked.length,
        meanVisible: picked.length ? sumVisible / picked.length : 0,
        aimed,
        occluders: buildings.length,
        selected,
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 220);
    };
    // Building tiles stream in after a move; recompute when the basemap's tiles land.
    const onSourceData = (ev: maplibregl.MapSourceDataEvent) => {
      if (m === "viewshed" && ev.sourceId === "openmaptiles" && ev.tile) schedule();
    };

    schedule();
    map.on("moveend", schedule);
    map.on("sourcedata", onSourceData);
    return () => {
      clearTimeout(timer);
      map.off("moveend", schedule);
      map.off("sourcedata", onSourceData);
    };
  }, [map, mapLoaded, active, mode, pool, selectedId]);

  return null;
}
