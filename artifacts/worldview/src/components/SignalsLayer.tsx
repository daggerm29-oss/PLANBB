import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { JamPayload, RadarFrame, SignalLayers, Strike } from "../lib/signals";

const SRC_JAM = "sig-jam";
const SRC_RADAR = "sig-radar";
const SRC_LIGHTNING = "sig-lightning";
const L_RADAR = "sig-radar-layer";
const L_JAM_FILL = "sig-jam-fill";
const L_JAM_LINE = "sig-jam-line";
const L_STRIKE_GLOW = "sig-strike-glow";
const L_STRIKE = "sig-strike";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  layers: SignalLayers;
  jam: JamPayload | null;
  radarFrame: RadarFrame | null;
  radarOpacity: number;
  strikes: Strike[];
}

/** Map overlays for the Signals & RF layer: GNSS interference hexes, radar mosaic and lightning. */
export function SignalsLayer({ map, mapLoaded, layers, jam, radarFrame, radarOpacity, strikes }: Props) {
  const radarTiles = useRef<string | null>(null);

  // GPS jamming hexes
  useEffect(() => {
    if (!map || !mapLoaded || !layers.jam) return;
    if (!map.getSource(SRC_JAM)) map.addSource(SRC_JAM, { type: "geojson", data: EMPTY });
    if (!map.getLayer(L_JAM_FILL)) {
      map.addLayer({
        id: L_JAM_FILL,
        type: "fill",
        source: SRC_JAM,
        paint: {
          "fill-color": ["match", ["get", "level"], "high", "#ef4444", "#facc15"],
          "fill-opacity": ["interpolate", ["linear"], ["get", "pct"], 2, 0.18, 10, 0.34, 50, 0.5],
        },
      });
    }
    if (!map.getLayer(L_JAM_LINE)) {
      map.addLayer({
        id: L_JAM_LINE,
        type: "line",
        source: SRC_JAM,
        paint: { "line-color": ["match", ["get", "level"], "high", "#fca5a5", "#fde68a"], "line-width": 0.6, "line-opacity": 0.55 },
      });
    }
    const popup = new maplibregl.Popup({ closeButton: false, className: "sig-popup", offset: 8 });
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as { pct: number; level: string; good: number; bad: number } | undefined;
      if (!p) return;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="sig-pop-title" style="color:${p.level === "high" ? "#f87171" : "#facc15"}">GNSS INTERFERENCE · ${p.level.toUpperCase()}</div>` +
            `<div class="sig-pop-row"><b>${p.pct}%</b> of aircraft reported degraded navigation accuracy</div>` +
            `<div class="sig-pop-row">${p.bad} degraded / ${p.good + p.bad} aircraft · source gpsjam.org</div>`,
        )
        .addTo(map);
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", L_JAM_FILL, onClick);
    map.on("mouseenter", L_JAM_FILL, enter);
    map.on("mouseleave", L_JAM_FILL, leave);
    return () => {
      map.off("click", L_JAM_FILL, onClick);
      map.off("mouseenter", L_JAM_FILL, enter);
      map.off("mouseleave", L_JAM_FILL, leave);
      popup.remove();
      if (!map.getStyle()) return;
      for (const id of [L_JAM_LINE, L_JAM_FILL]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC_JAM)) map.removeSource(SRC_JAM);
    };
  }, [map, mapLoaded, layers.jam]);

  useEffect(() => {
    if (!map || !mapLoaded || !layers.jam) return;
    (map.getSource(SRC_JAM) as maplibregl.GeoJSONSource | undefined)?.setData(jam?.geojson ?? EMPTY);
  }, [map, mapLoaded, layers.jam, jam]);

  // Weather radar — one raster source whose tile URL is swapped per frame.
  useEffect(() => {
    if (!map || !mapLoaded || !layers.radar || !radarFrame) return;
    const src = map.getSource(SRC_RADAR) as maplibregl.RasterTileSource | undefined;
    if (!src) {
      // RainViewer's free tiles stop at z7; MapLibre overzooms beyond that.
      map.addSource(SRC_RADAR, { type: "raster", tiles: [radarFrame.tiles], tileSize: 256, maxzoom: 7, attribution: "Radar © RainViewer" });
      const firstSignal = map.getLayer(L_JAM_FILL) ? L_JAM_FILL : undefined;
      map.addLayer({ id: L_RADAR, type: "raster", source: SRC_RADAR, paint: { "raster-opacity": radarOpacity, "raster-fade-duration": 0 } }, firstSignal);
      radarTiles.current = radarFrame.tiles;
    } else if (radarTiles.current !== radarFrame.tiles) {
      src.setTiles([radarFrame.tiles]);
      radarTiles.current = radarFrame.tiles;
    }
  }, [map, mapLoaded, layers.radar, radarFrame, radarOpacity]);

  useEffect(() => {
    if (!map || !mapLoaded || !map.getLayer(L_RADAR)) return;
    map.setPaintProperty(L_RADAR, "raster-opacity", radarOpacity);
  }, [map, mapLoaded, radarOpacity, radarFrame]);

  useEffect(() => {
    if (!map || !mapLoaded || !layers.radar) return;
    return () => {
      if (!map.getStyle()) return;
      if (map.getLayer(L_RADAR)) map.removeLayer(L_RADAR);
      if (map.getSource(SRC_RADAR)) map.removeSource(SRC_RADAR);
      radarTiles.current = null;
    };
  }, [map, mapLoaded, layers.radar]);

  // Lightning
  useEffect(() => {
    if (!map || !mapLoaded || !layers.lightning) return;
    if (!map.getSource(SRC_LIGHTNING)) map.addSource(SRC_LIGHTNING, { type: "geojson", data: EMPTY });
    const ageColor: maplibregl.ExpressionSpecification = ["interpolate", ["linear"], ["get", "age"], 0, "#ffffff", 1.5, "#fde047", 6, "#fb923c", 15, "#dc2626"];
    if (!map.getLayer(L_STRIKE_GLOW)) {
      map.addLayer({
        id: L_STRIKE_GLOW,
        type: "circle",
        source: SRC_LIGHTNING,
        filter: ["<", ["get", "age"], 2],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 8, 14], "circle-color": "#fef08a", "circle-opacity": 0.28, "circle-blur": 0.8 },
      });
    }
    if (!map.getLayer(L_STRIKE)) {
      map.addLayer({
        id: L_STRIKE,
        type: "circle",
        source: SRC_LIGHTNING,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 8, 4],
          "circle-color": ageColor,
          "circle-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 1, 15, 0.35],
          "circle-stroke-width": ["case", ["<", ["get", "age"], 2], 1, 0],
          "circle-stroke-color": "#ffffff",
        },
      });
    }
    return () => {
      if (!map.getStyle()) return;
      for (const id of [L_STRIKE, L_STRIKE_GLOW]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC_LIGHTNING)) map.removeSource(SRC_LIGHTNING);
    };
  }, [map, mapLoaded, layers.lightning]);

  useEffect(() => {
    if (!map || !mapLoaded || !layers.lightning) return;
    const now = Date.now();
    (map.getSource(SRC_LIGHTNING) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: strikes.map((s) => ({
        type: "Feature",
        properties: { age: Math.max(0, (now - s.t) / 60000) },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      })),
    });
  }, [map, mapLoaded, layers.lightning, strikes]);

  return null;
}
