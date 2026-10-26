import type { CctvCamera, CctvSourceId } from "./cctv";

/**
 * CCTV viewshed estimation.
 *
 * None of the public feeds publish a calibrated pose, so each camera gets an *estimated* pose:
 *   - heading parsed from the feed's `direction` text ("Northbound", "East Facing (Home)", "N/B", OSM
 *     `camera:direction` degrees). Feeds without one (NYC, Maryland, Austin, …) get an omnidirectional
 *     line-of-sight at reduced range rather than an invented heading.
 *   - mount height / FOV / range from the camera class (highway mast, urban intersection, OSM camera:type).
 *
 * Occlusion is a 2.5D ray cast against the basemap's building footprints (`render_height`): a building of
 * height hb at distance d hides everything beyond it when hb >= mount height; a lower building shadows the
 * ground out to d·H/(H−hb), and is treated as blocking when that shadow reaches the camera's range.
 */

export type CoverageMode = "off" | "cone" | "viewshed";

export type HeadingSource = "feed" | "osm" | "none";

export interface CameraPose {
  id: string;
  lat: number;
  lon: number;
  /** Degrees clockwise from north; null when the feed has no usable direction. */
  headingDeg: number | null;
  headingSource: HeadingSource;
  fovDeg: number;
  rangeM: number;
  mountM: number;
  profile: string;
}

export interface Building {
  height: number;
  rings: [number, number][][];
}

export interface Viewshed {
  pose: CameraPose;
  visibleRing: [number, number][];
  blindRings: [number, number][][];
  bands: { ring: [number, number][]; height: number }[];
  /** Fraction of the nominal coverage area that is actually visible (0–1). */
  visibleFrac: number;
}

interface Profile {
  label: string;
  mountM: number;
  fovDeg: number;
  rangeM: number;
}

const HIGHWAY: Profile = { label: "HIGHWAY MAST", mountM: 12, fovDeg: 60, rangeM: 320 };
const URBAN: Profile = { label: "URBAN INTERSECTION", mountM: 8, fovDeg: 70, rangeM: 170 };
const SCENIC: Profile = { label: "SCENIC WEBCAM", mountM: 25, fovDeg: 70, rangeM: 700 };

const SOURCE_PROFILE: Record<Exclude<CctvSourceId, "osm">, Profile> = {
  caltrans: HIGHWAY,
  florida: HIGHWAY,
  oregon: HIGHWAY,
  maryland: HIGHWAY,
  nyc: URBAN,
  tfl: URBAN,
  austin: URBAN,
  singapore: HIGHWAY,
  windy: SCENIC,
};

const OSM_PROFILES: Record<string, Profile> = {
  dome: { label: "OSM DOME", mountM: 4, fovDeg: 360, rangeM: 45 },
  panning: { label: "OSM PTZ", mountM: 5, fovDeg: 360, rangeM: 70 },
  fixed: { label: "OSM FIXED", mountM: 4, fovDeg: 75, rangeM: 60 },
};
const OSM_DEFAULT: Profile = { label: "OSM CAMERA", mountM: 4, fovDeg: 75, rangeM: 55 };

/** Omnidirectional coverage is a "could see" envelope, so it is kept shorter than an aimed lens. */
const OMNI_RANGE_FACTOR = 0.55;

const CARDINALS: Record<string, number> = {
  n: 0, nne: 22.5, ne: 45, ene: 67.5, e: 90, ese: 112.5, se: 135, sse: 157.5,
  s: 180, ssw: 202.5, sw: 225, wsw: 247.5, w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
  north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315,
};

const WORD = "(north|south|east|west)(?:\\s*-?\\s*(east|west))?";

function wordsToDeg(a: string, b?: string): number {
  return CARDINALS[a + (b ?? "")] ?? CARDINALS[a];
}

