import type maplibregl from "maplibre-gl";

export type LngLat = [number, number];

export interface GeoHit {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number] | null;
  geometry: GeoJSON.Geometry | null;
  type: string;
}

const geocodeCache = new Map<string, Promise<GeoHit | null>>();
const reverseCache = new Map<string, Promise<string | null>>();

/** Nominatim geocode with boundary polygon. Cached for the session (Nominatim asks for ≤1 req/s). */
export function geocode(query: string, withPolygon = true): Promise<GeoHit | null> {
  const key = `${withPolygon ? 1 : 0}:${query.trim().toLowerCase()}`;
  let p = geocodeCache.get(key);
  if (!p) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1${withPolygon ? "&polygon_geojson=1&polygon_threshold=0.005" : ""}`;
    p = fetch(url, { headers: { "Accept-Language": "en" } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { display_name: string; name?: string; lat: string; lon: string; boundingbox?: string[]; geojson?: GeoJSON.Geometry; type?: string; addresstype?: string }[]) => {
        const h = rows[0];
        if (!h) return null;
        const bb = h.boundingbox?.map(Number);
        return {
          name: h.name || h.display_name.split(",")[0].trim(),
          displayName: h.display_name,
          lat: Number(h.lat),
          lon: Number(h.lon),
          bbox: bb && bb.length === 4 ? [bb[2], bb[0], bb[3], bb[1]] : null,
          geometry: h.geojson ?? null,
          type: h.addresstype || h.type || "place",
        } satisfies GeoHit;
      })
      .catch(() => null);
    geocodeCache.set(key, p);
    p.then((v) => { if (!v) geocodeCache.delete(key); });
  }
  return p;
}

export function reverseGeocode(lat: number, lon: number, zoom: number): Promise<string | null> {
  const z = Math.max(3, Math.min(18, Math.round(zoom)));
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${z}`;
  let p = reverseCache.get(key);
  if (!p) {
    p = fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&zoom=${z}&format=json`, { headers: { "Accept-Language": "en" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { display_name?: string } | null) => j?.display_name ?? null)
      .catch(() => null);
    reverseCache.set(key, p);
  }
  return p;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function ringContains(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function geometryContains(geom: GeoJSON.Geometry, lon: number, lat: number): boolean {
  const poly = (rings: number[][][]) => ringContains(rings[0], lon, lat) && !rings.slice(1).some((h) => ringContains(h, lon, lat));
  if (geom.type === "Polygon") return poly(geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some(poly);
  return false;
}

export interface Region {
  name: string;
  test(lat: number, lon: number): boolean;
  center: LngLat;
  bbox: [number, number, number, number] | null;
}

/** Resolve a region: place name (polygon, bbox, or radius around a point), or "view" for the current viewport. */
export async function resolveRegion(
  map: maplibregl.Map | null,
  opts: { place?: string; radiusKm?: number; lat?: number; lon?: number },
): Promise<Region | null> {
  if (opts.lat !== undefined && opts.lon !== undefined) {
    const r = opts.radiusKm ?? 100;
    return { name: `${r} km around ${opts.lat.toFixed(2)},${opts.lon.toFixed(2)}`, center: [opts.lon, opts.lat], bbox: null, test: (la, lo) => haversineKm(opts.lat!, opts.lon!, la, lo) <= r };
  }
  const place = opts.place?.trim();
  if (!place || /^(view|current view|here|screen|this area|visible)$/i.test(place)) {
    if (!map) return null;
    const b = map.getBounds();
    const c = map.getCenter();
    return {
      name: "current view",
      center: [c.lng, c.lat],
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      test: (la, lo) => b.contains([lo, la]),
    };
  }
  const hit = await geocode(place);
  if (!hit) return null;
  if (opts.radiusKm) {
    return { name: `${opts.radiusKm} km around ${hit.name}`, center: [hit.lon, hit.lat], bbox: hit.bbox, test: (la, lo) => haversineKm(hit.lat, hit.lon, la, lo) <= opts.radiusKm! };
  }
  const g = hit.geometry;
  if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
    const bb = hit.bbox;
    return {
      name: hit.name,
      center: [hit.lon, hit.lat],
      bbox: bb,
      test: (la, lo) => (!bb || (lo >= bb[0] && lo <= bb[2] && la >= bb[1] && la <= bb[3])) && geometryContains(g, lo, la),
    };
  }
  // Point-like place (city / landmark): default 50 km radius.
  return { name: `50 km around ${hit.name}`, center: [hit.lon, hit.lat], bbox: hit.bbox, test: (la, lo) => haversineKm(hit.lat, hit.lon, la, lo) <= 50 };
}

/** Accepts "lat,lon" strings, {lat,lon} objects, or place names. */
export async function resolvePoint(input: unknown): Promise<{ lat: number; lon: number; name: string } | null> {
  if (input && typeof input === "object") {
    const o = input as { lat?: number; lon?: number; lng?: number; name?: string };
    const lon = o.lon ?? o.lng;
    if (typeof o.lat === "number" && typeof lon === "number") return { lat: o.lat, lon, name: o.name ?? `${o.lat.toFixed(4)},${lon.toFixed(4)}` };
  }
  if (typeof input === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
    if (m) return { lat: Number(m[1]), lon: Number(m[2]), name: input.trim() };
    const hit = await geocode(input, false);
    if (hit) return { lat: hit.lat, lon: hit.lon, name: hit.name };
  }
  return null;
}

type PointHit = { lat: number; lon: number; name: string };
const candidateCache = new Map<string, Promise<PointHit[]>>();

function geocodeCandidates(query: string): Promise<PointHit[]> {
  const key = query.trim().toLowerCase();
  let p = candidateCache.get(key);
  if (!p) {
    p = fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8`, { headers: { "Accept-Language": "en" } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { display_name: string; name?: string; lat: string; lon: string }[]) =>
        rows.map((h) => ({ lat: Number(h.lat), lon: Number(h.lon), name: h.name || h.display_name.split(",")[0].trim() })))
      .catch(() => []);
    candidateCache.set(key, p);
    p.then((v) => { if (!v.length) candidateCache.delete(key); });
  }
  return p;
}

