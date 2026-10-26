import { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import {
  INFRA_COLORS, formatMw,
  type CableRoute, type Dam, type DataCenter, type InfraLayerId, type InfraSelection, type LandingPoint,
} from "../lib/infrastructure";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  visible: boolean;
  enabled: Record<InfraLayerId, boolean>;
  showLabels: boolean;
  cableColorMode: "uniform" | "operator";
  cables: CableRoute[];
  landings: LandingPoint[];
  datacenters: DataCenter[];
  dams: Dam[];
  selection: InfraSelection | null;
  onSelect: (sel: InfraSelection) => void;
  onView360?: (sel: InfraSelection) => void;
}

const SRC = { cables: "infra-cables", landings: "infra-landings", dc: "infra-dc", dams: "infra-dams", sel: "infra-sel" } as const;
const FONT = ["Noto Sans Regular"];
const HALO = "rgba(2,6,12,0.92)";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const GROUPS: Record<InfraLayerId, string[]> = {
  cables: ["infra-cable-glow", "infra-cable-line", "infra-cable-hover", "infra-cable-sel", "infra-cable-label"],
  landings: ["infra-landing-dot", "infra-landing-label"],
  datacenters: ["infra-dc-halo", "infra-dc-dot", "infra-dc-label"],
  dams: ["infra-dam-major", "infra-dam-mid", "infra-dam-minor", "infra-dam-label-major", "infra-dam-label-minor"],
};
const LABEL_LAYERS = new Set(["infra-cable-label", "infra-landing-label", "infra-dc-label", "infra-dam-label-major", "infra-dam-label-minor"]);
const POINT_LAYERS = ["infra-dam-major", "infra-dam-mid", "infra-dam-minor", "infra-dc-dot", "infra-landing-dot"];
const ALL_LAYERS = Object.values(GROUPS).flat();

/** 3 = landmark (≥500 MW or ≥100 m), 2 = major, 1 = named, 0 = unnamed. Drives zoom-dependent density. */
function damRank(d: Dam) {
  if ((d.mw ?? 0) >= 500 || (d.heightM ?? 0) >= 100) return 3;
  if ((d.mw ?? 0) >= 50 || (d.heightM ?? 0) >= 40) return 2;
  return d.name ? 1 : 0;
}

function point(lon: number, lat: number, properties: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties };
}

/**
 * Renders physical infrastructure as MapLibre layers: cable routes (glow + line + line-following
 * labels), landing stations, data centres and dams with zoom-tiered density so the globe view
 * shows only landmark sites and street zoom shows everything. Click any feature to inspect it.
 */
