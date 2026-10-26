import type maplibregl from "maplibre-gl";
import type { BridgeRef, WorldBridge, AircraftLite, PanelId } from "./bridge";
import type { EntityRef } from "../tracked-entity";
import type { VisionMode, FlirPalette } from "../vision-modes";
import type { InfraSelection } from "../infrastructure";
import type { CoverageMode } from "../viewshed";
import { customAirport, nearestAirport, searchAirports } from "../airports";
import {
  circlePolygon,
  fetchRoute,
  flyAlongLine,
  geocode,
  greatCircle,
  haversineKm,
  orbitCamera,
  resolvePoint,
  resolveRegion,
  reverseGeocode,
  stopCameraAnimation,
  lineLengthKm,
  resolvePointPair,
  type LngLat,
  type Region,
} from "./geo";
import { addAnnotation, annotationColors, clearAnnotations, getAnnotation, lastLine, listAnnotations, removeAnnotation } from "./annotations";
import { route3d, ROUTE_3D_MAX_KM } from "../route-3d";
import { correlate, EVENT_SOURCES, filterEvents, relativeAge, requestBrief, SOURCE_META, summarizeDarkShips, type EventSource } from "../events";

export interface ToolOutcome {
  result: unknown;
  /** Short spoken confirmation for action tools (lets the agent skip a follow-up model call). */
  say?: string;
  /** Screenshot (data URL) to hand to the model. */
  image?: string;
}

interface Ctx {
  bridgeRef: BridgeRef;
  base: string;
}

type Args = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const b = (v: unknown) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const lc = (v: string | undefined | null) => (v ?? "").toLowerCase();
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// MapLibre checks `"bearing" in opts` / `"pitch" in opts`, so an explicit `undefined` becomes NaN and
// permanently breaks the transform matrices (every later flyTo/jumpTo throws). Strip undefined keys.
function cam<T extends object>(opts: T): T {
  return Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as T;
}

let lastResults: LngLat[] = [];

const EVENT_SOURCE_ALIAS: Record<string, EventSource | null> = { all: null, news: "gdelt", gdelt: "gdelt", notam: "notam", airspace: "notam", maritime: "maritime", earthquake: "usgs", usgs: "usgs" };

/** The event feed is fetched by the WORLD EVENTS panel; open it (shows the layer too) and wait for the first payload. */
async function ensureEvents(ref: BridgeRef): Promise<WorldBridge | null> {
  const w = ref.current;
  if (!w) return null;
  if (!w.state.panels.events) w.actions.setPanel("events", true);
  if (!w.state.events) await waitFor(ref, (x) => !!x.state.events, 45000);
  return ref.current;
}

async function waitFor(ref: BridgeRef, pred: (w: WorldBridge) => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ref.current && pred(ref.current)) return true;
    await sleep(250);
  }
  return !!ref.current && pred(ref.current);
}

function altFt(a: AircraftLite): number | null {
  if (a.alt_baro === "ground") return 0;
  const v = Number(a.alt_baro);
  return Number.isFinite(v) ? v : null;
}

function callsign(a: AircraftLite) {
  return (a.flight || "").trim() || a.r || a.hex.toUpperCase();
}

function exitSpecialViews(w: WorldBridge, opts: { keepRoute3D?: boolean } = {}) {
  stopCameraAnimation();
  if (!opts.keepRoute3D) route3d.close();
  window.dispatchEvent(new CustomEvent("worldview:cockpit", { detail: { on: false } }));
  if (w.state.tracking) w.actions.clearTracking();
  if (w.state.airportView) w.actions.exitAirport();
  if (w.state.infraSiteOpen) w.actions.exitInfraSite();
  if (w.state.launchReplayOpen) w.actions.exitLaunchReplay();
}

function fitBbox(map: maplibregl.Map, bbox: [number, number, number, number], opts: { pitch?: number; bearing?: number } = {}) {
  const width = bbox[2] - bbox[0];
  if (width > 180 || width < 0) {
    map.flyTo({ center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], zoom: 3, duration: 2500, essential: true });
    return;
  }
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], cam({ padding: 80, maxZoom: 16, duration: 2500, pitch: opts.pitch, bearing: opts.bearing, essential: true }));
}

// Admin areas with remote islands (e.g. Tokyo Metropolis reaches 20°N / 154°E) have a bbox whose
// centre is far from the actual place; framing that box lands in open ocean.
function bboxIsSkewed(bbox: [number, number, number, number], lat: number, lon: number) {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  if (w <= 0 || h <= 0) return false;
  const dx = Math.abs(lon - (bbox[0] + bbox[2]) / 2) / w;
  const dy = Math.abs(lat - (bbox[1] + bbox[3]) / 2) / h;
  return (w > 2 || h > 2) && (dx > 0.25 || dy > 0.25);
}

function bboxOf(points: LngLat[]): [number, number, number, number] | null {
  if (!points.length) return null;
  let a = Infinity, bb = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of points) { a = Math.min(a, x); bb = Math.min(bb, y); c = Math.max(c, x); d = Math.max(d, y); }
  if (c - a < 0.01) { a -= 0.02; c += 0.02; }
  if (d - bb < 0.01) { bb -= 0.02; d += 0.02; }
  return [a, bb, c, d];
}

async function regionFrom(w: WorldBridge, args: Args, defaultRadius?: number): Promise<Region | null | "unresolved"> {
  const place = s(args.region);
  const radiusKm = n(args.radius_km) ?? (place && !/^(view|current view|here)$/i.test(place) ? defaultRadius : undefined);
  if (!place && radiusKm === undefined) return null;
  const r = await resolveRegion(w.map, { place, radiusKm });
  return r ?? "unresolved";
}

// ─── entity resolution ──────────────────────────────────────────────────────

function findEntity(w: WorldBridge, kind: string | undefined, id?: string, query?: string): EntityRef | null {
  const q = lc(query);
  const k = kind ?? w.state.focus?.kind;
  if (!id && !q) return w.state.focus ?? w.state.tracking;
  if (k === "aircraft" || !k) {
    const a = w.state.aircraft.find((x) => (id && x.hex.toLowerCase() === id.toLowerCase()) || (q && (lc(x.flight).trim() === q || lc(x.r) === q || x.hex === q)))
      ?? (q ? w.state.aircraft.find((x) => lc(x.flight).includes(q) || lc(x.r).includes(q)) : undefined);
    if (a) return { kind: "aircraft", id: a.hex };
    if (k === "aircraft") return null;
  }
  if (k === "ship" || !k) {
    const sh = w.state.ships.find((x) => (id && String(x.mmsi) === id) || (q && (lc(x.vessel_name).includes(q) || lc(x.ship_name).includes(q) || String(x.mmsi) === q)));
    if (sh) return { kind: "ship", id: String(sh.mmsi) };
    if (k === "ship") return null;
  }
  const sat = w.state.sats.find((x) => (id && x.noradId === id) || (q && lc(x.name).includes(q)));
  return sat ? { kind: "satellite", id: sat.noradId } : null;
}

