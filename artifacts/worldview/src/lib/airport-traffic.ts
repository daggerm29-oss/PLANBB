import { KTS_TO_MS } from "./tracked-entity";

const FT_TO_M = 0.3048;

/** Row returned by `/api/proxy/adsb/airport`. */
export interface RawAirportContact {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  dbFlags?: number;
  category?: string;
  lat: number;
  lon: number;
  alt_baro?: number | "ground";
  /** GNSS altitude, ft above the WGS84 ellipsoid. */
  alt_geom?: number;
  baro_rate?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  squawk?: string;
  seen?: number;
  seen_pos?: number;
  ground?: boolean;
}

export type ContactPhase = "parked" | "taxi" | "takeoff" | "airborne";

export interface AirportContact {
  hex: string;
  callsign: string;
  registration?: string;
  type?: string;
  desc?: string;
  category?: string;
  military: boolean;
  /** Surface vehicles (ADS-B categories C1–C3): tugs, fire trucks, follow-me cars. */
  vehicle: boolean;
  lat: number;
  lon: number;
  onGround: boolean;
  phase: ContactPhase;
  altBaroFt: number | null;
  /** Ellipsoidal height (m) from GNSS altitude, when the transponder reports it. */
  altGeomM: number | null;
  /** Height above the field (m), from barometric altitude; used when GNSS altitude is missing. */
  aglM: number;
  speedMs: number;
  gsKt: number | null;
  headingDeg: number;
  vsFpm: number | null;
  squawk?: string;
  /** Age of the position fix (s) when the snapshot was produced. */
  ageSec: number;
}

const HEAVY_TYPES = /^(A33|A34|A35|A38|B74|B76|B77|B78|MD11|IL96|A124|A225|C5|C17|KC10|K35|E3)/;

/** Model scale (glTF model is ~1.9 units long) so each aircraft is roughly its real length. */
export function contactScale(c: Pick<AirportContact, "category" | "type" | "military">): number {
  if (c.type && HEAVY_TYPES.test(c.type)) return 34;
  switch (c.category) {
    case "A1": return 6;
    case "A2": return 11;
    case "A3": return 20;
    case "A4": return 25;
    case "A5": return 34;
    case "A6": return 10;
    case "A7": return 7;
    default: return c.military ? 12 : 20;
  }
}

export function contactModelFile(c: Pick<AirportContact, "military">): string {
  return c.military ? "military-aircraft.glb" : "aeroplane.glb";
}

/** Distance (glTF units) from the model origin down to its wheels; from scripts/analyze-glb.mjs. */
export const MODEL_WHEEL_DEPTH: Record<string, number> = {
  "aeroplane.glb": 0.296,
  "military-aircraft.glb": 0.226,
};

const MAX_GROUND_SPEED_KT = 45;
const TAKEOFF_SPEED_KT = 45;
const NEAR_FIELD_FT = 200;

export function normalizeContact(raw: RawAirportContact, fieldElevFt: number): AirportContact | null {
  if (!raw.hex || typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
  const altBaroFt = typeof raw.alt_baro === "number" ? raw.alt_baro : null;
  const gsKt = typeof raw.gs === "number" ? raw.gs : null;
  const vehicle = typeof raw.category === "string" && /^C[1-3]$/.test(raw.category);
  const aboveFieldFt = altBaroFt === null ? null : altBaroFt - fieldElevFt;
  // Many transponders keep sending a barometric altitude while taxiing; slow + at field
  // elevation is treated as on the ground so the aircraft sits on the taxiway.
  const reportedGround = raw.alt_baro === "ground" || raw.ground === true;
  const inferredGround =
    !reportedGround && gsKt !== null && gsKt < MAX_GROUND_SPEED_KT && aboveFieldFt !== null && aboveFieldFt < NEAR_FIELD_FT && fieldElevFt !== 0;
  const onGround = vehicle || reportedGround || inferredGround;

  let phase: ContactPhase = "airborne";
  if (onGround) {
    if (gsKt === null || gsKt < 2) phase = "parked";
    else if (gsKt >= TAKEOFF_SPEED_KT) phase = "takeoff";
    else phase = "taxi";
  }

  const headingDeg = raw.true_heading ?? raw.track ?? 0;
  return {
    hex: raw.hex.toLowerCase(),
    callsign: (raw.flight ?? "").trim() || (raw.r ?? "").trim() || raw.hex.toUpperCase(),
    registration: raw.r,
    type: raw.t,
    desc: raw.desc,
    category: raw.category,
    military: ((raw.dbFlags ?? 0) & 1) === 1,
    vehicle,
    lat: raw.lat,
    lon: raw.lon,
    onGround,
    phase,
    altBaroFt,
    altGeomM: !onGround && typeof raw.alt_geom === "number" ? raw.alt_geom * FT_TO_M : null,
    aglM: onGround || aboveFieldFt === null ? 0 : Math.max(0, aboveFieldFt * FT_TO_M),
    speedMs: (gsKt ?? 0) * KTS_TO_MS,
    gsKt,
    headingDeg,
    vsFpm: typeof raw.baro_rate === "number" ? raw.baro_rate : null,
    squawk: raw.squawk,
    ageSec: Math.max(0, raw.seen_pos ?? raw.seen ?? 0),
  };
}

export function phaseLabel(c: AirportContact): string {
  switch (c.phase) {
    case "parked": return "PARKED";
    case "taxi": return "TAXI";
    case "takeoff": return "ROLL";
    default: {
      if (c.vsFpm !== null && c.vsFpm < -300) return "APPROACH";
      if (c.vsFpm !== null && c.vsFpm > 300) return "CLIMB";
      return "AIRBORNE";
    }
  }
}

export const PHASE_COLOR: Record<ContactPhase, string> = {
  parked: "#8fa3b8",
  taxi: "#7dff9a",
  takeoff: "#ffd34d",
  airborne: "#00e5ff",
};

export function formatAltitude(c: AirportContact): string {
  if (c.onGround) return "GND";
  if (c.altBaroFt === null) return "—";
  return c.altBaroFt >= 18000 ? `FL${Math.round(c.altBaroFt / 100)}` : `${Math.round(c.altBaroFt).toLocaleString()} ft`;
}
