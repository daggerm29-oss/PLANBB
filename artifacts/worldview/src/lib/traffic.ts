/**
 * Street traffic engine (pure, no map/DOM). Road "lanes" are directional polylines built from
 * either TomTom flow segments (live) or OpenMapTiles roads (geometry / simulation). Vehicles move
 * along lanes at the lane's flow speed and hop onto connected lanes at their ends.
 */

export type RoadClass = "motorway" | "trunk" | "primary" | "secondary" | "tertiary" | "street";
export type RoadMode = "tomtom" | "osm" | "hybrid";
export type VehicleKind = "car" | "truck" | "bus" | "moto";
export type FlowSource = "live" | "matched" | "sim";

export const ROAD_MODES: RoadMode[] = ["hybrid", "tomtom", "osm"];

export interface Lane {
  id: string;
  coords: [number, number][];
  cum: number[];
  length: number;
  cls: RoadClass;
  /** Current speed / free-flow speed, 0..1. */
  level: number;
  closed: boolean;
  flow: FlowSource;
  /** Offset to the driving side (m); 0 for one-way roads drawn on the centreline. */
  sideOffsetM: number;
  leftHand: boolean;
  /** Fixed phase so simulated congestion differs per lane but stays stable across rebuilds. */
  seed: number;
}

export interface Vehicle {
  id: string;
  label: string;
  kind: VehicleKind;
  lane: Lane;
  s: number;
  seg: number;
  speed: number;
  jitter: number;
}

export interface VehicleRender {
  lon: number;
  lat: number;
  bearing: number;
  kmh: number;
}

export const FREE_FLOW_KMH: Record<RoadClass, number> = {
  motorway: 105,
  trunk: 85,
  primary: 60,
  secondary: 50,
  tertiary: 42,
  street: 30,
};

/** Vehicles per km per lane at free flow; congestion multiplies this up. */
const BASE_DENSITY_PER_KM: Record<RoadClass, number> = {
  motorway: 22,
  trunk: 18,
  primary: 14,
  secondary: 10,
  tertiary: 7,
  street: 4,
};

const SIDE_OFFSET_M: Record<RoadClass, number> = {
  motorway: 6,
  trunk: 5,
  primary: 3.5,
  secondary: 3,
  tertiary: 2.6,
  street: 2.2,
};

export const MAX_VEHICLES = 2200;

/** Jam (red) -> heavy (orange) -> slow (yellow) -> free (green); matches the flow line ramp. */
export function levelColor(level: number, closed: boolean): string {
  if (closed) return "#9b1c31";
  if (level < 0.25) return "#ff2d55";
  if (level < 0.5) return "#ff9500";
  if (level < 0.75) return "#ffd60a";
  return "#34d399";
}

export function levelLabel(level: number, closed: boolean): string {
  if (closed) return "CLOSED";
  if (level < 0.25) return "JAM";
  if (level < 0.5) return "HEAVY";
  if (level < 0.75) return "SLOW";
  return "FREE";
}

const TOMTOM_TYPE: Record<string, RoadClass> = {
  motorway: "motorway",
  "international road": "trunk",
  "major road": "primary",
  "secondary road": "secondary",
  "connecting road": "tertiary",
  "major local road": "tertiary",
  "local road": "street",
  "minor local road": "street",
};

const TOMTOM_CATEGORY: Record<string, RoadClass> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  street: "street",
};

/** TomTom `road_type`/`road_category` -> class; null for non-public/parking roads. */
export function tomtomClass(props: Record<string, unknown>): RoadClass | null {
  const cat = typeof props.road_category === "string" ? TOMTOM_CATEGORY[props.road_category] : undefined;
  if (cat) return cat;
  const type = typeof props.road_type === "string" ? props.road_type.toLowerCase() : "";
  return TOMTOM_TYPE[type] ?? null;
}

const OMT_CLASS: Record<string, RoadClass> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  minor: "street",
};

export function osmClass(props: Record<string, unknown>): RoadClass | null {
  const cls = typeof props.class === "string" ? OMT_CLASS[props.class] : undefined;
  if (!cls) return null;
  if (props.brunnel === "tunnel") return null;
  return cls;
}