const nearCache = new Map<string, Promise<PointHit | null>>();

/** Geocode restricted to a box around a point (Nominatim viewbox + bounded=1). */
function geocodeNear(query: string, lat: number, lon: number, radiusKm: number): Promise<PointHit | null> {
  const r = Math.max(5, Math.min(radiusKm, 500));
  const dLat = r / 111.32;
  const dLon = r / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const box = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((v) => v.toFixed(4)).join(",");
  const key = `${query.trim().toLowerCase()}@${box}`;
  let p = nearCache.get(key);
  if (!p) {
    p = fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&viewbox=${box}&bounded=1`, { headers: { "Accept-Language": "en" } })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: { display_name: string; name?: string; lat: string; lon: string }[]) => {
        const h = rows[0];
        return h ? { lat: Number(h.lat), lon: Number(h.lon), name: h.name || h.display_name.split(",")[0].trim() } : null;
      })
      .catch(() => null);
    nearCache.set(key, p);
    p.then((v) => { if (!v) nearCache.delete(key); });
  }
  return p;
}

/** "the Capitol" -> "Capitol": a leading article makes Nominatim miss obvious matches. */
export function cleanPlaceQuery<T>(v: T): T {
  return (typeof v === "string" ? v.replace(/^\s*the\s+/i, "").trim() : v) as T;
}

/**
 * Resolve two route endpoints together. Short names like "Capitol" match dozens of places worldwide (the top
 * global hit is in San Jose), so when the top hits are implausibly far apart for the trip, each ambiguous end is
 * re-searched INSIDE a box around the other end (and around the current camera centre, if given). The pair with
 * the shortest separation wins.
 */
export async function resolvePointPair(
  aIn: unknown,
  bIn: unknown,
  maxPlausibleKm: number,
  viewCenter?: { lat: number; lon: number },
): Promise<[PointHit | null, PointHit | null]> {
  const a = cleanPlaceQuery(aIn), b = cleanPlaceQuery(bIn);
  const isName = (v: unknown): v is string => typeof v === "string" && !/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(v);
  const searchKm = Number.isFinite(maxPlausibleKm) ? maxPlausibleKm : 2500;

  // If the user is looking at a city, try resolving both ends there first: "Capitol" while viewing Austin.
  if (viewCenter && isName(a) && isName(b)) {
    const [va, vb] = await Promise.all([geocodeNear(a, viewCenter.lat, viewCenter.lon, searchKm), geocodeNear(b, viewCenter.lat, viewCenter.lon, searchKm)]);
    if (va && vb && haversineKm(va.lat, va.lon, vb.lat, vb.lon) <= maxPlausibleKm) return [va, vb];
  }

  const [pa, pb] = await Promise.all([resolvePoint(a), resolvePoint(b)]);
  if (!pa || !pb) return [pa, pb];
  const directKm = haversineKm(pa.lat, pa.lon, pb.lat, pb.lon);
  if (directKm <= maxPlausibleKm) return [pa, pb];

  let best: [PointHit, PointHit] = [pa, pb];
  let bestKm = directKm;
  const consider = (x: PointHit | null, y: PointHit | null) => {
    if (!x || !y) return;
    const km = haversineKm(x.lat, x.lon, y.lat, y.lon);
    if (km < bestKm) { best = [x, y]; bestKm = km; }
  };

  const [aNearB, bNearA] = await Promise.all([
    isName(a) ? geocodeNear(a, pb.lat, pb.lon, searchKm) : null,
    isName(b) ? geocodeNear(b, pa.lat, pa.lon, searchKm) : null,
  ]);
  consider(aNearB, pb);
  consider(pa, bNearA);
  if (bestKm <= maxPlausibleKm) return best;

  const [ca, cb] = await Promise.all([isName(a) ? geocodeCandidates(a) : [], isName(b) ? geocodeCandidates(b) : []]);
  for (const x of ca) consider(x, pb);
  for (const y of cb) consider(pa, y);
  return best;
}

export async function fetchRoute(
  base: string,
  profile: "foot" | "bike" | "car",
  points: { lat: number; lon: number }[],
): Promise<{ distanceM: number; durationS: number; geometry: GeoJSON.LineString } | null> {
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const r = await fetch(`${base}/api/ai/route?profile=${profile}&coords=${coords}`);
  if (!r.ok) return null;
  return r.json();
}

/** Great-circle polyline between two points (for straight "measure" lines that look right on the globe). */
export function greatCircle(a: LngLat, b: LngLat, steps = 64): LngLat[] {
  const r = Math.PI / 180;
  const [lon1, lat1] = [a[0] * r, a[1] * r];
  const [lon2, lat2] = [b[0] * r, b[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d < 1e-9) return [a, b];
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
  }
  return out;
}

export function circlePolygon(center: LngLat, radiusKm: number, steps = 72): LngLat[] {
  const [lon, lat] = center;
  const out: LngLat[] = [];
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180) || 1e-6);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    out.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return out;
}

export function bearingBetween(a: LngLat, b: LngLat): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

export function lineLengthKm(coords: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return km;
}

// ─── camera animation (orbit / fly along route) ──────────────────────────────

let cameraAnim: { stop: () => void } | null = null;

export function stopCameraAnimation() {
  cameraAnim?.stop();
  cameraAnim = null;
}

function interruptOnUserInput(map: maplibregl.Map, stop: () => void) {
  const el = map.getCanvasContainer();
  const onUser = () => stop();
  el.addEventListener("pointerdown", onUser, { once: true });
  el.addEventListener("wheel", onUser, { once: true, passive: true });
  return () => {
    el.removeEventListener("pointerdown", onUser);
    el.removeEventListener("wheel", onUser);
  };
}

export function orbitCamera(map: maplibregl.Map, opts: { center?: LngLat; durationSec?: number; degPerSec?: number; pitch?: number; zoom?: number }) {
  stopCameraAnimation();
  const center = opts.center ?? (map.getCenter().toArray() as LngLat);
  const degPerSec = opts.degPerSec ?? 12;
  const durationMs = (opts.durationSec ?? 40) * 1000;
  map.easeTo({ center, pitch: opts.pitch ?? Math.max(map.getPitch(), 55), zoom: opts.zoom ?? map.getZoom(), duration: 1200 });
  let raf = 0;
  let last = 0;
  const t0 = performance.now() + 1200;
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; cancelAnimationFrame(raf); cleanup(); };
  const cleanup = interruptOnUserInput(map, stop);
  const tick = (now: number) => {
    if (stopped) return;
    if (now >= t0) {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      map.jumpTo({ center, bearing: (map.getBearing() + degPerSec * dt) % 360 });
      if (now - t0 > durationMs) { stop(); return; }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  cameraAnim = { stop };
}

export function flyAlongLine(map: maplibregl.Map, coords: LngLat[], opts: { speedKmh?: number; durationSec?: number; pitch?: number; zoom?: number }) {
  stopCameraAnimation();
  if (coords.length < 2) return;
  const totalKm = lineLengthKm(coords);
  const durationMs = (opts.durationSec ?? Math.min(90, Math.max(12, totalKm * 0.6))) * 1000;
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  const at = (km: number): { p: LngLat; seg: number } => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < km) i++;
    const f = cum[i] === cum[i - 1] ? 0 : (km - cum[i - 1]) / (cum[i] - cum[i - 1]);
    const a = coords[i - 1], b = coords[i];
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], seg: i };
  };
  const zoom = opts.zoom ?? (totalKm < 8 ? 16.5 : totalKm < 60 ? 14 : totalKm < 400 ? 10 : 7);
  map.flyTo({ center: coords[0], zoom, pitch: opts.pitch ?? 62, bearing: bearingBetween(coords[0], coords[Math.min(4, coords.length - 1)]), duration: 1800 });
  let raf = 0;
  let stopped = false;
  let bearing = map.getBearing();
  const stop = () => { if (stopped) return; stopped = true; cancelAnimationFrame(raf); cleanup(); };
  const cleanup = interruptOnUserInput(map, stop);
  const t0 = performance.now() + 1900;
  const tick = (now: number) => {
    if (stopped) return;
    const f = Math.min(1, Math.max(0, (now - t0) / durationMs));
    if (now >= t0) {
      const km = f * totalKm;
      const { p } = at(km);
      const ahead = at(Math.min(totalKm, km + Math.max(0.15, totalKm * 0.03))).p;
      const target = bearingBetween(p, ahead);
      let d = ((target - bearing + 540) % 360) - 180;
      bearing = (bearing + d * 0.06 + 360) % 360;
      map.jumpTo({ center: p, bearing });
      if (f >= 1) { stop(); return; }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  cameraAnim = { stop };
}