/** Parses free-text feed directions and OSM `camera:direction` values into a compass heading. */
export function parseHeading(raw: string | undefined): number | null {
  if (!raw) return null;
  const first = raw.split(";")[0].trim();
  if (/^-?\d+(\.\d+)?\s*°?$/.test(first)) return ((parseFloat(first) % 360) + 360) % 360;

  const s = first
    .toLowerCase()
    .replace(/\b([nsew])\s*\/\s*b\b/g, (_, c: string) => `${{ n: "north", s: "south", e: "east", w: "west" }[c]}bound`)
    .replace(/\b([nsew])b\b/g, (_, c: string) => `${{ n: "north", s: "south", e: "east", w: "west" }[c]}bound`);

  const abbrev = s.match(/^([nsew]{1,3})$/);
  if (abbrev && CARDINALS[abbrev[1]] !== undefined) return CARDINALS[abbrev[1]];

  const bound = s.match(new RegExp(`${WORD}\\s*-?\\s*(?:bound|ward)`));
  if (bound) return wordsToDeg(bound[1], bound[2]);

  // "Facing north", TfL "Zoom south - Liverpool Road jct", "View east", "Looking west".
  const facing =
    s.match(new RegExp(`(?:facing|zoom(?:ed)?|view(?:ing)?|looking|pointing|towards?)\\s+${WORD}`)) ??
    s.match(new RegExp(`${WORD}\\s+facing`));
  if (facing) return wordsToDeg(facing[1], facing[2]);

  // A bare compass word only counts in short labels ("North", "South (A21 twds Downham)") — longer
  // strings are usually road names like "West End Ave".
  const bare = s.match(new RegExp(`^${WORD}\\b`));
  if (bare && s.split(/\s+/).length <= 5) return wordsToDeg(bare[1], bare[2]);
  return null;
}

export function estimatePose(c: CctvCamera): CameraPose {
  let profile: Profile;
  if (c.source === "osm") {
    const type = (c.area ?? "").split(" · ")[0]?.trim().toLowerCase();
    profile = OSM_PROFILES[type] ?? OSM_DEFAULT;
  } else {
    profile = SOURCE_PROFILE[c.source] ?? URBAN;
  }
  const heading = parseHeading(c.direction);
  const omni = profile.fovDeg >= 360 || heading === null;
  return {
    id: c.id,
    lat: c.lat,
    lon: c.lon,
    headingDeg: omni ? null : heading,
    headingSource: heading === null ? "none" : c.source === "osm" ? "osm" : "feed",
    fovDeg: omni ? 360 : profile.fovDeg,
    rangeM: omni && profile.fovDeg < 360 ? profile.rangeM * OMNI_RANGE_FACTOR : profile.rangeM,
    mountM: profile.mountM,
    profile: profile.label,
  };
}

// ── local metric frame ────────────────────────────────────────────────────
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

export interface Frame {
  toXY: (lon: number, lat: number) => [number, number];
  toLonLat: (x: number, y: number) => [number, number];
}

