/** Shared types + geo helpers for the first-person cockpit view. */

export interface CockpitContact {
  hex: string;
  callsign: string;
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
  speedMs: number;
  military: boolean;
  typeCode?: string;
}

export interface CockpitVessel {
  lat: number;
  lon: number;
  category?: string;
}

/** Live context around the ownship, read from the same feeds the 2D map already polls. */
export interface CockpitContext {
  aircraft: CockpitContact[];
  ships: CockpitVessel[];
  /** Wall-clock ms when the aircraft feed array last changed (for dead reckoning). */
  aircraftSampleMs: number;
}

export interface CockpitTelemetry {
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
  speedMs: number;
  /** Flight path pitch (deg, + = climbing). */
  pitchDeg: number;
  /** Bank angle (deg, + = right wing down). */
  rollDeg: number;
  verticalRateMs: number;
  lookYawDeg: number;
  lookPitchDeg: number;
  fovDeg: number;
}

const R = 6371008.8;
const RAD = Math.PI / 180;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Moves a contact forward along its track for `seconds` (flat-earth, fine for < 1 min). */
export function deadReckon(c: CockpitContact, seconds: number): { lat: number; lon: number } {
  const d = c.speedMs * Math.max(0, Math.min(seconds, 90));
  const h = c.headingDeg * RAD;
  const cosLat = Math.max(Math.cos(c.lat * RAD), 0.01);
  return {
    lat: c.lat + (d * Math.cos(h)) / (R * RAD),
    lon: c.lon + (d * Math.sin(h)) / (R * RAD * cosLat),
  };
}

export const M_TO_FT = 3.28084;
export const MS_TO_KTS = 1.943844;

export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}°${ns} ${Math.abs(lon).toFixed(4)}°${ew}`;
}

export function formatDistance(m: number): string {
  const nm = m / 1852;
  return nm >= 10 ? `${nm.toFixed(0)} NM` : `${nm.toFixed(1)} NM`;
}

export function compassPoint(deg: number): string {
  const pts = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return pts[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
