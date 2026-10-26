import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import { apiBase } from "../lib/cctv";
import {
  buildConnections,
  isLeftHandTraffic,
  lanesFromOsm,
  lanesFromTomTom,
  levelColor,
  matchFlow,
  reconcileVehicles,
  simulatedLevel,
  stepVehicles,
  summarize,
  vehiclePosition,
  type Bounds,
  type Lane,
  type RoadMode,
  type TrafficStats,
  type Vehicle,
  type VehicleKind,
} from "../lib/traffic";

const FLOW_SRC = "wv-traffic-flow";
const FLOW_SOURCE_LAYER = "Traffic flow";
const FLOW_LAYER = "wv-traffic-flow-lines";
const ROADS_SRC = "wv-traffic-roads";
const ROADS_LAYER = "wv-traffic-road-lines";
const VEH_SRC = "wv-traffic-vehicles";
const VEH_DOTS = "wv-traffic-veh-dots";
const VEH_ICONS = "wv-traffic-veh-icons";
const VEH_LABELS = "wv-traffic-veh-labels";
const ALL_LAYERS = [VEH_LABELS, VEH_ICONS, VEH_DOTS, ROADS_LAYER, FLOW_LAYER];

const MIN_ZOOM = 13.5;
const ICON_ZOOM = 15.5;
const LABEL_ZOOM = 16.5;
const LIVE_REFRESH_MS = 120_000;
const SIM_REFRESH_MS = 30_000;
const FRAME_MS = 50;
const REBUILD_DEBOUNCE_MS = 350;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  visible: boolean;
  live: boolean;
  roadMode: RoadMode;
  showFlow: boolean;
  showLabels: boolean;
  density: number;
  onStats?: (stats: TrafficStats) => void;
}

const VEHICLE_SHAPES: Record<VehicleKind, [number, number]> = {
  car: [9, 18],
  truck: [10, 30],
  bus: [10, 32],
  moto: [5, 10],
};

/** Top-down vehicle silhouettes (pointing north) as SDF images so each vehicle is tinted by its flow colour. */
function addVehicleImages(map: maplibregl.Map) {
  for (const [kind, [w, h]] of Object.entries(VEHICLE_SHAPES) as [VehicleKind, [number, number]][]) {
    const id = `wv-veh-${kind}`;
    if (map.hasImage(id)) continue;
    const pad = 3;
    const canvas = document.createElement("canvas");
    canvas.width = w + pad * 2;
    canvas.height = h + pad * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.fillStyle = "#fff";
    const r = Math.min(w / 2, 3);
    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, r);
    ctx.fill();
    // Windscreen notch so heading reads at a glance.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(pad + 1.5, pad + h * 0.2, w - 3, Math.max(1.5, h * 0.12));
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    map.addImage(id, { width: canvas.width, height: canvas.height, data: new Uint8Array(data.data.buffer) }, { sdf: true, pixelRatio: 2 });
  }
}

function flowTileUrl(): string {
  const bucket = Math.floor(Date.now() / LIVE_REFRESH_MS);
  const base = new URL(`${apiBase()}/api/proxy/traffic/flow/`, window.location.href).toString();
  return `${base}{z}/{x}/{y}.pbf?v=${bucket}`;
}

function paddedBounds(map: maplibregl.Map, pad: number): Bounds {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * pad;
  const dy = (b.getNorth() - b.getSouth()) * pad;
  return { west: b.getWest() - dx, east: b.getEast() + dx, south: b.getSouth() - dy, north: b.getNorth() + dy };
}

function firstSymbolLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
}

const levelColorExpr = (prop: string): maplibregl.ExpressionSpecification => [
  "step",
  ["to-number", ["get", prop], 1],
  "#ff2d55",
  0.25,
  "#ff9500",
  0.5,
  "#ffd60a",
  0.75,
  "#34d399",
];

/**
 * Live street traffic: TomTom flow tiles (via our proxy) drawn as congestion lines, plus vehicles
 * animated along every road lane at the lane's flow speed. Without a key, or for roads TomTom
 * doesn't cover, lanes come from basemap roads with simulated flow.
 */
