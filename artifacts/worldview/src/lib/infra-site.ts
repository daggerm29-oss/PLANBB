import {
  INFRA_COLORS, formatMw,
  type CableRoute, type Dam, type DataCenter, type InfraSelection, type LandingPoint,
} from "./infrastructure";

export type SiteKind = "dam" | "datacenter" | "landing";

/** A point installation the 360° view can orbit. Built from any non-cable InfraSelection. */
export interface InfraSite {
  key: string;
  kind: SiteKind;
  name: string;
  lat: number;
  lon: number;
  color: string;
  kindLabel: string;
  subtitle: string | null;
  rows: [string, string][];
  /** Rough importance (0..3) used to size stems and order the nearby list. */
  rank: number;
  sel: InfraSelection;
}

export interface NearbySite extends InfraSite {
  distKm: number;
  bearingDeg: number;
}

export const KIND_LABEL: Record<SiteKind, string> = { dam: "DAM", datacenter: "DATA CENTRE", landing: "CABLE LANDING" };
const KIND_COLOR: Record<SiteKind, string> = { dam: INFRA_COLORS.dams, datacenter: INFRA_COLORS.datacenters, landing: INFRA_COLORS.landings };

/** Orbit framing per kind: dams are big structures, data centres are single buildings. */
export function orbitFraming(site: InfraSite): { range: number; pitchDeg: number } {
  if (site.kind === "datacenter") return { range: 620, pitchDeg: -32 };
  if (site.kind === "landing") return { range: 900, pitchDeg: -30 };
  const d = site.sel.kind === "dam" ? site.sel.dam : null;
  const mw = d?.mw ?? 0;
  const h = d?.heightM ?? 0;
  const range = mw >= 5000 ? 3200 : mw >= 1000 || h >= 150 ? 2200 : mw >= 100 || h >= 60 ? 1500 : 1000;
  return { range, pitchDeg: -28 };
}

function damRank(d: Dam) {
  if ((d.mw ?? 0) >= 500 || (d.heightM ?? 0) >= 100) return 3;
  if ((d.mw ?? 0) >= 50 || (d.heightM ?? 0) >= 40) return 2;
  return d.name ? 1 : 0;
}

export function damSite(d: Dam): InfraSite {
  const rows: [string, string][] = [];
  if (d.mw != null) rows.push(["HYDRO CAPACITY", formatMw(d.mw)]);
  if (d.heightM != null) rows.push(["HEIGHT", `${d.heightM} m`]);
  if (d.river) rows.push(["RIVER", d.river]);
  if (d.year != null) rows.push(["COMPLETED", String(d.year)]);
  if (d.owner) rows.push(["OPERATOR", d.owner]);
  if (d.wikidata) rows.push(["WIKIDATA", d.wikidata]);
  return {
    key: d.id, kind: "dam", name: d.name ?? "Unnamed dam", lat: d.lat, lon: d.lon,
    color: KIND_COLOR.dam, kindLabel: KIND_LABEL.dam,
    subtitle: [d.river, d.mw != null ? formatMw(d.mw) : null].filter(Boolean).join(" · ") || null,
    rows, rank: damRank(d), sel: { kind: "dam", dam: d },
  };
}

export function dcSite(d: DataCenter): InfraSite {
  const rows: [string, string][] = [];
  if (d.operator) rows.push(["OPERATOR", d.operator]);
  const loc = [d.city, d.country].filter(Boolean).join(", ");
  if (loc) rows.push(["LOCATION", loc]);
  rows.push(["SOURCE", d.osm ? "OSM · live" : "OSM · snapshot"]);
  return {
    key: d.id, kind: "datacenter", name: d.name ?? d.operator ?? "Unnamed data centre", lat: d.lat, lon: d.lon,
    color: KIND_COLOR.datacenter, kindLabel: KIND_LABEL.datacenter,
    subtitle: d.name && d.operator && d.name !== d.operator ? d.operator : loc || null,
    rows, rank: d.name || d.operator ? 2 : 1, sel: { kind: "datacenter", dc: d },
  };
}

export function landingSite(l: LandingPoint): InfraSite {
  return {
    key: `landing:${l.id}`, kind: "landing", name: l.name, lat: l.lat, lon: l.lon,
    color: KIND_COLOR.landing, kindLabel: KIND_LABEL.landing, subtitle: "Submarine cable shore station",
    rows: [], rank: 2, sel: { kind: "landing", landing: l },
  };
}

export function siteFromSelection(sel: InfraSelection): InfraSite | null {
  if (sel.kind === "dam") return damSite(sel.dam);
  if (sel.kind === "datacenter") return dcSite(sel.dc);
  if (sel.kind === "landing") return landingSite(sel.landing);
  return null;
}

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

interface Datasets { dams: Dam[]; datacenters: DataCenter[]; landings: LandingPoint[] }

/** Every point installation within `radiusKm`, nearest first (bbox pre-filter keeps this cheap on ~50k dams). */
export function nearbySites(center: { lat: number; lon: number; key: string }, data: Datasets, radiusKm: number, limit: number): NearbySite[] {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos(rad(center.lat)), 0.05));
  const inBox = (p: { lat: number; lon: number }) => Math.abs(p.lat - center.lat) <= dLat && Math.abs(p.lon - center.lon) <= dLon;
  const out: NearbySite[] = [];
  const consider = (s: InfraSite) => {
    if (s.key === center.key) return;
    const distKm = distanceKm(center.lat, center.lon, s.lat, s.lon);
    if (distKm <= radiusKm) out.push({ ...s, distKm, bearingDeg: bearingDeg(center.lat, center.lon, s.lat, s.lon) });
  };
  for (const d of data.dams) if (inBox(d)) consider(damSite(d));
  for (const d of data.datacenters) if (inBox(d)) consider(dcSite(d));
  for (const l of data.landings) if (inBox(l)) consider(landingSite(l));
  out.sort((a, b) => a.distKm - b.distKm);
  return out.slice(0, limit);
}

/** Cable route pieces that pass within `radiusKm` of the site (for drawing on the 3D tiles). */
export function cablesNear(center: { lat: number; lon: number }, cables: CableRoute[], radiusKm: number) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos(rad(center.lat)), 0.05));
  const out: { id: string; name: string; color: string; coords: [number, number][] }[] = [];
  for (const c of cables) {
    for (const line of c.lines) {
      let run: [number, number][] = [];
      const flush = () => {
        if (run.length >= 2) out.push({ id: c.id, name: c.name, color: c.color, coords: run });
        run = [];
      };
      for (const p of line) {
        if (Math.abs(p[1] - center.lat) <= dLat && Math.abs(p[0] - center.lon) <= dLon) run.push(p);
        else {
          // keep one point outside so the line visibly leaves the frame
          if (run.length) { run.push(p); flush(); }
        }
      }
      flush();
    }
  }
  return out;
}

export function toDms(value: number, pos: string, neg: string): string {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${value >= 0 ? pos : neg}`;
}
