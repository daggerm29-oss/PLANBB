import * as Cesium from "cesium";
import type { Launch } from "./launches";

/**
 * Estimated launch trajectory (no public telemetry exists for most flights, so this is a
 * physically plausible reconstruction from the pad, target orbit and recovery data):
 *
 *  - Orbit target from the Launch Library orbit abbreviation + mission name heuristics.
 *  - Launch azimuth from the inclination and pad latitude (sin az = cos i / cos lat).
 *  - Ascent along the great circle leaving the pad on that azimuth: altitude follows a
 *    gravity-turn-like curve that is vertical at liftoff and horizontal at insertion; the
 *    downrange curve is scaled so the insertion ground speed equals the perigee velocity,
 *    which makes the hand-off to the Kepler orbit seamless.
 *  - Orbit = conic in the plane of that great circle (Earth rotation ignored, ECEF-fixed),
 *    perigee at the insertion point (GTO / TLI etc. are drawn as transfer ellipses).
 *  - First stage recovery: Hermite curves from the separation state to the drone ship
 *    (LL2 downrange distance) or back to the landing zone (RTLS), vertical at touchdown.
 */

export const EARTH_R = 6_371_000;
const MU = 3.986004418e14;

export type OrbitKind = "circular" | "transfer" | "suborbital";

export interface OrbitSpec {
  kind: OrbitKind;
  label: string;
  insertAltM: number;
  apogeeAltM: number;
  inclinationDeg: number;
}

export type LandingKind = "ASDS" | "RTLS" | "EXPENDED" | "NONE";

export interface MissionEvent {
  id: string;
  t: number;
  label: string;
  booster?: boolean;
}

export interface RocketDims {
  lengthM: number;
  diameterM: number;
}

export interface Geo {
  lat: number;
  lon: number;
  h: number;
}

const ISS_RE = /\b(iss|dragon|crew|cygnus|progress|soyuz ms|axiom|ax-\d|starliner|htv|cargo|tianzhou|shenzhou)\b/i;

export function orbitSpec(l: Launch): OrbitSpec {
  const abbrev = (l.orbit ?? "").toUpperCase();
  const name = `${l.name} ${l.mission ?? ""}`;
  const padLat = Math.abs(l.pad.lat);
  const minInc = Math.ceil(padLat + 0.5);
  const inc = (i: number) => Math.max(i, minInc);

  if (abbrev.includes("SUB")) {
    return { kind: "suborbital", label: "SUB-ORBITAL", insertAltM: 107_000, apogeeAltM: 107_000, inclinationDeg: inc(padLat) };
  }
  if (abbrev === "SSO") return { kind: "circular", label: "SUN-SYNCHRONOUS", insertAltM: 520_000, apogeeAltM: 520_000, inclinationDeg: 97.6 };
  if (abbrev === "PO") return { kind: "circular", label: "POLAR", insertAltM: 500_000, apogeeAltM: 500_000, inclinationDeg: 90 };
  if (abbrev.includes("GTO") || abbrev === "GEO" || abbrev === "GSO") {
    return { kind: "transfer", label: "GEOSTATIONARY TRANSFER", insertAltM: 200_000, apogeeAltM: 35_786_000, inclinationDeg: inc(padLat) };
  }
  if (abbrev === "MEO") return { kind: "transfer", label: "MEDIUM EARTH ORBIT", insertAltM: 200_000, apogeeAltM: 20_200_000, inclinationDeg: inc(55) };
  if (abbrev === "HEO" || abbrev === "MO") return { kind: "transfer", label: "HIGHLY ELLIPTICAL", insertAltM: 220_000, apogeeAltM: 39_000_000, inclinationDeg: inc(63.4) };
  if (abbrev === "TLI" || abbrev === "LO" || abbrev.includes("LUNAR") || abbrev === "SE") {
    return { kind: "transfer", label: "TRANS-LUNAR INJECTION", insertAltM: 200_000, apogeeAltM: 384_400_000, inclinationDeg: inc(padLat) };
  }
  if (abbrev === "HCO" || abbrev === "HELIO" || abbrev === "L1" || abbrev === "L2" || abbrev.includes("MARS")) {
    return { kind: "transfer", label: "ESCAPE TRAJECTORY", insertAltM: 200_000, apogeeAltM: 900_000_000, inclinationDeg: inc(padLat) };
  }
  if (abbrev === "VLEO") return { kind: "circular", label: "VERY LOW EARTH ORBIT", insertAltM: 300_000, apogeeAltM: 300_000, inclinationDeg: inc(53) };
  if (ISS_RE.test(name)) return { kind: "circular", label: "ISS RENDEZVOUS", insertAltM: 210_000, apogeeAltM: 210_000, inclinationDeg: inc(51.64) };
  if (/starlink/i.test(name)) return { kind: "circular", label: "LOW EARTH ORBIT", insertAltM: 280_000, apogeeAltM: 280_000, inclinationDeg: inc(53.2) };
  return { kind: "circular", label: abbrev ? `${l.orbitName ?? abbrev}`.toUpperCase() : "LOW EARTH ORBIT", insertAltM: 220_000, apogeeAltM: 220_000, inclinationDeg: inc(51.6) };
}

