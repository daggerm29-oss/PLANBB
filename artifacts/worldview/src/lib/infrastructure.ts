export type InfraLayerId = "cables" | "landings" | "datacenters" | "dams";

export const INFRA_COLORS = {
  cables: "#22d3ee",
  landings: "#a5f3fc",
  datacenters: "#f5b942",
  dams: "#3b82f6",
} as const satisfies Record<InfraLayerId, string>;

export const INFRA_LAYER_INFO: Record<InfraLayerId, { label: string; hint: string }> = {
  cables: { label: "SUBMARINE CABLES", hint: "TeleGeography · live, 24h cache" },
  landings: { label: "CABLE LANDINGS", hint: "Shore stations where cables come ashore" },
  datacenters: { label: "DATA CENTRES", hint: "OpenStreetMap · live top-up when zoomed in" },
  dams: { label: "DAMS & HYDRO", hint: "Wikidata + WRI hydro capacity · OSM top-up" },
};

export interface CableRoute {
  id: string;
  name: string;
  color: string;
  lines: [number, number][][];
}

export interface LandingPoint {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

export interface DataCenter {
  id: string;
  name: string | null;
  operator: string | null;
  city: string | null;
  country: string | null;
  lon: number;
  lat: number;
  osm: boolean;
}

export interface Dam {
  id: string;
  name: string | null;
  river: string | null;
  heightM: number | null;
  mw: number | null;
  year: number | null;
  wikidata: string | null;
  owner: string | null;
  osmRef: string | null;
  lon: number;
  lat: number;
}

export interface CableDetail {
  id: string;
  name: string;
  length: string | null;
  owners: string | null;
  suppliers: string | null;
  rfs: string | null;
  is_planned: boolean;
  url: string | null;
  landing_points: { id: string; name: string; country: string }[];
}

export interface LandingDetail {
  id: string;
  name: string;
  country: string;
  cables: { id: string; name: string; rfs_year: number | null; is_planned: boolean }[];
}

export interface InfraSummary {
  cables: { count: number; landings: number; live: boolean; updated: string };
  datacenters: { count: number; updated: string };
  dams: { count: number; updated: string };
  attribution: string[];
}

export type InfraSelection =
  | { kind: "cable"; cable: Pick<CableRoute, "id" | "name" | "color">; lon: number; lat: number }
  | { kind: "landing"; landing: LandingPoint }
  | { kind: "datacenter"; dc: DataCenter }
  | { kind: "dam"; dam: Dam };

type Row = (string | number | null)[];
const s = (v: unknown) => (typeof v === "string" ? v : null);
const n = (v: unknown) => (typeof v === "number" ? v : null);

/** Snapshot rows: [lon, lat, name, operator, osmRef, city, country] */
export function decodeDataCenters(rows: Row[], osm = false): DataCenter[] {
  return rows.map((r, i) => ({
    id: `dc:${s(r[4]) ?? `${osm ? "osm" : "s"}${i}`}`,
    lon: r[0] as number,
    lat: r[1] as number,
    name: s(r[2]),
    operator: s(r[3]),
    city: s(r[5]),
    country: s(r[6]),
    osm,
  }));
}

/** Snapshot rows: [lon, lat, name, river, heightM, mw, year, wikidataId, owner, osmRef?] */
export function decodeDams(rows: Row[]): Dam[] {
  return rows.map((r, i) => {
    const wikidata = s(r[7]);
    const osmRef = s(r[9]);
    return {
      id: `dam:${wikidata ?? osmRef ?? `${r[0]},${r[1]},${i}`}`,
      lon: r[0] as number,
      lat: r[1] as number,
      name: s(r[2]),
      river: s(r[3]),
      heightM: n(r[4]),
      mw: n(r[5]),
      year: n(r[6]),
      wikidata,
      owner: s(r[8]),
      osmRef,
    };
  });
}

export function decodeLandings(rows: [number, number, string, string][]): LandingPoint[] {
  return rows.map(([lon, lat, name, id]) => ({ id, name, lon, lat }));
}

export const formatMw = (mw: number) =>
  mw >= 1000 ? `${(mw / 1000).toFixed(mw >= 10_000 ? 1 : 2)} GW` : `${mw >= 100 ? Math.round(mw) : mw} MW`;