function entityPosition(w: WorldBridge, ref: EntityRef): { lat: number; lon: number } | null {
  if (ref.kind === "aircraft") {
    const a = w.state.aircraft.find((x) => x.hex === ref.id);
    return a?.lat !== undefined && a.lon !== undefined ? { lat: a.lat, lon: a.lon } : null;
  }
  if (ref.kind === "ship") {
    const sh = w.state.ships.find((x) => String(x.mmsi) === ref.id);
    return sh ? { lat: sh.lat, lon: sh.lon } : null;
  }
  const sat = w.state.sats.find((x) => x.noradId === ref.id);
  return sat ? { lat: sat.lat, lon: sat.lon } : null;
}

function entityName(w: WorldBridge, ref: EntityRef): string {
  if (ref.kind === "aircraft") { const a = w.state.aircraft.find((x) => x.hex === ref.id); return a ? callsign(a) : ref.id; }
  if (ref.kind === "ship") { const sh = w.state.ships.find((x) => String(x.mmsi) === ref.id); return sh?.vessel_name || sh?.ship_name || `MMSI ${ref.id}`; }
  return w.state.sats.find((x) => x.noradId === ref.id)?.name ?? ref.id;
}

function entityDetails(w: WorldBridge, ref: EntityRef): Record<string, unknown> | null {
  if (ref.kind === "aircraft") {
    const a = w.state.aircraft.find((x) => x.hex === ref.id);
    if (!a) return null;
    const near = a.lat !== undefined && a.lon !== undefined ? nearestAirport(a.lat, a.lon, 150) : null;
    return {
      kind: "aircraft", callsign: callsign(a), hex: a.hex, registration: a.r ?? null, type: a.t ?? null, description: a.desc ?? null,
      altitude_ft: altFt(a), ground_speed_kt: a.gs ?? null, heading_deg: a.track ?? null, squawk: a.squawk ?? null,
      lat: a.lat, lon: a.lon, nearest_airport: near ? `${near.name} (${near.icao})` : null, feed: w.state.aircraftMode,
    };
  }
  if (ref.kind === "ship") {
    const sh = w.state.ships.find((x) => String(x.mmsi) === ref.id);
    if (!sh) return null;
    const { mmsi, vessel_name, ship_name, lat, lon, sog, cog, category, source, dwt, est_barrels, destination, status, time_went_dark, is_gap } = sh as typeof sh & Record<string, unknown>;
    return { kind: "ship", mmsi, name: vessel_name || ship_name || null, lat, lon, speed_kn: sog ?? null, course_deg: cog ?? null, category, source, dwt, est_barrels, destination, status, time_went_dark, ais_gap: is_gap ?? null };
  }
  const sat = w.state.sats.find((x) => x.noradId === ref.id);
  if (!sat) return null;
  return { kind: "satellite", name: sat.name, norad_id: sat.noradId, alt_km: r1(sat.altKm), lat: r3(sat.lat), lon: r3(sat.lon), class: sat.intelClass, origin: sat.origin };
}

async function ensureSats(ref: BridgeRef) {
  const w = ref.current!;
  if (w.state.viewMode !== "3d") w.actions.setViewMode("3d");
  if (!w.state.satIntelOn) w.actions.setSatIntel(true);
  await waitFor(ref, (x) => x.state.sats.length > 0, 9000);
}

// ─── screenshot ─────────────────────────────────────────────────────────────

function downscale(src: HTMLCanvasElement, maxW = 768): string | null {
  if (!src.width || !src.height) return null;
  const scale = Math.min(1, maxW / src.width);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(src, 0, 0, c.width, c.height);
  // Reject an all-black frame (WebGL buffer already cleared).
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++;
  if (lit < 8) return null;
  return c.toDataURL("image/jpeg", 0.72);
}

async function captureView(w: WorldBridge): Promise<string | null> {
  const cesium = [...document.querySelectorAll<HTMLCanvasElement>(".cesium-widget canvas")].find((c) => c.offsetParent !== null && c.width > 0);
  if (cesium) {
    return new Promise((res) => requestAnimationFrame(() => setTimeout(() => res(downscale(cesium)), 0)));
  }
  const map = w.map;
  if (!map) return null;
  return new Promise((res) => {
    const timer = setTimeout(() => res(null), 3000);
    map.once("render", () => { clearTimeout(timer); res(downscale(map.getCanvas())); });
    map.triggerRepaint();
  });
}

// ─── scene context (sent with every user turn, compact) ─────────────────────

export function sceneContext(w: WorldBridge | null): Record<string, unknown> {
  if (!w) return { map: "not ready" };
  const map = w.map;
  const c = map?.getCenter();
  const panels = (Object.entries(w.state.panels) as [PanelId, boolean][]).filter(([, v]) => v).map(([k]) => k);
  if (w.state.satIntelOn) panels.push("satellites" as PanelId);
  let inView = { aircraft: 0, ships: 0 };
  if (map) {
    const bnd = map.getBounds();
    inView = {
      aircraft: w.state.aircraft.reduce((acc, a) => acc + (a.lat !== undefined && a.lon !== undefined && bnd.contains([a.lon, a.lat]) ? 1 : 0), 0),
      ships: w.state.panels.maritime ? w.state.ships.reduce((acc, sh) => acc + (bnd.contains([sh.lon, sh.lat]) ? 1 : 0), 0) : 0,
    };
  }
  const focus = w.state.focus;
  const r3d = route3d.get();
  const special = r3d.route ? `route_3d:${r3d.route.id}${r3d.flight ? ":flying" : ""}` : w.state.airportView ? `airport:${w.state.airportView.icao}` : w.state.infraSiteOpen ? "infrastructure_360" : w.state.launchReplayOpen ? "launch_replay" : w.state.tracking ? `tracking_${w.state.tracking.kind}` : null;
  const ann = listAnnotations().slice(-6).map((a) => `${a.id}:${a.label}`);
  return {
    camera: c ? { lat: r3(c.lat), lon: r3(c.lng), zoom: r1(map!.getZoom()), pitch: Math.round(map!.getPitch()), bearing: Math.round(map!.getBearing()) } : null,
    view: w.state.viewMode,
    vision: w.state.visionMode,
    panels,
    special,
    selected: focus ? { kind: focus.kind, id: focus.id, name: entityName(w, focus) } : null,
    feed: `${w.state.aircraftMode}/${w.state.areaMode}`,
    live_totals: { aircraft: w.state.aircraft.length, ships: w.state.ships.length, satellites: w.state.sats.length },
    in_view: inView,
    ...(w.state.events ? { open_web_events: Object.fromEntries(EVENT_SOURCES.map((k) => [k, w.state.events!.sources[k]?.count ?? 0])) } : {}),
    ...(ann.length ? { annotations: ann } : {}),
  };
}

