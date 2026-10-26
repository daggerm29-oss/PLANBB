import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "./cctv";
import type { AircraftLite } from "./ai/bridge";
import type { Ship } from "../components/ShipsLayer";

export type EventSource = "gdelt" | "usgs" | "notam" | "maritime";

export interface WorldEvent {
  id: string;
  source: EventSource;
  category: string;
  title: string;
  summary: string;
  lat: number;
  lon: number;
  time: string;
  severity: number;
  url: string | null;
  polygon: [number, number][] | null;
  meta: Record<string, string | number | boolean | null>;
}

export interface SourceState {
  ok: boolean;
  count: number;
  updatedAt: number | null;
  error: string | null;
}

export interface EventsPayload {
  fetchedAt: number;
  sources: Record<EventSource, SourceState>;
  events: WorldEvent[];
}

export const EVENT_SOURCES: EventSource[] = ["gdelt", "notam", "maritime", "usgs"];

export const SOURCE_META: Record<EventSource, { label: string; short: string; color: string; origin: string }> = {
  gdelt: { label: "News events", short: "NEWS", color: "#f43f5e", origin: "GDELT 2.0" },
  notam: { label: "Airspace NOTAMs", short: "NOTAM", color: "#a78bfa", origin: "FAA TFR" },
  maritime: { label: "Maritime warnings", short: "NAVWARN", color: "#38bdf8", origin: "NGA MSI" },
  usgs: { label: "Earthquakes", short: "QUAKE", color: "#f59e0b", origin: "USGS" },
};

/** Standing restrictions are shown while active, whatever their issue date; reports are windowed by time. */
export const STANDING_SOURCES: ReadonlySet<EventSource> = new Set(["notam", "maritime"]);

export interface EventFilters {
  sources: Record<EventSource, boolean>;
  /** Report window in hours (GDELT / USGS); 0 = everything in the feed. */
  hours: number;
}

export const DEFAULT_EVENT_FILTERS: EventFilters = {
  sources: { gdelt: true, notam: true, maritime: true, usgs: true },
  hours: 1,
};

export function filterEvents(events: WorldEvent[], f: EventFilters, nowMs = Date.now()): WorldEvent[] {
  const cutoff = f.hours > 0 ? nowMs - f.hours * 3600_000 : -Infinity;
  return events.filter((e) => f.sources[e.source] && (STANDING_SOURCES.has(e.source) || Date.parse(e.time) >= cutoff));
}

const POLL_MS = 5 * 60_000;
type Status = "idle" | "loading" | "ready" | "error";

/** Polls /api/events while active (the server caches each upstream with its own TTL). */
export function useWorldEvents(active: boolean) {
  const [data, setData] = useState<EventsPayload | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const r = await fetch(`${apiBase()}/api/events`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as EventsPayload);
      setStatus("ready");
    } catch (e) {
      console.error("Failed to load world events", e);
      setStatus((s) => (s === "ready" ? s : "error"));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  return { data, status, reload: load };
}

// ─── correlation: live sensors × open-web events ────────────────────────────

export interface Correlation {
  eventId: string;
  kind: "aircraft_in_tfr" | "ships_in_warning";
  count: number;
  /** Callsigns / vessel names (first few). */
  sample: string[];
}

export interface DarkShipSummary {
  count: number;
  tankers: number;
  clusters: { lat: number; lon: number; count: number }[];
}