/** Launch azimuth (radians from north). Retrograde / polar targets head south, as from Vandenberg / Cape polar. */
export function launchAzimuth(latRad: number, inclinationDeg: number): number {
  const i = Cesium.Math.toRadians(inclinationDeg);
  const s = Cesium.Math.clamp(Math.cos(i) / Math.max(Math.cos(latRad), 1e-6), -1, 1);
  const az = Math.asin(s);
  return inclinationDeg >= 85 ? Math.PI - az : az;
}

/** Point reached by travelling `delta` radians of arc from (lat, lon) on initial azimuth `az`. */
function greatCircle(lat: number, lon: number, az: number, delta: number): { lat: number; lon: number } {
  const sinLat = Math.sin(lat) * Math.cos(delta) + Math.cos(lat) * Math.sin(delta) * Math.cos(az);
  const lat2 = Math.asin(Cesium.Math.clamp(sinLat, -1, 1));
  const lon2 = lon + Math.atan2(Math.sin(az) * Math.sin(delta) * Math.cos(lat), Math.cos(delta) - Math.sin(lat) * sinLat);
  return { lat: lat2, lon: Cesium.Math.negativePiToPi(lon2) };
}

const hermite = (p0: number, m0: number, p1: number, m1: number, u: number) => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
};

function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-9) break;
  }
  return E;
}

export interface Trajectory {
  launch: Launch;
  spec: OrbitSpec;
  dims: RocketDims;
  padLat: number;
  padLon: number;
  groundH: number;
  azimuth: number;
  tInsert: number;
  tSep: number;
  tFairing: number;
  landing: LandingKind;
  landingName: string | null;
  tLand: number;
  events: MissionEvent[];
  periodSec: number;
  /** Semi-major axis / eccentricity of the target conic (perigee at insertion). */
  a: number;
  e: number;
  /** Mission time at which the suborbital flight (if any) ends. */
  tEnd: number;
  geoAt: (t: number) => Geo;
  boosterGeoAt: ((t: number) => Geo) | null;
  /** Ground track point of the recovery site (drone ship / LZ / impact). */
  landingGeo: Geo | null;
  /** Orbit polyline (closed for elliptical orbits, truncated for escape / lunar transfer). */
  orbitGeo: (samples: number) => Geo[];
  setGroundHeight: (h: number) => void;
}

const SUB_APEX_T = 240;