// ─── executor ───────────────────────────────────────────────────────────────

export async function executeTool(name: string, args: Args, ctx: Ctx): Promise<ToolOutcome> {
  const ref = ctx.bridgeRef;
  const w = ref.current;
  if (!w) return { result: { ok: false, error: "console not ready" }, say: "The console isn't ready yet." };
  const map = w.map;
  const limit = Math.max(1, Math.min(25, n(args.limit) ?? 8));

  switch (name) {
    // ── camera ──
    case "fly_to": {
      if (!map) break;
      exitSpecialViews(w);
      const lat = n(args.lat), lon = n(args.lon), zoom = n(args.zoom), pitch = n(args.pitch), bearing = n(args.bearing);
      if (lat !== undefined && lon !== undefined) {
        map.flyTo(cam({ center: [lon, lat] as LngLat, zoom: zoom ?? Math.max(map.getZoom(), 10), pitch, bearing, duration: 2600, essential: true }));
        return { result: { ok: true, lat, lon }, say: `Flying to ${lat.toFixed(2)}, ${lon.toFixed(2)}.` };
      }
      const place = s(args.place);
      if (!place) return { result: { ok: false, error: "place or lat/lon required" } };
      const hit = await geocode(place, false);
      if (!hit) return { result: { ok: false, error: `could not find ${place}` }, say: `I couldn't find ${place}.` };
      if (zoom === undefined && hit.bbox && !bboxIsSkewed(hit.bbox, hit.lat, hit.lon)) fitBbox(map, hit.bbox, { pitch, bearing });
      else map.flyTo(cam({ center: [hit.lon, hit.lat] as LngLat, zoom: zoom ?? 10, pitch: pitch ?? 45, bearing, duration: 2600, essential: true }));
      return { result: { ok: true, place: hit.displayName, lat: r3(hit.lat), lon: r3(hit.lon) }, say: `Taking you to ${hit.name}.` };
    }
    case "set_camera": {
      if (!map) break;
      const vm = s(args.view_mode);
      if (vm === "2d" || vm === "3d") w.actions.setViewMode(vm);
      const zoom = n(args.zoom) ?? (n(args.zoom_delta) !== undefined ? map.getZoom() + n(args.zoom_delta)! : undefined);
      map.easeTo(cam({ zoom, pitch: n(args.pitch), bearing: n(args.bearing), duration: 1200 }));
      return { result: { ok: true }, say: "Camera adjusted." };
    }
    case "zoom_out_globe": {
      if (!map) break;
      exitSpecialViews(w);
      w.actions.setViewMode("3d");
      setTimeout(() => map.flyTo({ center: [map.getCenter().lng, 20], zoom: 1.6, pitch: 0, bearing: 0, duration: 2400, essential: true }), 250);
      return { result: { ok: true }, say: "Zooming out to the globe." };
    }
    case "orbit": {
      if (!map) break;
      let center: LngLat | undefined;
      const place = s(args.place);
      if (place) {
        exitSpecialViews(w);
        const hit = await geocode(place, false);
        if (!hit) return { result: { ok: false, error: `could not find ${place}` }, say: `I couldn't find ${place}.` };
        center = [hit.lon, hit.lat];
      }
      orbitCamera(map, { center, durationSec: n(args.duration_sec), degPerSec: n(args.speed_deg_per_sec), zoom: n(args.zoom) ?? (place ? 14.5 : undefined) });
      return { result: { ok: true }, say: place ? `Orbiting ${place}.` : "Orbiting this area." };
    }
    case "stop_camera":
      stopCameraAnimation();
      route3d.stop();
      return { result: { ok: true }, say: "Camera stopped." };
    case "frame_results": {
      if (!map) break;
      const bb = bboxOf(lastResults);
      if (!bb) return { result: { ok: false, error: "no previous results" }, say: "There's nothing to frame yet." };
      fitBbox(map, bb, { pitch: n(args.pitch) ?? 50 });
      return { result: { ok: true, count: lastResults.length }, say: `Framing ${lastResults.length} results.` };
    }
    case "track_entity":
    case "select_entity": {
      const kind = s(args.kind);
      if (kind === "satellite") await ensureSats(ref);
      const cur = ref.current!;
      const ent = findEntity(cur, kind, s(args.id), s(args.query));
      if (!ent) return { result: { ok: false, error: "entity not found in the live feed" }, say: "I can't find that in the live feed." };
      if (ent.kind === "ship" && !cur.state.panels.maritime) cur.actions.setPanel("maritime", true);
      const label = entityName(cur, ent);
      if (name === "select_entity") {
        cur.actions.selectEntity(ent);
        const p = entityPosition(cur, ent);
        if (p && map) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), ent.kind === "satellite" ? 3 : 7), duration: 1800 });
        return { result: { ok: true, ...entityDetails(cur, ent) }, say: `Selected ${label}.` };
      }
      stopCameraAnimation();
      cur.actions.trackEntity(ent);
      const cockpit = b(args.cockpit) && ent.kind === "aircraft";
      if (cockpit) setTimeout(() => window.dispatchEvent(new CustomEvent("worldview:cockpit", { detail: { on: true } })), 3200);
      return { result: { ok: true, tracking: ent, name: label }, say: cockpit ? `Tracking ${label}. Entering the cockpit.` : `Tracking ${label}.` };
    }
    case "exit_view":
      exitSpecialViews(w);
      return { result: { ok: true }, say: "Back to the map." };
    case "fly_route": {
      if (!map) break;
      const a = (s(args.id) && getAnnotation(s(args.id)!)) || lastLine();
      if (!a || a.kind !== "line") return { result: { ok: false, error: "no route drawn" }, say: "Draw a route first." };
      const lineCoords = a.coords as LngLat[];
      const km = typeof a.meta?.distance_km === "number" ? a.meta.distance_km : lineLengthKm(lineCoords);
      if (km > ROUTE_3D_MAX_KM) {
        exitSpecialViews(w);
        flyAlongLine(map, lineCoords, { durationSec: n(args.duration_sec) });
        return { result: { ok: true, id: a.id, view: "2d" }, say: `Flying the route ${a.label}.` };
      }
      exitSpecialViews(w, { keepRoute3D: true });
      if (route3d.get().route?.id !== a.id) {
        const [fromName, toName] = a.label.split(" → ");
        const first = lineCoords[0], last = lineCoords[lineCoords.length - 1];
        route3d.open({
          id: a.id,
          label: a.label,
          color: a.color,
          coords: lineCoords,
          from: fromName ? { name: fromName, lon: first[0], lat: first[1] } : undefined,
          to: toName ? { name: toName, lon: last[0], lat: last[1] } : undefined,
          distanceKm: km,
          durationMin: typeof a.meta?.duration_min === "number" ? a.meta.duration_min : null,
          mode: typeof a.meta?.mode === "string" ? a.meta.mode : "route",
        });
      }
      route3d.fly(n(args.duration_sec));
      return { result: { ok: true, id: a.id, view: "photorealistic_3d" }, say: `Flying the route ${a.label} in 3D.` };
    }

    // ── operate ──
    case "set_vision_mode": {
      const mode = s(args.mode) as VisionMode | undefined;
      if (!mode) break;
      w.actions.setVisionMode(mode);
      const pal = s(args.flir_palette) as FlirPalette | undefined;
      if (pal) w.actions.setFlirPalette(pal);
      const names: Record<string, string> = { nvg: "Night vision", flir: "FLIR thermal", crt: "CRT", tactical: "Tactical", normal: "Optical", anime: "Anime", noir: "Noir", snow: "Snow", satellite: "Satellite recon" };
      return { result: { ok: true, mode }, say: `${names[mode] ?? mode} mode.` };
    }
    case "toggle_panel": {
      const panel = s(args.panel);
      const open = b(args.open) ?? true;
      if (panel === "satellites") {
        if (open) w.actions.setViewMode("3d");
        w.actions.setSatIntel(open);
      } else if (panel) w.actions.setPanel(panel as PanelId, open);
      return { result: { ok: true, panel, open }, say: `${panel} ${open ? "on" : "off"}.` };
    }
    case "set_aircraft_feed": {
      const mode = s(args.mode), area = s(args.area);
      if (mode === "civil" || mode === "military") w.actions.setAircraftMode(mode);
      if (area === "global" || area === "local") w.actions.setAreaMode(area);
      return { result: { ok: true }, say: `Aircraft feed: ${mode ?? w.state.aircraftMode}${area ? `, ${area}` : ""}.` };
    }
    case "set_infrastructure_layer": {
      const layer = s(args.layer) as "cables" | "landings" | "datacenters" | "dams" | undefined;
      if (!layer) break;
      w.actions.setPanel("infrastructure", true);
      w.actions.setInfraLayer(layer, b(args.on) ?? true);
      return { result: { ok: true }, say: `${layer} ${b(args.on) === false ? "hidden" : "shown"}.` };
    }
    case "set_cctv_coverage": {
      const mode = (s(args.mode) ?? "cone") as CoverageMode;
      w.actions.setPanel("cctv", true);
      w.actions.setCctvCoverage(mode);
      return { result: { ok: true }, say: mode === "off" ? "Coverage off." : `Showing CCTV ${mode === "viewshed" ? "viewsheds" : "coverage cones"}.` };
    }
    case "open_airport_view": {
      const q = s(args.query) ?? "here";
      exitSpecialViews(w);
      let ap = /^(here|this|current|centre|center)$/i.test(q) && map ? customAirport(map.getCenter().lat, map.getCenter().lng) : searchAirports(q)[0];
      if (!ap) {
        const hit = await geocode(q, false);
        if (hit) ap = nearestAirport(hit.lat, hit.lon, 60) ?? customAirport(hit.lat, hit.lon);
      }
      if (!ap) return { result: { ok: false, error: "airport not found" }, say: `I couldn't find an airport for ${q}.` };
      ref.current!.actions.enterAirport(ap);
      return { result: { ok: true, airport: ap.name, icao: ap.icao }, say: `Opening the live view of ${ap.name}.` };
    }
    case "open_infrastructure_360": {
      const kind = s(args.kind) ?? "datacenter";
      if (!w.state.infra.datacenters.length && !w.state.infra.dams.length) {
        w.actions.setPanel("infrastructure", true);
        await waitFor(ref, (x) => x.state.infra.datacenters.length > 0 || x.state.infra.dams.length > 0, 12000);
      }
      const cur = ref.current!;
      const q = lc(s(args.name));
      const nearHit = s(args.near) ? await geocode(s(args.near)!, false) : null;
      const center = nearHit ? { lat: nearHit.lat, lon: nearHit.lon } : map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : { lat: 0, lon: 0 };
      const pick = <T extends { lat: number; lon: number }>(list: T[], text: (t: T) => string): T | undefined => {
        const pool = q ? list.filter((t) => lc(text(t)).includes(q)) : list;
        return pool.reduce<T | undefined>((best, t) => (!best || haversineKm(center.lat, center.lon, t.lat, t.lon) < haversineKm(center.lat, center.lon, best.lat, best.lon) ? t : best), undefined);
      };
      let sel: InfraSelection | null = null;
      if (kind === "dam") { const d = pick(cur.state.infra.dams, (x) => `${x.name} ${x.river} ${x.owner}`); if (d) sel = { kind: "dam", dam: d }; }
      else if (kind === "landing") { const l = pick(cur.state.infra.landings, (x) => x.name); if (l) sel = { kind: "landing", landing: l }; }
      else { const dc = pick(cur.state.infra.datacenters, (x) => `${x.name} ${x.operator} ${x.city}`); if (dc) sel = { kind: "datacenter", dc }; }
      if (!sel) return { result: { ok: false, error: "no matching site" }, say: "I couldn't find a matching site." };
      exitSpecialViews(cur);
      cur.actions.enterInfraSite(sel);
      const label = sel.kind === "dam" ? sel.dam.name : sel.kind === "landing" ? sel.landing.name : sel.kind === "datacenter" ? sel.dc.name ?? sel.dc.operator : "";
      return { result: { ok: true, site: label }, say: `Opening a 360 view of ${label ?? "the site"}.` };
    }
    case "play_launch": {
      if (!w.state.launches) {
        w.actions.setPanel("space", true);
        await waitFor(ref, (x) => !!x.state.launches, 12000);
      }
      const cur = ref.current!;
      const data = cur.state.launches;
      if (!data) return { result: { ok: false, error: "launch data unavailable" }, say: "Launch data isn't available right now." };
      const which = s(args.which) ?? (s(args.query) ? undefined : "previous");
      const lists = which === "upcoming" ? [data.upcoming] : which === "previous" ? [data.previous] : [data.previous, data.upcoming];
      const q = lc(s(args.query));
      for (const list of lists) {
        const l = q ? list.find((x) => lc(`${x.name} ${x.rocket} ${x.provider} ${x.mission}`).includes(q)) : list[0];
        if (l) {
          exitSpecialViews(cur);
          cur.actions.playLaunch(l, list);
          return { result: { ok: true, launch: l.name, net: l.net }, say: `Playing ${l.name}.` };
        }
      }
      return { result: { ok: false, error: "no matching launch" }, say: "I couldn't find that launch." };
    }

    // ── annotate ���─
    case "annotate_place": {
      const place = s(args.place);
      if (!place) break;
      const hit = await geocode(place, true);
      if (!hit) return { result: { ok: false, error: `could not find ${place}` }, say: `I couldn't find ${place}.` };
      const color = s(args.color) ?? annotationColors.region;
      const label = s(args.label) ?? hit.name;
      const outlined = b(args.outline) !== false && hit.geometry && (hit.geometry.type === "Polygon" || hit.geometry.type === "MultiPolygon");
      let id: string;
      if (outlined) {
        const g = hit.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        id = addAnnotation({ kind: "polygon", label, color, coords: g.coordinates as LngLat[][] }).id;
      } else {
        id = addAnnotation({ kind: "pin", label, color, coords: [[hit.lon, hit.lat]] }).id;
      }
      if (map) {
        exitSpecialViews(w);
        if (hit.bbox && outlined) fitBbox(map, hit.bbox);
        else map.flyTo({ center: [hit.lon, hit.lat], zoom: Math.max(map.getZoom(), 15), pitch: 50, duration: 2400 });
      }
      return { result: { ok: true, id, place: hit.displayName, outlined: !!outlined }, say: outlined ? `Outlined ${hit.name}.` : `Marked ${hit.name}.` };
    }
    case "draw_pin": {
      const lat = n(args.lat), lon = n(args.lon);
      if (lat === undefined || lon === undefined) break;
      const a = addAnnotation({ kind: "pin", label: s(args.label) ?? "", color: s(args.color) ?? annotationColors.default, coords: [[lon, lat]] });
      return { result: { ok: true, id: a.id }, say: `Pinned ${a.label || "the location"}.` };
    }
    case "draw_route": {
      const mode = s(args.mode) ?? "driving";
      const plausibleKm = mode === "walking" ? 60 : mode === "cycling" ? 250 : mode === "straight" ? Infinity : 2500;
      const center = map?.getCenter();
      const viewCenter = center && map!.getZoom() >= 6 ? { lat: center.lat, lon: center.lng } : undefined;
      const [from, to] = await resolvePointPair(args.from, args.to, plausibleKm, viewCenter);
      if (!from || !to) return { result: { ok: false, error: "could not resolve endpoints" }, say: "I couldn't find one of those places." };
      const gapKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
      if (gapKm > plausibleKm) {
        return {
          result: { ok: false, error: `endpoints resolved ${Math.round(gapKm)} km apart (${from.name} / ${to.name}); too far for ${mode}, so at least one is the wrong place. Retry draw_route with fully qualified current names ("Landmark, City, Country"); ask the user only if still ambiguous.` },
          say: `I found ${from.name} and ${to.name}, but they're ${Math.round(gapKm)} kilometres apart. Which city do you mean?`,
        };
      }
      const via = Array.isArray(args.via) ? (await Promise.all((args.via as unknown[]).map(resolvePoint))).filter(Boolean) as { lat: number; lon: number; name: string }[] : [];
      const label = s(args.label) ?? `${from.name} → ${to.name}`;
      let coords: LngLat[];
      let distanceKm: number;
      let durationMin: number | null = null;
      if (mode === "straight") {
        coords = greatCircle([from.lon, from.lat], [to.lon, to.lat]);
        distanceKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
      } else {
        const profile = mode === "walking" ? "foot" : mode === "cycling" ? "bike" : "car";
        const route = await fetchRoute(ctx.base, profile, [from, ...via, to]);
        if (!route) return { result: { ok: false, error: "routing failed" }, say: "Routing failed for that trip." };
        coords = route.geometry.coordinates as LngLat[];
        distanceKm = route.distanceM / 1000;
        durationMin = Math.round(route.durationS / 60);
      }
      const color = mode === "straight" ? annotationColors.measure : annotationColors.route;
      const a = addAnnotation({ kind: "line", label, color, coords, meta: { distance_km: r1(distanceKm), duration_min: durationMin, mode } });
      addAnnotation({ kind: "pin", label: from.name, color, coords: [[from.lon, from.lat]] });
      addAnnotation({ kind: "pin", label: to.name, color, coords: [[to.lon, to.lat]] });
      exitSpecialViews(w);
      const in3d = distanceKm <= ROUTE_3D_MAX_KM;
      if (map) { const bb = bboxOf(coords); if (bb) fitBbox(map, bb, { pitch: 45 }); }
      if (in3d) {
        route3d.open({
          id: a.id,
          label,
          color,
          coords,
          from: { name: from.name, lat: from.lat, lon: from.lon },
          to: { name: to.name, lat: to.lat, lon: to.lon },
          distanceKm,
          durationMin,
          mode,
        });
      }
      const mi = r1(distanceKm * 0.621371);
      const dur = durationMin !== null ? `, about ${durationMin >= 90 ? `${r1(durationMin / 60)} hours` : `${durationMin} minutes`} ${mode}` : "";
      return { result: { ok: true, id: a.id, distance_km: r1(distanceKm), distance_mi: mi, duration_min: durationMin, view: in3d ? "photorealistic_3d" : "2d" }, say: `Route drawn${in3d ? " in 3D" : ""}: ${r1(distanceKm)} kilometres (${mi} miles)${dur}.` };
    }
    case "measure_distance": {
      const from = await resolvePoint(args.from);
      const to = await resolvePoint(args.to);
      if (!from || !to) return { result: { ok: false, error: "could not resolve endpoints" }, say: "I couldn't find one of those places." };
      const coords = greatCircle([from.lon, from.lat], [to.lon, to.lat]);
      const km = lineLengthKm(coords);
      const label = `${Math.round(km).toLocaleString()} km`;
      const a = addAnnotation({ kind: "line", label, color: annotationColors.measure, coords, meta: { distance_km: r1(km) } });
      addAnnotation({ kind: "pin", label: from.name, color: annotationColors.measure, coords: [[from.lon, from.lat]] });
      addAnnotation({ kind: "pin", label: to.name, color: annotationColors.measure, coords: [[to.lon, to.lat]] });
      if (map) { const bb = bboxOf(coords); if (bb) fitBbox(map, bb); }
      return { result: { ok: true, id: a.id, distance_km: r1(km), distance_mi: r1(km * 0.621371), distance_nm: r1(km * 0.539957) }, say: `${from.name} to ${to.name} is ${Math.round(km).toLocaleString()} kilometres, or ${Math.round(km * 0.621371).toLocaleString()} miles.` };
    }
    case "draw_circle": {
      const c = await resolvePoint(args.center);
      const rk = n(args.radius_km);
      if (!c || !rk) return { result: { ok: false, error: "center and radius_km required" } };
      const a = addAnnotation({ kind: "polygon", label: s(args.label) ?? `${rk} km`, color: annotationColors.default, coords: [circlePolygon([c.lon, c.lat], rk)] });
      if (map) { const bb = bboxOf(circlePolygon([c.lon, c.lat], rk, 8)); if (bb) fitBbox(map, bb); }
      return { result: { ok: true, id: a.id }, say: `Drew a ${rk} kilometre ring around ${c.name}.` };
    }
    case "draw_polygon": {
      const pts = Array.isArray(args.points) ? (args.points as { lat: number; lon: number }[]).filter((p) => typeof p?.lat === "number" && typeof p?.lon === "number") : [];
      if (pts.length < 3) return { result: { ok: false, error: "need ≥3 points" } };
      const ring: LngLat[] = pts.map((p) => [p.lon, p.lat]);
      ring.push(ring[0]);
      const a = addAnnotation({ kind: "polygon", label: s(args.label) ?? "", color: s(args.color) ?? annotationColors.default, coords: [ring] });
      return { result: { ok: true, id: a.id }, say: "Polygon drawn." };
    }
    case "clear_annotations": {
      const id = s(args.id);
      if (id) return { result: { ok: removeAnnotation(id) }, say: "Annotation removed." };
      const count = clearAnnotations();
      return { result: { ok: true, removed: count }, say: "Annotations cleared." };
    }

    // ── interrogate ──
    case "query_aircraft": {
      if (b(args.military) && w.state.aircraftMode !== "military") {
        const before = w.state.aircraft;
        w.actions.setAircraftMode("military");
        await waitFor(ref, (x) => x.state.aircraft !== before && x.state.aircraft.length > 0, 12000);
      }
      const cur = ref.current!;
      const region = await regionFrom(cur, args);
      if (region === "unresolved") return { result: { ok: false, error: `could not resolve region ${s(args.region)}` } };
      const minA = n(args.min_alt_ft), maxA = n(args.max_alt_ft), cs = lc(s(args.callsign)), ty = lc(s(args.type));
      const list = cur.state.aircraft.filter((a) => {
        if (a.lat === undefined || a.lon === undefined) return false;
        if (region && !region.test(a.lat, a.lon)) return false;
        const alt = altFt(a);
        if (minA !== undefined && (alt === null || alt < minA)) return false;
        if (maxA !== undefined && (alt === null || alt > maxA)) return false;
        if (cs && !(lc(a.flight).includes(cs) || lc(a.r).includes(cs) || a.hex.includes(cs))) return false;
        if (ty && !(lc(a.t).includes(ty) || lc(a.desc).includes(ty))) return false;
        return true;
      });
      const center = region?.center;
      const sortBy = s(args.sort_by) ?? (minA !== undefined ? "altitude" : center ? "distance" : "altitude");
      const dist = (a: AircraftLite) => (center ? haversineKm(center[1], center[0], a.lat!, a.lon!) : 0);
      list.sort((a, c) => (sortBy === "speed" ? (c.gs ?? 0) - (a.gs ?? 0) : sortBy === "distance" ? dist(a) - dist(c) : (altFt(c) ?? -1) - (altFt(a) ?? -1)));
      lastResults = list.slice(0, 400).map((a) => [a.lon!, a.lat!]);
      const alts = list.map(altFt).filter((x): x is number => x !== null && x > 0);
      return {
        result: {
          region: region?.name ?? "worldwide (loaded feed)",
          feed: `${cur.state.aircraftMode}/${cur.state.areaMode}`,
          count: list.length,
          airborne: alts.length,
          max_alt_ft: alts.length ? Math.max(...alts) : null,
          avg_alt_ft: alts.length ? Math.round(alts.reduce((x, y) => x + y, 0) / alts.length) : null,
          top: list.slice(0, limit).map((a) => ({
            callsign: callsign(a), hex: a.hex, type: a.t ?? null, alt_ft: altFt(a), gs_kt: a.gs ? Math.round(a.gs) : null, hdg: a.track !== undefined ? Math.round(a.track) : null,
            lat: r3(a.lat!), lon: r3(a.lon!), ...(center ? { dist_km: Math.round(dist(a)) } : {}),
          })),
        },
      };
    }
    case "query_ships": {
      if (!w.state.panels.maritime) w.actions.setPanel("maritime", true);
      if (!w.state.ships.length) await waitFor(ref, (x) => x.state.ships.length > 0, 8000);
      const cur = ref.current!;
      const region = await regionFrom(cur, args);
      if (region === "unresolved") return { result: { ok: false, error: `could not resolve region ${s(args.region)}` } };
      const dest = lc(s(args.destination)), nm = lc(s(args.name)), cat = lc(s(args.category)), minS = n(args.min_speed_kn), dark = b(args.dark_only);
      const list = cur.state.ships.filter((sh) => {
        const x = sh as typeof sh & { destination?: string; is_gap?: boolean };
        if (region && !region.test(sh.lat, sh.lon)) return false;
        if (dest && !lc(x.destination).includes(dest)) return false;
        if (nm && !(lc(sh.vessel_name).includes(nm) || lc(sh.ship_name).includes(nm) || String(sh.mmsi).includes(nm))) return false;
        if (cat && lc(sh.category) !== cat) return false;
        if (minS !== undefined && (Number(sh.sog) || 0) < minS) return false;
        if (dark && !(x.is_gap || sh.source === "DARK_FLEET")) return false;
        return true;
      });
      const center = region?.center;
      if (center) list.sort((a, c) => haversineKm(center[1], center[0], a.lat, a.lon) - haversineKm(center[1], center[0], c.lat, c.lon));
      else list.sort((a, c) => (Number(c.sog) || 0) - (Number(a.sog) || 0));
      lastResults = list.slice(0, 400).map((sh) => [sh.lon, sh.lat]);
      const byCat: Record<string, number> = {};
      for (const sh of list) byCat[sh.category || "UNKNOWN"] = (byCat[sh.category || "UNKNOWN"] ?? 0) + 1;
      return {
        result: {
          region: region?.name ?? "worldwide (loaded feed)",
          count: list.length,
          by_category: byCat,
          note: cur.state.ships.length === 0 ? "maritime feed currently empty" : undefined,
          top: list.slice(0, limit).map((sh) => {
            const x = sh as typeof sh & { destination?: string };
            return { name: sh.vessel_name || sh.ship_name || null, mmsi: sh.mmsi, category: sh.category ?? null, source: sh.source ?? null, sog_kn: sh.sog ?? null, cog: sh.cog ?? null, destination: x.destination ?? null, lat: r3(sh.lat), lon: r3(sh.lon) };
          }),
        },
      };
    }
    case "query_satellites": {
      await ensureSats(ref);
      const cur = ref.current!;
      const region = await regionFrom(cur, args, 1500);
      if (region === "unresolved") return { result: { ok: false, error: "could not resolve region" } };
      const q = lc(s(args.name));
      const list = cur.state.sats.filter((x) => (!q || lc(x.name).includes(q)) && (!region || region.test(x.lat, x.lon)));
      lastResults = list.slice(0, 400).map((x) => [x.lon, x.lat]);
      return { result: { count: list.length, total_tracked: cur.state.sats.length, top: list.slice(0, limit).map((x) => ({ name: x.name, norad_id: x.noradId, alt_km: Math.round(x.altKm), lat: r1(x.lat), lon: r1(x.lon), class: x.intelClass })) } };
    }
    case "query_infrastructure": {
      const kind = s(args.kind) ?? "datacenters";
      if (!w.state.panels.infrastructure) w.actions.setPanel("infrastructure", true);
      await waitFor(ref, (x) => (x.state.infra as Record<string, unknown[]>)[kind]?.length > 0, 12000);
      const cur = ref.current!;
      const region = await regionFrom(cur, args);
      if (region === "unresolved") return { result: { ok: false, error: "could not resolve region" } };
      const q = lc(s(args.name));
      const center = region?.center;
      const d = (lat: number, lon: number) => (center ? Math.round(haversineKm(center[1], center[0], lat, lon)) : undefined);
      let rows: Record<string, unknown>[] = [];
      let count = 0;
      if (kind === "cables") {
        const list = cur.state.infra.cables.filter((c) => (!q || lc(c.name).includes(q)) && (!region || c.lines.some((ln) => ln.some(([lo, la]) => region.test(la, lo)))));
        count = list.length;
        rows = list.slice(0, limit).map((c) => ({ id: c.id, name: c.name }));
      } else {
        type P = { lat: number; lon: number } & Record<string, unknown>;
        const src = (cur.state.infra as unknown as Record<string, P[]>)[kind] ?? [];
        const text = (p: P) => lc([p.name, p.operator, p.city, p.country, p.river, p.owner].filter(Boolean).join(" "));
        const list = src.filter((p) => (!q || text(p).includes(q)) && (!region || region.test(p.lat, p.lon)));
        if (center) list.sort((a, c) => d(a.lat, a.lon)! - d(c.lat, c.lon)!);
        else if (kind === "dams") list.sort((a, c) => (Number(c.mw) || 0) - (Number(a.mw) || 0));
        count = list.length;
        lastResults = list.slice(0, 400).map((p) => [p.lon, p.lat]);
        rows = list.slice(0, limit).map((p) => {
          const { id, name: nm, operator, city, country, river, heightM, mw, year, lat, lon } = p;
          return Object.fromEntries(Object.entries({ id, name: nm, operator, city, country, river, height_m: heightM, mw, year, lat: r3(lat), lon: r3(lon), dist_km: d(lat, lon) }).filter(([, v]) => v !== null && v !== undefined));
        });
      }
      return { result: { kind, region: region?.name ?? "worldwide", count, top: rows } };
    }
    case "query_hazards": {
      const kind = s(args.kind) ?? "fires";
      const r = await fetch(`${ctx.base}/api/ai/hazards?kind=${encodeURIComponent(kind)}`).catch(() => null);
      if (!r?.ok) return { result: { ok: false, error: "hazard feed unavailable" } };
      const j = (await r.json()) as { events: { id: string; title: string; lat: number; lon: number; date: string; magnitude: number | null; unit: string | null }[] };
      const region = await regionFrom(w, args, 300);
      if (region === "unresolved") return { result: { ok: false, error: "could not resolve region" } };
      const center = region?.center;
      const d = (lat: number, lon: number) => (center ? Math.round(haversineKm(center[1], center[0], lat, lon)) : undefined);
      const list = j.events.filter((e) => !region || region.test(e.lat, e.lon));
      const sortBy = s(args.sort_by) ?? "magnitude";
      list.sort((a, c) => sortBy === "recent" ? Date.parse(c.date) - Date.parse(a.date) : sortBy === "distance" && center ? d(a.lat, a.lon)! - d(c.lat, c.lon)! : (c.magnitude ?? -1) - (a.magnitude ?? -1));
      const top = list.slice(0, limit);
      lastResults = top.map((e) => [e.lon, e.lat]);
      if (b(args.plot) !== false) for (const e of top) addAnnotation({ kind: "pin", label: e.magnitude ? `${e.title} (${e.magnitude} ${e.unit ?? ""})` : e.title, color: annotationColors.hazard, coords: [[e.lon, e.lat]] });
      return {
        result: {
          kind, region: region?.name ?? "worldwide", count: list.length, source: kind === "earthquakes" ? "USGS M2.5+ past 7 days" : "NASA EONET open events",
          top: top.map((e) => ({ title: e.title, magnitude: e.magnitude, unit: e.unit, date: e.date.slice(0, 16), lat: r3(e.lat), lon: r3(e.lon), dist_km: d(e.lat, e.lon) })),
        },
      };
    }
    case "query_events": {
      const cur = await ensureEvents(ref);
      if (!cur?.state.events) return { result: { ok: false, error: "event feeds unavailable" } };
      const region = await regionFrom(cur, args, 300);
      if (region === "unresolved") return { result: { ok: false, error: "could not resolve region" } };
      const hours = n(args.hours) ?? 1;
      const src = EVENT_SOURCE_ALIAS[s(args.source) ?? "all"] ?? null;
      const q = lc(s(args.query));
      const minSev = n(args.min_severity) ?? 1;
      const windowed = filterEvents(cur.state.events.events, { sources: { gdelt: true, notam: true, maritime: true, usgs: true }, hours });
      const corr = correlate(windowed, cur.state.aircraft, cur.state.ships);
      const center = region?.center;
      const d = (lat: number, lon: number) => (center ? Math.round(haversineKm(center[1], center[0], lat, lon)) : undefined);
      const list = windowed.filter(
        (e) =>
          (!src || e.source === src) &&
          e.severity >= minSev &&
          (!region || region.test(e.lat, e.lon) || !!e.polygon?.some(([lo, la]) => region.test(la, lo))) &&
          (!q || lc(`${e.title} ${e.summary} ${e.meta.place ?? ""} ${e.meta.actor1 ?? ""} ${e.meta.actor2 ?? ""}`).includes(q)) &&
          (!b(args.correlated_only) || corr.has(e.id)),
      );
      list.sort((a, c) => Number(corr.has(c.id)) - Number(corr.has(a.id)) || c.severity - a.severity || Date.parse(c.time) - Date.parse(a.time));
      const top = list.slice(0, limit);
      lastResults = list.slice(0, 400).map((e) => [e.lon, e.lat]);
      if (top.length && (b(args.plot) ?? top.length === 1)) cur.actions.flyToEvent(top[0]);
      const bySource = Object.fromEntries(EVENT_SOURCES.map((k) => [k, list.filter((e) => e.source === k).length]));
      const say = top.length
        ? `${list.length} event${list.length === 1 ? "" : "s"}${region ? ` in ${region.name}` : ""}. ` +
          top
            .slice(0, 4)
            .map((e) => {
              const c = corr.get(e.id);
              return `${e.title}${c ? ` (${c.count} ${c.kind === "aircraft_in_tfr" ? "aircraft inside" : "ships inside"})` : ""}`;
            })
            .join("; ") + "."
        : `No matching events${region ? ` in ${region.name}` : ""}.`;
      return {
        say,
        result: {
          region: region?.name ?? "worldwide",
          window_hours: hours,
          count: list.length,
          by_source: bySource,
          top: top.map((e) => {
            const c = corr.get(e.id);
            return {
              source: SOURCE_META[e.source].short,
              category: e.category,
              severity: e.severity,
              title: e.title,
              summary: e.summary,
              age: relativeAge(e.time),
              lat: r3(e.lat),
              lon: r3(e.lon),
              dist_km: d(e.lat, e.lon),
              ...(c ? { live_correlation: `${c.count} ${c.kind === "aircraft_in_tfr" ? "aircraft inside this airspace" : "ships inside this zone"}: ${c.sample.join(", ")}` } : {}),
            };
          }),
          note: "GDELT items are machine-coded from news: say 'reported', not 'confirmed'.",
        },
      };
    }
    case "event_brief": {
      const cur = await ensureEvents(ref);
      if (!cur?.state.events) return { result: { ok: false, error: "event feeds unavailable" } };
      const hours = Math.max(1, n(args.hours) ?? 1);
      const windowed = filterEvents(cur.state.events.events, { sources: { gdelt: true, notam: true, maritime: true, usgs: true }, hours });
      const correlations = [...correlate(windowed, cur.state.aircraft, cur.state.ships).values()];
      const dark = summarizeDarkShips(cur.state.ships);
      try {
        const brief = await requestBrief({ hours, correlations, darkShips: dark.count ? dark : null });
        cur.actions.showEventBrief(brief);
        return { say: brief.text, result: { ok: true, window_hours: hours, brief: brief.text } };
      } catch (e) {
        // Quota / key problems: hand the model the raw numbers so it can still brief.
        const top = windowed
          .filter((e2) => e2.severity >= 3)
          .sort((a, c) => c.severity - a.severity)
          .slice(0, 12)
          .map((e2) => ({ src: SOURCE_META[e2.source].short, sev: e2.severity, title: e2.title, age: relativeAge(e2.time), lat: r1(e2.lat), lon: r1(e2.lon) }));
        return { result: { ok: false, error: (e as Error).message, fallback: { window_hours: hours, top, correlations: correlations.slice(0, 10), dark_ships: dark } } };
      }
    }
    case "query_launches": {
      if (!w.state.launches) {
        w.actions.setPanel("space", true);
        await waitFor(ref, (x) => !!x.state.launches, 12000);
      }
      const data = ref.current!.state.launches;
      if (!data) return { result: { ok: false, error: "launch data unavailable" } };
      const list = s(args.which) === "previous" ? data.previous : data.upcoming;
      const q = lc(s(args.query));
      const rows = list.filter((l) => !q || lc(`${l.name} ${l.provider} ${l.rocket} ${l.pad.name}`).includes(q)).slice(0, limit);
      return { result: { count: rows.length, launches: rows.map((l) => ({ name: l.name, net: l.net, status: l.statusName, provider: l.provider, rocket: l.rocket, orbit: l.orbit, pad: l.pad.name, location: l.pad.location })) } };
    }
    case "query_cctv": {
      if (!w.state.panels.cctv) w.actions.setPanel("cctv", true);
      await waitFor(ref, (x) => x.state.cctv.length > 0, 12000);
      const cur = ref.current!;
      const region = await regionFrom(cur, args, 25);
      if (region === "unresolved") return { result: { ok: false, error: "could not resolve region" } };
      const center = region?.center;
      const list = cur.state.cctv.filter((c) => !region || region.test(c.lat, c.lon));
      if (center) list.sort((a, c) => haversineKm(center[1], center[0], a.lat, a.lon) - haversineKm(center[1], center[0], c.lat, c.lon));
      lastResults = list.slice(0, 400).map((c) => [c.lon, c.lat]);
      return { result: { count: list.length, top: list.slice(0, limit).map((c) => ({ id: c.id, name: c.name, source: c.source, kind: c.kind, lat: r3(c.lat), lon: r3(c.lon) })) } };
    }
    case "inspect_selected": {
      const ref2 = w.state.focus ?? w.state.tracking;
      if (!ref2) {
        if (w.state.airportView) return { result: { kind: "airport", ...w.state.airportView } };
        return { result: { ok: false, error: "nothing selected — click a plane, ship or satellite first" } };
      }
      return { result: entityDetails(w, ref2) ?? { ok: false, error: "entity left the live feed" } };
    }
    case "describe_view": {
      if (!map) break;
      const c = map.getCenter();
      const address = await reverseGeocode(c.lat, c.lng, map.getZoom());
      return { result: { address, ...sceneContext(w) } };
    }
    case "capture_view": {
      const img = await captureView(w);
      if (!img) return { result: { ok: false, error: "screenshot unavailable (WebGL buffer not readable)" } };
      return { result: { ok: true, note: "Screenshot attached. Only name signs/buildings that are clearly legible." }, image: img };
    }
  }
  return { result: { ok: false, error: `unknown tool or bad arguments: ${name}` } };
}