export function TrafficLayer({ map, mapLoaded, visible, live, roadMode, showFlow, showLabels, density, onStats }: Props) {
  const lanesRef = useRef<Lane[]>([]);
  const vehiclesRef = useRef<Vehicle[]>([]);
  const connectionsRef = useRef<Map<string, Lane[]>>(new Map());
  const updatedAtRef = useRef<number | null>(null);
  const statusRef = useRef<TrafficStats["status"]>("hidden");
  const optsRef = useRef({ live, roadMode, showLabels, density });
  optsRef.current = { live, roadMode, showLabels, density };
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  // ── static sources + layers ─────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    addVehicleImages(map);
    const before = firstSymbolLayer(map);
    if (!map.getSource(ROADS_SRC)) map.addSource(ROADS_SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(VEH_SRC)) map.addSource(VEH_SRC, { type: "geojson", data: EMPTY });

    const sideOffset: maplibregl.ExpressionSpecification = [
      "interpolate", ["linear"], ["zoom"],
      12, ["*", ["get", "o"], 1],
      16, ["*", ["get", "o"], 3],
      19, ["*", ["get", "o"], 9],
    ];
    if (!map.getLayer(ROADS_LAYER)) {
      map.addLayer(
        {
          id: ROADS_LAYER,
          type: "line",
          source: ROADS_SRC,
          minzoom: MIN_ZOOM,
          layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "c"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 2.2, 19, 5],
            "line-opacity": ["case", ["==", ["get", "f"], "sim"], 0.35, 0.6],
            "line-offset": sideOffset,
          },
        },
        before,
      );
    }
    if (!map.getLayer(VEH_DOTS)) {
      map.addLayer({
        id: VEH_DOTS,
        type: "circle",
        source: VEH_SRC,
        minzoom: MIN_ZOOM,
        maxzoom: ICON_ZOOM,
        layout: { visibility: "none" },
        paint: {
          "circle-color": ["get", "c"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.5, 1.4, 15.5, 2.6],
          "circle-opacity": 0.95,
          "circle-stroke-color": "rgba(2,4,8,0.8)",
          "circle-stroke-width": 0.6,
        },
      });
    }
    if (!map.getLayer(VEH_ICONS)) {
      map.addLayer({
        id: VEH_ICONS,
        type: "symbol",
        source: VEH_SRC,
        minzoom: ICON_ZOOM,
        layout: {
          visibility: "none",
          "icon-image": ["concat", "wv-veh-", ["get", "k"]],
          "icon-rotate": ["get", "b"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["exponential", 2], ["zoom"], 15.5, 0.5, 18, 1, 21, 6],
        },
        paint: {
          "icon-color": ["get", "c"],
          "icon-halo-color": "rgba(2,4,8,0.85)",
          "icon-halo-width": 1,
        },
      });
    }
    if (!map.getLayer(VEH_LABELS)) {
      map.addLayer({
        id: VEH_LABELS,
        type: "symbol",
        source: VEH_SRC,
        minzoom: LABEL_ZOOM,
        filter: ["has", "l"],
        layout: {
          visibility: "none",
          "text-field": ["get", "l"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-anchor": "top",
          "text-offset": [0, 1.1],
          "text-padding": 1,
          "text-line-height": 1.15,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#d8fbff",
          "text-halo-color": "rgba(2,4,8,0.95)",
          "text-halo-width": 1.4,
        },
      });
    }

    return () => {
      if (!map.getStyle()) return;
      for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [FLOW_SRC, ROADS_SRC, VEH_SRC]) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map, mapLoaded]);

  // ── TomTom flow vector source (live only) ──────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    if (!live) {
      if (map.getLayer(FLOW_LAYER)) map.removeLayer(FLOW_LAYER);
      if (map.getSource(FLOW_SRC)) map.removeSource(FLOW_SRC);
      return;
    }
    if (!map.getSource(FLOW_SRC)) {
      map.addSource(FLOW_SRC, {
        type: "vector",
        tiles: [flowTileUrl()],
        minzoom: 10,
        maxzoom: 16,
        attribution: "Traffic © TomTom",
      });
    }
    if (!map.getLayer(FLOW_LAYER)) {
      map.addLayer(
        {
          id: FLOW_LAYER,
          type: "line",
          source: FLOW_SRC,
          "source-layer": FLOW_SOURCE_LAYER,
          minzoom: 10,
          layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["case", ["to-boolean", ["get", "road_closure"]], "#9b1c31", levelColorExpr("traffic_level")],
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2, 18, 5],
            "line-opacity": 0.65,
            "line-offset": [
              "interpolate", ["linear"], ["zoom"],
              12, ["case", ["==", ["get", "traffic_road_coverage"], "one_side"], ["case", ["to-boolean", ["get", "left_hand_traffic"]], -1, 1], 0],
              19, ["case", ["==", ["get", "traffic_road_coverage"], "one_side"], ["case", ["to-boolean", ["get", "left_hand_traffic"]], -9, 9], 0],
            ],
          },
        },
        map.getLayer(ROADS_LAYER) ? ROADS_LAYER : firstSymbolLayer(map),
      );
    }
    const timer = setInterval(() => {
      (map.getSource(FLOW_SRC) as maplibregl.VectorTileSource | undefined)?.setTiles([flowTileUrl()]);
      updatedAtRef.current = Date.now();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [map, mapLoaded, live]);

  // ── visibility ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    // The flow layer must stay rendered for its tiles to load (OSM mode still matches flow from
    // them), so OSM mode hides it with opacity instead of visibility.
    vis(FLOW_LAYER, visible && live);
    if (map.getLayer(FLOW_LAYER)) {
      map.setPaintProperty(FLOW_LAYER, "line-opacity", showFlow && roadMode !== "osm" ? 0.65 : 0);
    }
    vis(ROADS_LAYER, visible && showFlow);
    vis(VEH_DOTS, visible);
    vis(VEH_ICONS, visible);
    vis(VEH_LABELS, visible && showLabels);
  }, [map, mapLoaded, visible, live, roadMode, showFlow, showLabels]);

  // ── lane rebuild + animation loop ───────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded || !visible) {
      lanesRef.current = [];
      vehiclesRef.current = [];
      statusRef.current = "hidden";
      return;
    }
    let raf = 0;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFrame = performance.now();
    let lastPush = 0;
    let lastStats = 0;

    const emitStats = () => {
      const { live: isLive, roadMode: mode } = optsRef.current;
      onStatsRef.current?.({
        mode: isLive ? "live" : "simulation",
        roadMode: mode,
        status: statusRef.current,
        updatedAt: updatedAtRef.current,
        ...summarize(lanesRef.current, vehiclesRef.current),
      });
    };

    const rebuild = () => {
      rebuildTimer = null;
      const { live: isLive, roadMode: mode, density: dens } = optsRef.current;
      if (map.getZoom() < MIN_ZOOM) {
        lanesRef.current = [];
        vehiclesRef.current = [];
        connectionsRef.current = new Map();
        statusRef.current = "zoom-in";
        (map.getSource(ROADS_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
        (map.getSource(VEH_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
        emitStats();
        return;
      }
      const bounds = paddedBounds(map, 0.15);
      const center = map.getCenter();
      const now = new Date();

      const tomtom =
        isLive && map.getSource(FLOW_SRC)
          ? lanesFromTomTom(map.querySourceFeatures(FLOW_SRC, { sourceLayer: FLOW_SOURCE_LAYER }) as GeoJSON.Feature[], bounds)
          : [];
      const leftHand = tomtom.length > 0 ? tomtom.filter((l) => l.leftHand).length > tomtom.length / 2 : isLeftHandTraffic(center.lng, center.lat);
      const needOsm = !isLive || mode !== "tomtom";
      const osm =
        needOsm && map.getSource("openmaptiles")
          ? lanesFromOsm(map.querySourceFeatures("openmaptiles", { sourceLayer: "transportation" }) as GeoJSON.Feature[], bounds, leftHand)
          : [];
      if (isLive && osm.length) matchFlow(osm, tomtom);
      for (const lane of osm) if (lane.flow === "sim") lane.level = simulatedLevel(lane, now);

      let lanes: Lane[];
      if (!isLive) lanes = osm;
      else if (mode === "tomtom") lanes = tomtom;
      else if (mode === "osm") lanes = osm;
      else lanes = [...tomtom, ...osm.filter((l) => l.flow === "sim")];

      lanesRef.current = lanes;
      connectionsRef.current = buildConnections(lanes);
      vehiclesRef.current = reconcileVehicles(vehiclesRef.current, lanes, dens);
      if (updatedAtRef.current === null || !isLive) updatedAtRef.current = Date.now();
      statusRef.current = lanes.length ? "ready" : "loading";

      const roadFeatures: GeoJSON.Feature[] = [];
      for (const l of lanes) {
        if (l.flow === "live") continue;
        roadFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: l.coords },
          properties: { c: levelColor(l.level, l.closed), f: l.flow, o: l.sideOffsetM > 0 ? (l.leftHand ? -1 : 1) : 0 },
        });
      }
      (map.getSource(ROADS_SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: roadFeatures });
      emitStats();
    };

    const scheduleRebuild = () => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuild, REBUILD_DEBOUNCE_MS);
    };

    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if ((e.sourceId === FLOW_SRC || e.sourceId === "openmaptiles") && e.isSourceLoaded) scheduleRebuild();
    };

    const pushFrame = () => {
      const zoom = map.getZoom();
      const withLabels = optsRef.current.showLabels && zoom >= LABEL_ZOOM;
      const view = paddedBounds(map, 0.05);
      const features: GeoJSON.Feature[] = [];
      for (const v of vehiclesRef.current) {
        const p = vehiclePosition(v);
        if (p.lon < view.west || p.lon > view.east || p.lat < view.south || p.lat > view.north) continue;
        const props: Record<string, unknown> = { c: levelColor(v.lane.level, v.lane.closed), k: v.kind, b: p.bearing };
        if (withLabels) props.l = `${v.label}\n${Math.round(p.kmh)} km/h`;
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: props });
      }
      (map.getSource(VEH_SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
    };

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.25, (t - lastFrame) / 1000);
      lastFrame = t;
      if (vehiclesRef.current.length) stepVehicles(vehiclesRef.current, dt, connectionsRef.current);
      if (t - lastPush >= FRAME_MS) {
        lastPush = t;
        pushFrame();
      }
      if (t - lastStats >= 1000) {
        lastStats = t;
        emitStats();
      }
    };

    map.on("moveend", scheduleRebuild);
    map.on("sourcedata", onSourceData);
    const refresh = setInterval(rebuild, optsRef.current.live ? LIVE_REFRESH_MS / 4 : SIM_REFRESH_MS);
    statusRef.current = "loading";
    rebuild();
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(refresh);
      if (rebuildTimer) clearTimeout(rebuildTimer);
      map.off("moveend", scheduleRebuild);
      map.off("sourcedata", onSourceData);
      if (map.getStyle()) {
        (map.getSource(VEH_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
        (map.getSource(ROADS_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
      }
    };
  }, [map, mapLoaded, visible, live, roadMode, density]);

  return null;
}