/** Equirectangular frame around a reference point; sub-metre error across a city-scale viewport. */
export function makeFrame(refLon: number, refLat: number): Frame {
  const kx = Math.cos((refLat * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  return {
    toXY: (lon, lat) => [(lon - refLon) * kx, (lat - refLat) * M_PER_DEG_LAT],
    toLonLat: (x, y) => [refLon + x / kx, refLat + y / M_PER_DEG_LAT],
  };
}

// ── building edge index ───────────────────────────────────────────────────
const CELL_M = 30;

export interface BuildingIndex {
  frame: Frame;
  /** Flat edge array: x1, y1, x2, y2 per edge. */
  edges: Float64Array;
  edgeBuilding: Int32Array;
  heights: Float32Array;
  rings: [number, number][][][];
  cells: Map<number, number[]>;
  stamp: Int32Array;
  stampId: number;
}

const cellKey = (ix: number, iy: number) => (ix + 50_000) * 100_000 + (iy + 50_000);

export function buildIndex(frame: Frame, buildings: Building[]): BuildingIndex {
  let edgeCount = 0;
  for (const b of buildings) for (const r of b.rings) edgeCount += Math.max(0, r.length - 1);
  const edges = new Float64Array(edgeCount * 4);
  const edgeBuilding = new Int32Array(edgeCount);
  const heights = new Float32Array(buildings.length);
  const rings: [number, number][][][] = [];
  const cells = new Map<number, number[]>();
  let e = 0;
  buildings.forEach((b, bi) => {
    heights[bi] = b.height;
    const projected: [number, number][][] = [];
    for (const ring of b.rings) {
      const pr = ring.map(([lon, lat]) => frame.toXY(lon, lat));
      projected.push(pr);
      for (let i = 0; i < pr.length - 1; i++) {
        const [x1, y1] = pr[i];
        const [x2, y2] = pr[i + 1];
        edges[e * 4] = x1;
        edges[e * 4 + 1] = y1;
        edges[e * 4 + 2] = x2;
        edges[e * 4 + 3] = y2;
        edgeBuilding[e] = bi;
        const ix0 = Math.floor(Math.min(x1, x2) / CELL_M);
        const ix1 = Math.floor(Math.max(x1, x2) / CELL_M);
        const iy0 = Math.floor(Math.min(y1, y2) / CELL_M);
        const iy1 = Math.floor(Math.max(y1, y2) / CELL_M);
        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            const k = cellKey(ix, iy);
            const list = cells.get(k);
            if (list) list.push(e);
            else cells.set(k, [e]);
          }
        }
        e++;
      }
    }
    rings.push(projected);
  });
  return { frame, edges, edgeBuilding, heights, rings, cells, stamp: new Int32Array(edgeCount), stampId: 0 };
}

function pointInRings(x: number, y: number, rings: [number, number][][]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance along the ray to the first building that hides everything beyond it (or `range`). */
function castRay(
  idx: BuildingIndex,
  px: number,
  py: number,
  dx: number,
  dy: number,
  range: number,
  mount: number,
  ignore: Set<number>,
): number {
  const stampId = ++idx.stampId;
  const entries = new Map<number, number>();
  // Amanatides–Woo grid walk so only edges in cells the ray crosses are tested.
  let ix = Math.floor(px / CELL_M);
  let iy = Math.floor(py / CELL_M);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(CELL_M / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(CELL_M / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (ix + 1) * CELL_M : ix * CELL_M) - px) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (iy + 1) * CELL_M : iy * CELL_M) - py) / dy : Infinity;
  let t = 0;
  while (t <= range) {
    const list = idx.cells.get(cellKey(ix, iy));
    if (list) {
      for (const e of list) {
        if (idx.stamp[e] === stampId) continue;
        idx.stamp[e] = stampId;
        const b = idx.edgeBuilding[e];
        if (ignore.has(b)) continue;
        const ax = idx.edges[e * 4];
        const ay = idx.edges[e * 4 + 1];
        const ex = idx.edges[e * 4 + 2] - ax;
        const ey = idx.edges[e * 4 + 3] - ay;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-9) continue;
        const wx = ax - px;
        const wy = ay - py;
        const tHit = (wx * ey - wy * ex) / denom;
        const u = (wx * dy - wy * dx) / denom;
        if (tHit <= 0 || tHit > range || u < 0 || u > 1) continue;
        const prev = entries.get(b);
        if (prev === undefined || tHit < prev) entries.set(b, tHit);
      }
    }
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      ix += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      iy += stepY;
    }
  }
  let clip = range;
  for (const [b, d] of entries) {
    if (d >= clip) continue;
    const hb = idx.heights[b];
    const blocks = hb >= mount - 0.5 || (d * mount) / (mount - hb) >= range;
    if (blocks) clip = d;
  }
  return clip;
}

const BANDS = 6;