export function InfrastructureLayer({
  map, mapLoaded, visible, enabled, showLabels, cableColorMode,
  cables, landings, datacenters, dams, selection, onSelect, onView360,
}: Props) {
  const lookup = useMemo(() => {
    const m = new Map<string, InfraSelection>();
    for (const l of landings) m.set(`landing:${l.id}`, { kind: "landing", landing: l });
    for (const d of datacenters) m.set(d.id, { kind: "datacenter", dc: d });
    for (const d of dams) m.set(d.id, { kind: "dam", dam: d });
    return m;
  }, [landings, datacenters, dams]);
  const cableById = useMemo(() => new Map(cables.map((c) => [c.id, c])), [cables]);
  const handlerRefs = useRef({ lookup, cableById, onSelect, onView360 });
  handlerRefs.current = { lookup, cableById, onSelect, onView360 };

  // ── sources + layers ────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    for (const id of Object.values(SRC)) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });

    const add = (spec: maplibregl.LayerSpecification) => { if (!map.getLayer(spec.id)) map.addLayer(spec); };
    const label = (color: string): maplibregl.SymbolLayerSpecification["paint"] => ({
      "text-color": color, "text-halo-color": HALO, "text-halo-width": 1.6,
    });

    add({
      id: "infra-cable-glow", type: "line", source: SRC.cables,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": INFRA_COLORS.cables, "line-blur": 3, "line-opacity": 0.22,
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6, 10, 9],
      },
    });
    add({
      id: "infra-cable-line", type: "line", source: SRC.cables,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": INFRA_COLORS.cables,
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 6, 1.4, 10, 2.4],
      },
    });
    add({
      id: "infra-cable-hover", type: "line", source: SRC.cables, filter: ["==", ["get", "id"], ""],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 10, 3.4] },
    });
    add({
      id: "infra-cable-sel", type: "line", source: SRC.cables, filter: ["==", ["get", "id"], ""],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fde047", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 2.2, 10, 4.2] },
    });
    add({
      id: "infra-cable-label", type: "symbol", source: SRC.cables, minzoom: 3.2,
      layout: {
        "symbol-placement": "line", "symbol-spacing": 420, "text-field": ["get", "name"], "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 8, 11], "text-letter-spacing": 0.08, "text-max-angle": 30,
      },
      paint: label("#a5f3fc"),
    });

    add({
      id: "infra-landing-dot", type: "circle", source: SRC.landings,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 5, 3, 10, 5],
        "circle-color": INFRA_COLORS.landings, "circle-opacity": 0.95,
        "circle-stroke-width": 1, "circle-stroke-color": "#0e7490",
      },
    });
    add({
      id: "infra-landing-label", type: "symbol", source: SRC.landings, minzoom: 4.5,
      layout: {
        "text-field": ["get", "name"], "text-font": FONT, "text-size": 10, "text-anchor": "left",
        "text-offset": [0.7, 0], "text-optional": true,
      },
      paint: label("#e0fbff"),
    });

    add({
      id: "infra-dc-halo", type: "circle", source: SRC.dc, minzoom: 3,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 12, 12], "circle-color": INFRA_COLORS.datacenters, "circle-opacity": 0.16, "circle-blur": 0.7 },
    });
    add({
      id: "infra-dc-dot", type: "circle", source: SRC.dc,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.8, 6, 3.2, 12, 6],
        "circle-color": INFRA_COLORS.datacenters, "circle-opacity": 0.95,
        "circle-stroke-width": 1, "circle-stroke-color": "rgba(20,12,0,0.85)",
      },
    });
    add({
      id: "infra-dc-label", type: "symbol", source: SRC.dc, minzoom: 7, filter: ["!=", ["get", "label"], ""],
      layout: {
        "text-field": ["get", "label"], "text-font": FONT, "text-size": 10, "text-anchor": "left",
        "text-offset": [0.8, 0], "text-optional": true,
      },
      paint: label("#fde7b0"),
    });

    const damDot = (id: string, filter: maplibregl.FilterSpecification, minzoom: number) => add({
      id, type: "circle", source: SRC.dams, minzoom, filter,
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          2, ["+", 1.6, ["*", 0.9, ["get", "rank"]]],
          10, ["+", 3, ["*", 1.6, ["get", "rank"]]],
        ],
        "circle-color": INFRA_COLORS.dams, "circle-opacity": 0.92,
        "circle-stroke-width": 1.2, "circle-stroke-color": "#dbeafe",
      },
    });
    damDot("infra-dam-major", [">=", ["get", "rank"], 3], 0);
    damDot("infra-dam-mid", ["==", ["get", "rank"], 2], 3.5);
    damDot("infra-dam-minor", ["<=", ["get", "rank"], 1], 6.5);
    add({
      id: "infra-dam-label-major", type: "symbol", source: SRC.dams, minzoom: 3.5,
      filter: ["all", [">=", ["get", "rank"], 2], ["!=", ["get", "label"], ""]],
      layout: {
        "text-field": ["get", "label"], "text-font": FONT, "text-size": 10, "text-anchor": "bottom",
        "text-offset": [0, -0.9], "symbol-sort-key": ["-", 0, ["get", "mw"]], "text-optional": true,
      },
      paint: label("#dbeafe"),
    });
    add({
      id: "infra-dam-label-minor", type: "symbol", source: SRC.dams, minzoom: 8.5,
      filter: ["all", ["<=", ["get", "rank"], 1], ["!=", ["get", "label"], ""]],
      layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 9.5, "text-anchor": "bottom", "text-offset": [0, -0.8], "text-optional": true },
      paint: label("#bfdbfe"),
    });

    add({
      id: "infra-sel-ring", type: "circle", source: SRC.sel,
      paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2, "circle-stroke-color": "#fde047" },
    });

    return () => {
      if (!map.style) return;
      for (const id of [...ALL_LAYERS, "infra-sel-ring"]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of Object.values(SRC)) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map, mapLoaded]);

  // ── data ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC.cables) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: cables.map((c) => ({
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates: c.lines },
        properties: { id: c.id, name: c.name, color: c.color },
      })),
    });
  }, [map, mapLoaded, cables]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC.landings) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: landings.map((l) => point(l.lon, l.lat, { key: `landing:${l.id}`, name: l.name })),
    });
  }, [map, mapLoaded, landings]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC.dc) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: datacenters.map((d) => point(d.lon, d.lat, {
        key: d.id,
        label: d.name ?? d.operator ?? "",
      })),
    });
  }, [map, mapLoaded, datacenters]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC.dams) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: dams.map((d) => point(d.lon, d.lat, {
        key: d.id,
        rank: damRank(d),
        mw: d.mw ?? 0,
        label: d.name ? (d.mw ? `${d.name} · ${formatMw(d.mw)}` : d.name) : "",
      })),
    });
  }, [map, mapLoaded, dams]);

  // ── styling / visibility ────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded || !map.getLayer("infra-cable-line")) return;
    const color = cableColorMode === "operator" ? ["get", "color"] : INFRA_COLORS.cables;
    map.setPaintProperty("infra-cable-line", "line-color", color);
    map.setPaintProperty("infra-cable-glow", "line-color", color);
  }, [map, mapLoaded, cableColorMode]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    for (const [group, ids] of Object.entries(GROUPS) as [InfraLayerId, string[]][]) {
      for (const id of ids) {
        if (!map.getLayer(id)) continue;
        const on = visible && enabled[group] && (showLabels || !LABEL_LAYERS.has(id));
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    }
    if (map.getLayer("infra-sel-ring")) map.setLayoutProperty("infra-sel-ring", "visibility", visible ? "visible" : "none");
  }, [map, mapLoaded, visible, enabled, showLabels]);

  useEffect(() => {
    if (!map || !mapLoaded || !map.getLayer("infra-cable-sel")) return;
    map.setFilter("infra-cable-sel", ["==", ["get", "id"], selection?.kind === "cable" ? selection.cable.id : ""]);
    const pos =
      selection?.kind === "landing" ? selection.landing
        : selection?.kind === "datacenter" ? selection.dc
          : selection?.kind === "dam" ? selection.dam
            : null;
    (map.getSource(SRC.sel) as maplibregl.GeoJSONSource | undefined)?.setData(
      pos ? { type: "FeatureCollection", features: [point(pos.lon, pos.lat, {})] } : EMPTY,
    );
  }, [map, mapLoaded, selection]);

  // ── interaction: points win over cables; cables get a few px of hit slop ──
  useEffect(() => {
    if (!map || !mapLoaded || !visible) return;
    const canvas = map.getCanvas();
    const box = (p: maplibregl.Point, r: number): [maplibregl.PointLike, maplibregl.PointLike] => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
    const present = (ids: string[]) => ids.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");

    const hit = (p: maplibregl.Point) => {
      const pts = present(POINT_LAYERS);
      const pf = pts.length ? map.queryRenderedFeatures(box(p, 4), { layers: pts }) : [];
      if (pf.length) return { point: pf[0] };
      const cl = present(["infra-cable-line"]);
      const cf = cl.length ? map.queryRenderedFeatures(box(p, 5), { layers: cl }) : [];
      return cf.length ? { cable: cf[0] } : null;
    };

    let hoverId = "";
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const h = hit(e.point);
      const nextHover = (h?.cable?.properties?.id as string | undefined) ?? "";
      if (nextHover !== hoverId && map.getLayer("infra-cable-hover")) {
        hoverId = nextHover;
        map.setFilter("infra-cable-hover", ["==", ["get", "id"], hoverId]);
      }
      if (h) canvas.style.cursor = "pointer";
      else if (canvas.style.cursor === "pointer" && !hoverId) canvas.style.cursor = "";
    };
    const onLeave = () => {
      hoverId = "";
      if (map.getLayer("infra-cable-hover")) map.setFilter("infra-cable-hover", ["==", ["get", "id"], ""]);
    };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const h = hit(e.point);
      if (!h) return;
      const { lookup: lk, cableById: cb, onSelect: select } = handlerRefs.current;
      if (h.point) {
        const sel = lk.get(h.point.properties?.key as string);
        if (sel) select(sel);
        return;
      }
      const c = cb.get(h.cable?.properties?.id as string);
      if (c) select({ kind: "cable", cable: { id: c.id, name: c.name, color: c.color }, lon: e.lngLat.lng, lat: e.lngLat.lat });
    };

    // Double-click a dam / data centre / landing → 360° orbit over photorealistic 3D tiles.
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      const h = hit(e.point);
      if (!h?.point) return;
      const sel = handlerRefs.current.lookup.get(h.point.properties?.key as string);
      if (!sel) return;
      e.preventDefault();
      handlerRefs.current.onView360?.(sel);
    };

    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    map.on("click", onClick);
    map.on("dblclick", onDblClick);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", onLeave);
      map.off("click", onClick);
      map.off("dblclick", onDblClick);
      onLeave();
    };
  }, [map, mapLoaded, visible]);

  return null;
}
