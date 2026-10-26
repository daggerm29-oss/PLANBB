export type TrackKind = "aircraft" | "ship" | "satellite";

export interface EntityRef {
  kind: TrackKind;
  id: string;
}

/** Normalised live state fed to the cinematic 3D tracker. */
export interface FollowTarget {
  kind: TrackKind;
  id: string;
  modelUrl: string;
  lat?: number;
  lon?: number;
  /** Altitude above the ellipsoid in metres. */
  altM?: number;
  headingDeg?: number;
  /** Ground speed in m/s (used for dead reckoning between samples). */
  speedMs?: number;
  /** Ships: true when SOG/COG were missing and speedMs/headingDeg are estimates. */
  motionEstimated?: boolean;
  /** How old the position already was when received (e.g. ADS-B `seen`). */
  sampleAgeSec?: number;
  /** Satellites: exact Earth-fixed position (metres) from SGP4, used for the model and orbit path. */
  ecefAt?: (when: Date) => { x: number; y: number; z: number } | null;
  orbitPeriodSec?: number;
  /** Aircraft identity for the cockpit HUD. */
  callsign?: string;
  registration?: string;
  typeCode?: string;
  squawk?: string;
  military?: boolean;
}

/**
 * Per-model placement, from `scripts/analyze-glb.mjs`. Every model is ~1.9 units
 * long on its glTF X axis and centred on the origin.
 * - headingOffsetDeg: added to the course so the nose points along the direction of travel.
 * - keelDepth: model units from origin to keel minus draft, so the hull sits in the water.
 */
export const MODEL_GEOMETRY: Record<string, { headingOffsetDeg: number; keelDepth: number; scale?: number }> = {
  // Real-world scale (model is ~1.9 units long): airliner ~65 m, fighter ~22 m.
  "aeroplane.glb": { headingOffsetDeg: 180, keelDepth: 0, scale: 34 },
  "military-aircraft.glb": { headingOffsetDeg: 180, keelDepth: 0, scale: 12 },
  "ship.glb": { headingOffsetDeg: 180, keelDepth: 0.399 - 0.11 },
  "tanker.glb": { headingOffsetDeg: 180, keelDepth: 0.283 - 0.1 },
  "satellite.glb": { headingOffsetDeg: -90, keelDepth: 0 },
  "iss.glb": { headingOffsetDeg: -90, keelDepth: 0 },
};

const MODEL_FILES = ["aeroplane.glb", "military-aircraft.glb", "ship.glb", "tanker.glb", "satellite.glb", "iss.glb"];
let modelsPreloaded = false;

/** Warms the HTTP cache so the first double-click doesn't wait on a model download. */
export function preloadModels(base: string): void {
  if (modelsPreloaded || typeof window === "undefined") return;
  modelsPreloaded = true;
  const run = () => {
    for (const f of MODEL_FILES) {
      fetch(`${base}/${f}`, { priority: "low" } as RequestInit).catch(() => {});
    }
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}

export const FT_TO_M = 0.3048;
export const KTS_TO_MS = 0.514444;

export function altMetersFromBaro(alt: number | string | undefined): number {
  if (alt === undefined || alt === null) return 300;
  if (alt === "ground") return 0;
  const n = Number(alt);
  return Number.isNaN(n) ? 300 : n * FT_TO_M;
}

/**
 * Typical service speed per vessel category, used by the 3D view when the feed has no
 * SOG (many dark-fleet / gap contacts report N/A) so the ship still sails realistically.
 */
export function shipCruiseSpeedMs(category?: string): number {
  const c = (category ?? "").toUpperCase();
  if (c.includes("MIL") || c.includes("NAVY")) return 18 * KTS_TO_MS;
  if (c.includes("TANKER")) return 12 * KTS_TO_MS;
  return 14 * KTS_TO_MS;
}

/** Deterministic fallback course (deg) for vessels without COG, so the heading doesn't change between renders. */
export function stableHeadingDeg(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

export function shipModel(base: string, category?: string): string {
  return `${base}/${category === "TANKER" ? "tanker.glb" : "ship.glb"}`;
}

export function satelliteModel(base: string, name: string): string {
  return `${base}/${/ISS|ZARYA/i.test(name) ? "iss.glb" : "satellite.glb"}`;
}

export function aircraftModel(base: string, military: boolean): string {
  return `${base}/${military ? "military-aircraft.glb" : "aeroplane.glb"}`;
}

/** Initial bearing (deg) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