export function buildTrajectory(l: Launch): Trajectory {
  const spec = orbitSpec(l);
  const padLat = Cesium.Math.toRadians(l.pad.lat);
  const padLon = Cesium.Math.toRadians(l.pad.lon);
  const azimuth = launchAzimuth(padLat, spec.inclinationDeg);
  const dims: RocketDims = {
    lengthM: Cesium.Math.clamp(l.rocketLengthM ?? 70, 15, 125),
    diameterM: Cesium.Math.clamp(l.rocketDiameterM ?? 3.7, 1, 10),
  };
  const state = { groundH: 0 };

  const tInsert = spec.kind === "suborbital" ? SUB_APEX_T : 520;
  const tSep = spec.kind === "suborbital" ? 150 : 158;
  const tFairing = 198;

  const rp = EARTH_R + spec.insertAltM;
  const ra = EARTH_R + spec.apogeeAltM;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const n = Math.sqrt(MU / (a * a * a));
  const vp = Math.sqrt(MU * (2 / rp - 1 / a));
  /** Central angle at insertion, chosen so the ascent angular rate equals the perigee rate. */
  const thetaIns = (vp / rp) * (tInsert / 2.3);
  const periodSec = (2 * Math.PI) / n;

  const ascent = (t: number): { theta: number; h: number } => {
    if (spec.kind === "suborbital") {
      const tt = Math.max(t, 0);
      const s = Math.min(tt / (2 * SUB_APEX_T), 1);
      const h = spec.apogeeAltM * Math.max(0, 1 - ((tt - SUB_APEX_T) / SUB_APEX_T) ** 2);
      return { theta: (3_000 * s) / EARTH_R, h: tt > 2 * SUB_APEX_T ? 0 : h };
    }
    const s = Cesium.Math.clamp(t / tInsert, 0, 1);
    return { theta: thetaIns * s ** 2.3, h: spec.insertAltM * (2 * s - s * s) ** 1.6 };
  };

  const orbitAt = (tau: number): { theta: number; h: number } => {
    let M = n * tau;
    // Transfer orbits are not closed in the replay: stop near apogee for escape-class trajectories.
    if (spec.apogeeAltM > 100_000_000) M = Math.min(M, Math.PI * 0.98);
    const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const r = a * (1 - e * Math.cos(E));
    const turns = Math.floor(M / (2 * Math.PI));
    return { theta: thetaIns + nu + turns * 2 * Math.PI, h: r - EARTH_R };
  };

  const geoFromTheta = (theta: number, h: number): Geo => {
    const g = greatCircle(padLat, padLon, azimuth, theta);
    return { lat: g.lat, lon: g.lon, h: state.groundH + h };
  };

  const geoAt = (t: number): Geo => {
    if (t <= 0) return { lat: padLat, lon: padLon, h: state.groundH };
    if (t <= tInsert || spec.kind === "suborbital") {
      const p = ascent(t);
      return geoFromTheta(p.theta, p.h);
    }
    const p = orbitAt(t - tInsert);
    return geoFromTheta(p.theta, p.h);
  };

  // ---- first stage recovery ----
  const core = l.stages.find((s) => (s.type ?? "Core") === "Core") ?? l.stages[0];
  let landing: LandingKind = "NONE";
  if (spec.kind !== "suborbital" && core) {
    if (core.landingAttempt && core.landingType === "RTLS") landing = "RTLS";
    else if (core.landingAttempt) landing = "ASDS";
    else if (core.landingAttempt === false) landing = "EXPENDED";
  } else if (spec.kind !== "suborbital") {
    landing = "EXPENDED";
  }
  const landingName = core?.landingName ?? null;
  const tLand = landing === "RTLS" ? tSep + 310 : landing === "ASDS" ? tSep + 360 : tSep + 300;

  let boosterGeoAt: Trajectory["boosterGeoAt"] = null;
  let landingGeo: Geo | null = null;
  if (landing !== "NONE") {
    const dt = 0.5;
    const s0 = ascent(tSep);
    const s1 = ascent(tSep + dt);
    const dTheta = (s1.theta - s0.theta) / dt;
    const dH = (s1.h - s0.h) / dt;
    const T = tLand - tSep;
    const downKm = landing === "ASDS" ? core?.landingDownrangeKm ?? 600 : landing === "EXPENDED" ? 620 : 0;
    const thetaEnd = landing === "RTLS" ? -1_500 / EARTH_R : (downKm * 1000) / EARTH_R;
    const span = Math.abs(thetaEnd - s0.theta);
    const m0Theta = landing === "RTLS" ? dTheta * T * 0.35 : Math.min(dTheta * T, 2.6 * span);
    const m1Theta = landing === "EXPENDED" ? m0Theta * 0.3 : 0;
    const m1H = landing === "EXPENDED" ? -s0.h * 1.5 : 0;
    boosterGeoAt = (t: number) => {
      const u = Cesium.Math.clamp((t - tSep) / T, 0, 1);
      const theta = hermite(s0.theta, m0Theta, thetaEnd, m1Theta, u);
      const h = Math.max(0, hermite(s0.h, dH * T, 0, m1H, u));
      return geoFromTheta(theta, h);
    };
    const end = greatCircle(padLat, padLon, azimuth, thetaEnd);
    landingGeo = { lat: end.lat, lon: end.lon, h: 0 };
  }

  const events: MissionEvent[] =
    spec.kind === "suborbital"
      ? [
          { id: "liftoff", t: 0, label: "LIFTOFF" },
          { id: "maxq", t: 60, label: "MAX-Q" },
          { id: "meco", t: 150, label: "MAIN ENGINE CUTOFF" },
          { id: "apogee", t: SUB_APEX_T, label: "APOGEE · KÁRMÁN LINE" },
        ]
      : [
          { id: "liftoff", t: 0, label: "LIFTOFF" },
          { id: "maxq", t: 72, label: "MAX-Q" },
          { id: "meco", t: tSep - 3, label: "MECO" },
          { id: "sep", t: tSep, label: "STAGE SEPARATION" },
          { id: "ses1", t: tSep + 8, label: "SECOND ENGINE START" },
          { id: "fairing", t: tFairing, label: "FAIRING DEPLOY" },
          ...(landing === "RTLS" ? [{ id: "boostback", t: tSep + 14, label: "BOOSTBACK BURN", booster: true }] : []),
          ...(landing === "ASDS" || landing === "RTLS"
            ? [
                { id: "entry", t: tLand - 130, label: "ENTRY BURN", booster: true },
                { id: "landing", t: tLand - 2, label: landing === "RTLS" ? "LANDING · LZ" : `LANDING · ${landingName ?? "DRONE SHIP"}`, booster: true },
              ]
            : []),
          { id: "seco", t: tInsert, label: "SECO · ORBIT INSERTION" },
        ];
  events.sort((x, y) => x.t - y.t);

  const orbitGeo = (samples: number): Geo[] => {
    const out: Geo[] = [];
    if (spec.kind === "suborbital") {
      for (let i = 0; i <= samples; i++) out.push(geoAt((i / samples) * 2 * SUB_APEX_T));
      return out;
    }
    const escape = spec.apogeeAltM > 100_000_000;
    const maxNu = escape ? Math.PI * 0.98 : 2 * Math.PI;
    for (let i = 0; i <= samples; i++) {
      const nu = (i / samples) * maxNu;
      const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
      out.push(geoFromTheta(thetaIns + nu, r - EARTH_R));
    }
    return out;
  };

  return {
    launch: l,
    spec,
    dims,
    padLat,
    padLon,
    get groundH() {
      return state.groundH;
    },
    azimuth,
    tInsert,
    tSep,
    tFairing,
    landing,
    landingName,
    tLand,
    events,
    periodSec,
    a,
    e,
    tEnd: spec.kind === "suborbital" ? 2 * SUB_APEX_T : Number.POSITIVE_INFINITY,
    geoAt,
    boosterGeoAt,
    landingGeo,
    orbitGeo,
    setGroundHeight: (h: number) => {
      state.groundH = h;
    },
  };
}

export const toCartesian = (g: Geo, out?: Cesium.Cartesian3) => Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.h, Cesium.Ellipsoid.WGS84, out);

/** Speed (m/s) from a central difference of the trajectory. */
export function speedAt(fn: (t: number) => Geo, t: number): number {
  const a = toCartesian(fn(t - 0.25));
  const b = toCartesian(fn(t + 0.25));
  return Cesium.Cartesian3.distance(a, b) / 0.5;
}

export function phaseLabel(tr: Trajectory, t: number): string {
  if (t < 0) return "PRE-LAUNCH · TERMINAL COUNT";
  if (tr.spec.kind === "suborbital") return t < tr.tSep ? "POWERED ASCENT" : t < SUB_APEX_T ? "COAST TO APOGEE" : "DESCENT";
  if (t < tr.tSep) return "STAGE 1 · POWERED ASCENT";
  if (t < tr.tInsert) return "STAGE 2 · ORBITAL ASCENT";
  return tr.spec.kind === "transfer" ? `${tr.spec.label} · COAST` : "ON ORBIT";
}