function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_320;

function segMeters(a: [number, number], b: [number, number]): number {
  const kx = M_PER_DEG_LAT * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG_LAT);
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const kx = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function coordKey(c: [number, number]): string {
  return `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
}

interface LaneInput {
  coords: [number, number][];
  cls: RoadClass;
  level: number;
  closed: boolean;
  flow: FlowSource;
  twoWay: boolean;
  leftHand: boolean;
}

export function makeLane(input: LaneInput): Lane | null {
  const coords = input.coords;
  if (coords.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segMeters(coords[i - 1], coords[i]));
  const length = cum[cum.length - 1];
  if (length < 8) return null;
  const id = `${coordKey(coords[0])}>${coordKey(coords[coords.length - 1])}:${Math.round(length)}`;
  return {
    id,
    coords,
    cum,
    length,
    cls: input.cls,
    level: Math.min(1, Math.max(0, input.level)),
    closed: input.closed,
    flow: input.flow,
    sideOffsetM: input.twoWay ? SIDE_OFFSET_M[input.cls] : 0,
    leftHand: input.leftHand,
    seed: hash32(id),
  };
}

type Line = [number, number][];

function linesOf(geom: GeoJSON.Geometry): Line[] {
  if (geom.type === "LineString") return [geom.coordinates as Line];
  if (geom.type === "MultiLineString") return geom.coordinates as Line[];
  return [];
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function intersects(line: Line, b: Bounds): boolean {
  for (const [x, y] of line) if (x >= b.west && x <= b.east && y >= b.south && y <= b.north) return true;
  return false;
}

/** TomTom flow features -> directional lanes (flow tiles already carry one feature per direction). */
export function lanesFromTomTom(features: GeoJSON.Feature[], bounds: Bounds): Lane[] {
  const out = new Map<string, Lane>();
  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const cls = tomtomClass(props);
    if (!cls || !f.geometry) continue;
    const level = typeof props.traffic_level === "number" ? props.traffic_level : 1;
    const closed = props.road_closure === true || props.road_closure === 1 || props.road_closure === "true";
    const twoWay = props.traffic_road_coverage === "one_side";
    const leftHand = props.left_hand_traffic === true || props.left_hand_traffic === 1 || props.left_hand_traffic === "true";
    for (const line of linesOf(f.geometry)) {
      if (!intersects(line, bounds)) continue;
      const lane = makeLane({ coords: line, cls, level, closed, flow: "live", twoWay, leftHand });
      if (lane && !out.has(lane.id)) out.set(lane.id, lane);
    }
  }
  return [...out.values()];
}

/** OpenMapTiles roads -> lanes (both directions unless one-way). Flow is filled in later. */
export function lanesFromOsm(features: GeoJSON.Feature[], bounds: Bounds, leftHand: boolean): Lane[] {
  const out = new Map<string, Lane>();
  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const cls = osmClass(props);
    if (!cls || !f.geometry) continue;
    const oneway = Number(props.oneway ?? 0);
    for (const line of linesOf(f.geometry)) {
      if (!intersects(line, bounds)) continue;
      const dirs: Line[] = oneway === 1 ? [line] : oneway === -1 ? [[...line].reverse()] : [line, [...line].reverse()];
      for (const coords of dirs) {
        const lane = makeLane({ coords, cls, level: 1, closed: false, flow: "sim", twoWay: oneway === 0, leftHand });
        if (lane && !out.has(lane.id)) out.set(lane.id, lane);
      }
    }
  }
  return [...out.values()];
}

/** Rough time-of-day congestion so simulation looks plausible (rush hours slower). */
function rushFactor(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  const peak = (c: number, w: number) => Math.exp(-((h - c) ** 2) / (2 * w * w));
  return Math.max(peak(8.25, 1.1), peak(17.75, 1.3) * 1.1, 0.25 * peak(13, 2));
}

export function simulatedLevel(lane: Pick<Lane, "seed" | "cls">, now: Date): number {
  const r = mulberry32(lane.seed);
  const base = 0.92 - rushFactor(now) * (lane.cls === "street" ? 0.25 : 0.5);
  const wave = Math.sin(now.getTime() / 90_000 + r() * Math.PI * 2) * 0.18;
  const incident = r() < 0.06 ? -0.45 : 0;
  return Math.min(1, Math.max(0.05, base + wave + incident));
}

/**
 * Match flow from TomTom lanes onto OSM lanes: a spatial hash of TomTom sample points, then each
 * OSM lane takes the level of the nearest same-direction TomTom sample (<=22 m, <=40° off).
 */
export function matchFlow(osmLanes: Lane[], tomtomLanes: Lane[]): number {
  if (tomtomLanes.length === 0) return 0;
  const CELL = 0.0003;
  const grid = new Map<string, { lon: number; lat: number; brg: number; lane: Lane }[]>();
  const cellKey = (lon: number, lat: number) => `${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`;
  for (const lane of tomtomLanes) {
    for (let i = 1; i < lane.coords.length; i++) {
      const a = lane.coords[i - 1];
      const b = lane.coords[i];
      const brg = bearingDeg(a, b);
      const steps = Math.max(1, Math.ceil(segMeters(a, b) / 15));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const lon = a[0] + (b[0] - a[0]) * t;
        const lat = a[1] + (b[1] - a[1]) * t;
        const key = cellKey(lon, lat);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push({ lon, lat, brg, lane });
      }
    }
  }

  let matched = 0;
  for (const lane of osmLanes) {
    const mid = Math.floor((lane.coords.length - 1) / 2);
    const a = lane.coords[mid];
    const b = lane.coords[mid + 1];
    const lon = (a[0] + b[0]) / 2;
    const lat = (a[1] + b[1]) / 2;
    const brg = bearingDeg(a, b);
    const cx = Math.floor(lon / CELL);
    const cy = Math.floor(lat / CELL);
    let best: Lane | null = null;
    let bestD = 22;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const dBrg = Math.abs(((p.brg - brg + 540) % 360) - 180);
          if (dBrg > 40) continue;
          const d = segMeters([lon, lat], [p.lon, p.lat]);
          if (d < bestD) {
            bestD = d;
            best = p.lane;
          }
        }
      }
    }
    if (best) {
      lane.level = best.level;
      lane.closed = best.closed;
      lane.flow = "matched";
      matched++;
    }
  }
  return matched;
}

/** Start-point index so vehicles reaching a lane end can continue onto a connected lane. */
export function buildConnections(lanes: Lane[]): Map<string, Lane[]> {
  const byStart = new Map<string, Lane[]>();
  for (const lane of lanes) {
    const key = coordKey(lane.coords[0]);
    let list = byStart.get(key);
    if (!list) byStart.set(key, (list = []));
    list.push(lane);
  }
  return byStart;
}

function nextLane(lane: Lane, connections: Map<string, Lane[]>, rnd: () => number): Lane | null {
  const end = lane.coords[lane.coords.length - 1];
  const candidates = (connections.get(coordKey(end)) ?? []).filter((l) => {
    if (l === lane || l.closed) return false;
    // No U-turns: skip the reverse carriageway of the same road.
    const lEnd = l.coords[l.coords.length - 1];
    return coordKey(lEnd) !== coordKey(lane.coords[0]);
  });
  if (candidates.length === 0) return null;
  const inBrg = bearingDeg(lane.coords[lane.coords.length - 2], end);
  const scored = candidates.map((l) => {
    const dBrg = Math.abs(((bearingDeg(l.coords[0], l.coords[1]) - inBrg + 540) % 360) - 180);
    return { l, w: Math.max(0.05, 1 - dBrg / 120) * (l.cls === lane.cls ? 1.6 : 1) };
  });
  const total = scored.reduce((s, c) => s + c.w, 0);
  let pick = rnd() * total;
  for (const c of scored) {
    pick -= c.w;
    if (pick <= 0) return c.l;
  }
  return scored[scored.length - 1].l;
}

function vehicleKind(cls: RoadClass, r: number): VehicleKind {
  if (cls === "motorway" || cls === "trunk") return r < 0.16 ? "truck" : r < 0.19 ? "bus" : r < 0.21 ? "moto" : "car";
  if (cls === "primary" || cls === "secondary") return r < 0.06 ? "truck" : r < 0.12 ? "bus" : r < 0.16 ? "moto" : "car";
  return r < 0.03 ? "truck" : r < 0.05 ? "bus" : r < 0.1 ? "moto" : "car";
}

const KIND_PREFIX: Record<VehicleKind, string> = { car: "CAR", truck: "HGV", bus: "BUS", moto: "MC" };

let vehicleCounter = 0;

function spawn(lane: Lane, s: number, rnd: () => number): Vehicle {
  vehicleCounter = (vehicleCounter + 1) % 0xffff;
  const kind = vehicleKind(lane.cls, rnd());
  const tag = ((hash32(`${lane.id}:${s}:${vehicleCounter}`) & 0xffff) >>> 0).toString(16).toUpperCase().padStart(4, "0");
  let seg = 0;
  while (seg < lane.cum.length - 2 && lane.cum[seg + 1] < s) seg++;
  return {
    id: `${KIND_PREFIX[kind]}-${tag}`,
    label: `${KIND_PREFIX[kind]}-${tag}`,
    kind,
    lane,
    s,
    seg,
    speed: 0,
    jitter: 0.88 + rnd() * 0.24,
  };
}

export function targetCount(lane: Lane, density: number): number {
  if (lane.closed) return Math.round((lane.length / 1000) * BASE_DENSITY_PER_KM[lane.cls] * 2.5 * density);
  const congestion = 1 + 1.8 * (1 - lane.level);
  return (lane.length / 1000) * BASE_DENSITY_PER_KM[lane.cls] * congestion * density;
}

/**
 * Reconcile vehicles with a rebuilt lane set: keep vehicles whose lane still exists (rebinding to
 * the fresh lane object so new flow applies), drop the rest, and top lanes up to their density.
 */
export function reconcileVehicles(prev: Vehicle[], lanes: Lane[], density: number, maxVehicles = MAX_VEHICLES): Vehicle[] {
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const counts = new Map<string, number>();
  const kept: Vehicle[] = [];
  for (const v of prev) {
    const lane = byId.get(v.lane.id);
    if (!lane) continue;
    v.lane = lane;
    kept.push(v);
    counts.set(lane.id, (counts.get(lane.id) ?? 0) + 1);
  }

  const wanted = lanes.map((l) => targetCount(l, density));
  const totalWanted = wanted.reduce((s, n) => s + n, 0);
  const scale = totalWanted > maxVehicles ? maxVehicles / totalWanted : 1;
  const rnd = mulberry32(Date.now() & 0xffffffff);
  const out = kept.slice(0, maxVehicles);

  lanes.forEach((lane, i) => {
    const exact = wanted[i] * scale;
    let n = Math.floor(exact) + (rnd() < exact % 1 ? 1 : 0);
    n -= counts.get(lane.id) ?? 0;
    for (let k = 0; k < n && out.length < maxVehicles; k++) {
      out.push(spawn(lane, rnd() * lane.length, rnd));
    }
  });
  return out;
}

/** Advance all vehicles by dt seconds (smoothly easing toward each lane's flow speed). */
export function stepVehicles(vehicles: Vehicle[], dt: number, connections: Map<string, Lane[]>, rnd: () => number = Math.random) {
  const ease = 1 - Math.exp(-dt / 1.5);
  for (const v of vehicles) {
    const lane = v.lane;
    const freeMs = FREE_FLOW_KMH[lane.cls] / 3.6;
    let target = lane.closed ? 0 : freeMs * Math.max(0.04, lane.level) * v.jitter;
    // Stop-and-go in jams so queues visibly crawl instead of gliding.
    if (!lane.closed && lane.level < 0.25) target *= 0.5 + 0.5 * Math.max(0, Math.sin(performance.now() / 1400 + lane.seed));
    v.speed += (target - v.speed) * ease;
    v.s += v.speed * dt;
    if (v.s >= lane.length) {
      const next = nextLane(lane, connections, rnd);
      const over = v.s - lane.length;
      if (next) {
        v.lane = next;
        v.s = Math.min(over, next.length);
      } else {
        v.s = over % lane.length;
      }
      v.seg = 0;
    }
    const cum = v.lane.cum;
    while (v.seg < cum.length - 2 && cum[v.seg + 1] < v.s) v.seg++;
  }
}

export function vehiclePosition(v: Vehicle): VehicleRender {
  const { coords, cum, sideOffsetM, leftHand } = v.lane;
  const i = Math.min(v.seg, coords.length - 2);
  const a = coords[i];
  const b = coords[i + 1];
  const segLen = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (v.s - cum[i]) / segLen));
  let lon = a[0] + (b[0] - a[0]) * t;
  let lat = a[1] + (b[1] - a[1]) * t;
  const bearing = bearingDeg(a, b);
  if (sideOffsetM > 0) {
    const rad = (bearing * Math.PI) / 180;
    const side = leftHand ? -1 : 1;
    const east = Math.cos(rad) * sideOffsetM * side;
    const north = -Math.sin(rad) * sideOffsetM * side;
    lon += east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    lat += north / M_PER_DEG_LAT;
  }
  return { lon, lat, bearing, kmh: v.speed * 3.6 };
}

/** Coarse boxes for major left-hand-traffic regions; used only to pick the simulated driving side. */
const LEFT_HAND_BOXES: [number, number, number, number][] = [
  [-10.7, 49.8, 1.9, 60.9], // UK + Ireland
  [122.9, 24.0, 146.0, 45.6], // Japan
  [68.0, 6.5, 97.5, 35.5], // India / Bangladesh / Sri Lanka
  [112.9, -43.7, 153.7, -10.6], // Australia
  [166.3, -47.4, 178.6, -34.3], // New Zealand
  [16.4, -34.9, 32.9, -22.1], // South Africa
  [95.0, -11.0, 141.0, 6.0], // Indonesia
  [97.3, 5.6, 105.7, 20.5], // Thailand
  [99.6, 0.8, 119.3, 7.4], // Malaysia
  [113.8, 22.1, 114.5, 22.6], // Hong Kong
];

export function isLeftHandTraffic(lon: number, lat: number): boolean {
  return LEFT_HAND_BOXES.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);
}

export interface TrafficStats {
  mode: "live" | "simulation";
  roadMode: RoadMode;
  status: "zoom-in" | "loading" | "ready" | "hidden";
  lanes: number;
  liveLanes: number;
  matchedLanes: number;
  simLanes: number;
  vehicles: number;
  meanLevel: number;
  meanKmh: number;
  jammedFrac: number;
  closures: number;
  updatedAt: number | null;
}

export function summarize(lanes: Lane[], vehicles: Vehicle[]): Omit<TrafficStats, "mode" | "roadMode" | "status" | "updatedAt"> {
  let live = 0;
  let matched = 0;
  let sim = 0;
  let lenSum = 0;
  let levelSum = 0;
  let jamLen = 0;
  let closures = 0;
  for (const l of lanes) {
    if (l.flow === "live") live++;
    else if (l.flow === "matched") matched++;
    else sim++;
    lenSum += l.length;
    levelSum += l.level * l.length;
    if (l.level < 0.4 || l.closed) jamLen += l.length;
    if (l.closed) closures++;
  }
  let kmh = 0;
  for (const v of vehicles) kmh += v.speed * 3.6;
  return {
    lanes: lanes.length,
    liveLanes: live,
    matchedLanes: matched,
    simLanes: sim,
    vehicles: vehicles.length,
    meanLevel: lenSum ? levelSum / lenSum : 1,
    meanKmh: vehicles.length ? kmh / vehicles.length : 0,
    jammedFrac: lenSum ? jamLen / lenSum : 0,
    closures,
  };
}