export function computeViewshed(pose: CameraPose, idx: BuildingIndex | null, frame: Frame): Viewshed {
  const [px, py] = frame.toXY(pose.lon, pose.lat);
  const R = pose.rangeM;
  const omni = pose.headingDeg === null;
  const start = omni ? 0 : pose.headingDeg! - pose.fovDeg / 2;
  const span = omni ? 360 : pose.fovDeg;
  const rayCount = omni ? 180 : Math.max(12, Math.ceil(span / 2)) + 1;
  const stepDeg = omni ? span / rayCount : span / (rayCount - 1);

  // The camera's own building (it is mounted on/inside it) and anything within 1.5 m never occludes.
  const ignore = new Set<number>();
  if (idx) {
    idx.rings.forEach((rings, bi) => {
      const r0 = rings[0];
      if (!r0) return;
      let near = false;
      for (const [x, y] of r0) {
        if (Math.abs(x - px) < R && Math.abs(y - py) < R) {
          near = true;
          break;
        }
      }
      if (near && pointInRings(px, py, rings)) ignore.add(bi);
    });
  }

  const angles: number[] = [];
  const clips: number[] = [];
  for (let i = 0; i < rayCount; i++) {
    const deg = start + i * stepDeg;
    const rad = (deg * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = Math.cos(rad);
    let clip = idx ? castRay(idx, px, py, dx, dy, R, pose.mountM, ignore) : R;
    if (clip < 1.5 && idx) {
      // Grazing the wall the camera is mounted on: retry ignoring that building.
      clip = castRay(idx, px + dx * 1.5, py + dy * 1.5, dx, dy, R - 1.5, pose.mountM, ignore) + 1.5;
    }
    angles.push(rad);
    clips.push(clip);
  }

  const at = (rad: number, r: number): [number, number] => frame.toLonLat(px + Math.sin(rad) * r, py + Math.cos(rad) * r);
  const apex = frame.toLonLat(px, py);

  const close = (ring: [number, number][]) => {
    if (ring.length) ring.push(ring[0]);
    return ring;
  };

  const visibleRing: [number, number][] = omni ? [] : [apex];
  for (let i = 0; i < rayCount; i++) visibleRing.push(at(angles[i], clips[i]));
  close(visibleRing);

  const runs = (pred: (i: number) => boolean): [number, number][] => {
    const out: [number, number][] = [];
    let s = -1;
    for (let i = 0; i <= rayCount; i++) {
      const ok = i < rayCount && pred(i);
      if (ok && s < 0) s = i;
      if (!ok && s >= 0) {
        out.push([s, i - 1]);
        s = -1;
      }
    }
    return out;
  };

  const blindRings: [number, number][][] = [];
  for (const [a, b] of runs((i) => clips[i] < R - 0.5)) {
    const ring: [number, number][] = [];
    for (let i = a; i <= b; i++) ring.push(at(angles[i], R));
    for (let i = b; i >= a; i--) ring.push(at(angles[i], clips[i]));
    if (ring.length >= 3) blindRings.push(close(ring));
  }

  const bands: Viewshed["bands"] = [];
  for (let k = 0; k < BANDS; k++) {
    const r0 = (R * k) / BANDS;
    const r1 = (R * (k + 1)) / BANDS;
    const height = Math.max(0.5, pose.mountM * (1 - k / BANDS));
    for (const [a, b] of runs((i) => clips[i] > r0 + 0.25)) {
      const ring: [number, number][] = [];
      for (let i = a; i <= b; i++) ring.push(at(angles[i], Math.min(clips[i], r1)));
      if (k === 0) ring.push(apex);
      else for (let i = b; i >= a; i--) ring.push(at(angles[i], r0));
      if (ring.length >= 3) bands.push({ ring: close(ring), height });
    }
  }

  let visArea = 0;
  for (const c of clips) visArea += c * c;
  const visibleFrac = visArea / (rayCount * R * R);

  return { pose, visibleRing, blindRings, bands, visibleFrac };
}