function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringBbox(ring: [number, number][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const POINT_WARNING_RADIUS_KM = 25;
function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const shipName = (s: Ship) => String(s.vessel_name ?? s.ship_name ?? s.mmsi);
const acName = (a: AircraftLite) => (a.flight?.trim() || a.r || a.hex).toUpperCase();

/**
 * The analyst move: which live aircraft are inside restricted airspace right now, and which ships are
 * operating inside a maritime warning zone. Bounding-box prefilter keeps this cheap on large feeds.
 */
export function correlate(events: WorldEvent[], aircraft: AircraftLite[], ships: Ship[]): Map<string, Correlation> {
  const out = new Map<string, Correlation>();
  const airborne = aircraft.filter((a) => typeof a.lat === "number" && typeof a.lon === "number" && a.alt_baro !== "ground");

  for (const e of events) {
    if (e.source === "notam" && e.polygon && airborne.length) {
      const [w, s, ea, n] = ringBbox(e.polygon);
      const inside = airborne.filter((a) => a.lon! >= w && a.lon! <= ea && a.lat! >= s && a.lat! <= n && pointInRing(a.lon!, a.lat!, e.polygon!));
      if (inside.length) out.set(e.id, { eventId: e.id, kind: "aircraft_in_tfr", count: inside.length, sample: inside.slice(0, 6).map(acName) });
    } else if (e.source === "maritime" && ships.length) {
      let inside: Ship[];
      if (e.polygon) {
        const [w, s, ea, n] = ringBbox(e.polygon);
        inside = ships.filter((sh) => sh.lon >= w && sh.lon <= ea && sh.lat >= s && sh.lat <= n && pointInRing(sh.lon, sh.lat, e.polygon!));
      } else {
        inside = ships.filter((sh) => Math.abs(sh.lat - e.lat) < 0.5 && kmBetween(sh.lat, sh.lon, e.lat, e.lon) <= POINT_WARNING_RADIUS_KM);
      }
      if (inside.length) out.set(e.id, { eventId: e.id, kind: "ships_in_warning", count: inside.length, sample: inside.slice(0, 6).map(shipName) });
    }
  }
  return out;
}

/** AIS-dark vessels bucketed on a 2° grid, densest clusters first. */
export function summarizeDarkShips(ships: Ship[]): DarkShipSummary {
  const dark = ships.filter((s) => s.is_gap || s.source === "DARK_FLEET");
  const grid = new Map<string, { lat: number; lon: number; count: number }>();
  for (const s of dark) {
    const lat = s.last_known_lat ?? s.lat;
    const lon = s.last_known_lon ?? s.lon;
    const key = `${Math.floor(lat / 2)},${Math.floor(lon / 2)}`;
    const g = grid.get(key);
    if (g) {
      g.lat += (lat - g.lat) / (g.count + 1);
      g.lon += (lon - g.lon) / (g.count + 1);
      g.count += 1;
    } else grid.set(key, { lat, lon, count: 1 });
  }
  return {
    count: dark.length,
    tankers: dark.filter((s) => s.category === "TANKER").length,
    clusters: [...grid.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => ({ lat: Math.round(c.lat * 10) / 10, lon: Math.round(c.lon * 10) / 10, count: c.count })),
  };
}

// ─── AI brief ───────────────────────────────────────────────────────────────

export interface EventBrief {
  text: string;
  model: string;
  generatedAt: number;
}

export async function requestBrief(opts: { hours: number; correlations: Correlation[]; darkShips: DarkShipSummary | null }): Promise<EventBrief> {
  const r = await fetch(`${apiBase()}/api/events/brief`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hours: opts.hours || 24, correlations: opts.correlations, darkShips: opts.darkShips }),
  });
  const j = (await r.json().catch(() => ({}))) as Partial<EventBrief> & { error?: string };
  if (!r.ok || !j.text) throw new Error(j.error || `Brief failed (HTTP ${r.status})`);
  return { text: j.text, model: j.model ?? "gemini", generatedAt: j.generatedAt ?? Date.now() };
}

const FALLBACK_BY_CATEGORY: Record<string, string> = {
  conflict: "conflict",
  violence: "conflict",
  protest: "protest",
  military: "military",
  coercion: "military",
  tsunami: "tsunami",
  earthquake: "earthquake",
  space: "space",
};
const FALLBACK_BY_SOURCE: Record<EventSource, string> = { gdelt: "conflict", notam: "airspace", maritime: "maritime", usgs: "earthquake" };

/** Category photo shipped with the app; used when an event has no article image (or it fails to load). */
export function eventFallbackImage(e: WorldEvent): string {
  const name = FALLBACK_BY_CATEGORY[e.category] ?? FALLBACK_BY_SOURCE[e.source];
  return `${import.meta.env.BASE_URL}events/${name}.jpg`;
}

/** News events show the article's own preview image (proxied server-side); everything else uses its category photo. */
export function eventImage(e: WorldEvent): string {
  if (e.source === "gdelt" && e.url) return `${apiBase()}/api/events/thumb?u=${encodeURIComponent(e.url)}`;
  return eventFallbackImage(e);
}

export function relativeAge(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (s < 60) return "NOW";
  if (s < 3600) return `${Math.round(s / 60)}M AGO`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}H AGO`;
  return `${Math.round(s / 86400)}D AGO`;
}
