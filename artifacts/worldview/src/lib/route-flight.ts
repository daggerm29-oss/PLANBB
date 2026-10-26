import type { LngLat } from "./ai/geo";

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface PathPoint {
  lon: number;
  lat: number;
  /** Ground height (ellipsoid metres) under the point. */
  h: number;
}

export interface FlightFraming {
  /** Camera distance from the follow target, metres. */
  range: number;
  /** Camera tilt, radians (negative = looking down). */
  pitch: number;
  /** Default flight duration, seconds. */
  durationSec: number;
  /** How far ahead along the path the camera aims its heading, metres. */
  lookAhead: number;
  /** Minimum camera clearance above rooftops before it climbs, metres. */
  clearance: number;
}

/** Drone framing scales with route length: a city walk is shot low between towers, a long drive from higher. */
export function flightFraming(lengthM: number): FlightFraming {
  const range = clamp(lengthM * 0.085, 320, 22_000);
  return {
    range,
    pitch: -(lengthM < 15_000 ? 30 : 40) * (Math.PI / 180),
    // ~45 m/s cruise: a believable drone pace that photorealistic tiles can stream at full detail.
    durationSec: clamp(lengthM / 45, 35, 180),
    lookAhead: Math.max(range * 0.9, 80),
    clearance: clamp(range * 0.12, 45, 600),
  };
}

function segmentM(a: LngLat, b: LngLat) {
  const cosLat = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * M_PER_DEG_LON * cosLat;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Centred moving average over `half` samples on each side, keeping both endpoints pinned. */
function movingAverage(src: Float64Array, half: number): Float64Array {
  const n = src.length;
  if (half < 1 || n < 3) return src.slice();
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + src[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = Math.min(half, i, n - 1 - i);
    out[i] = (prefix[i + w + 1] - prefix[i - w]) / (2 * w + 1);
  }
  return out;
}

export interface FlightPath {
  length: number;
  count: number;
  /** Raw route position (the walker / driver on the street). */
  subjectAt(s: number): PathPoint;
  /** Smoothed position the camera follows so it glides through corners instead of snapping. */
  cameraAt(s: number): PathPoint;
  /** Compass heading (radians, 0 = north, clockwise) from a to b, or null if they coincide. */
  headingBetween(a: PathPoint, b: PathPoint): number | null;
  /** Sampled lon/lat pairs for terrain lookup. */
  samples(): LngLat[];
  /** Ground heights per sample (null = unknown); smoothed so the camera never bobs on curb-level noise. */
  setHeights(heights: (number | null)[]): void;
}

export function buildFlightPath(coords: LngLat[], framing: FlightFraming): FlightPath {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segmentM(coords[i - 1], coords[i]));
  const length = Math.max(cum[cum.length - 1], 1);
  const step = clamp(length / 600, 4, 1500);
  const count = Math.max(2, Math.ceil(length / step) + 1);

  const rawLon = new Float64Array(count);
  const rawLat = new Float64Array(count);
  let j = 1;
  for (let k = 0; k < count; k++) {
    const s = (length * k) / (count - 1);
    while (j < cum.length - 1 && cum[j] < s) j++;
    const a = coords[Math.max(0, j - 1)];
    const b = coords[Math.min(coords.length - 1, j)];
    const span = cum[j] - cum[j - 1];
    const f = span > 0 ? clamp((s - cum[j - 1]) / span, 0, 1) : 0;
    rawLon[k] = a[0] + (b[0] - a[0]) * f;
    rawLat[k] = a[1] + (b[1] - a[1]) * f;
  }

  const smoothHalf = Math.round(clamp(framing.range * 0.6, 40, 3000) / step);
  const camLon = movingAverage(rawLon, smoothHalf);
  const camLat = movingAverage(rawLat, smoothHalf);
  let ground: Float64Array = new Float64Array(count);

  const interp = (lon: Float64Array, lat: Float64Array, s: number): PathPoint => {
    const x = (clamp(s, 0, length) / length) * (count - 1);
    const i = Math.min(Math.floor(x), count - 2);
    const f = x - i;
    return {
      lon: lon[i] + (lon[i + 1] - lon[i]) * f,
      lat: lat[i] + (lat[i + 1] - lat[i]) * f,
      h: ground[i] + (ground[i + 1] - ground[i]) * f,
    };
  };

  return {
    length,
    count,
    subjectAt: (s) => interp(rawLon, rawLat, s),
    cameraAt: (s) => interp(camLon, camLat, s),
    headingBetween(a, b) {
      const cosLat = Math.cos(a.lat * (Math.PI / 180));
      const east = (b.lon - a.lon) * M_PER_DEG_LON * cosLat;
      const north = (b.lat - a.lat) * M_PER_DEG_LAT;
      if (Math.hypot(east, north) < 1) return null;
      return Math.atan2(east, north);
    },
    samples() {
      const out: LngLat[] = [];
      for (let i = 0; i < count; i++) out.push([rawLon[i], rawLat[i]]);
      return out;
    },
    setHeights(heights) {
      const known = heights.filter((h): h is number => h !== null && Number.isFinite(h));
      const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
      const filled = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const h = heights[i];
        filled[i] = h !== null && h !== undefined && Number.isFinite(h) ? h : fallback;
      }
      ground = movingAverage(filled, Math.max(1, Math.round(120 / step)));
    },
  };
}

/** Shortest signed angular difference b - a, in radians. */
export function angleDelta(a: number, b: number) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Slow-in / slow-out so the drone eases off the start line and settles onto the destination. */
export function easeInOut(u: number) {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1));
}
