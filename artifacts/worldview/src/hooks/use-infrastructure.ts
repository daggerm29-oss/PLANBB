import { useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { apiBase } from "../lib/cctv";
import {
  decodeDams, decodeDataCenters, decodeLandings,
  type CableRoute, type Dam, type DataCenter, type InfraLayerId, type InfraSummary, type LandingPoint,
} from "../lib/infrastructure";

const OSM_MIN_ZOOM = 9;
const OSM_DEBOUNCE_MS = 800;

type Status = "idle" | "loading" | "ready" | "error";
export type InfraOsmStatus = "off" | "zoom-in" | "loading" | "ready" | "error";

interface Options {
  active: boolean;
  enabled: Record<InfraLayerId, boolean>;
  map: maplibregl.Map | null;
  mapLoaded: boolean;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, { signal });
  if (!r.ok) throw Object.assign(new Error(`${path} -> HTTP ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

/**
 * Loads the bundled + live infrastructure datasets from /api/proxy/infra/*.
 * Each dataset is fetched the first time its layer is switched on, and data
 * centres / dams get a live OpenStreetMap top-up for the viewport once zoomed in.
 */
export function useInfrastructure({ active, enabled, map, mapLoaded }: Options) {
  const [summary, setSummary] = useState<InfraSummary | null>(null);
  const [cables, setCables] = useState<CableRoute[]>([]);
  const [landings, setLandings] = useState<LandingPoint[]>([]);
  const [datacenters, setDatacenters] = useState<DataCenter[]>([]);
  const [dams, setDams] = useState<Dam[]>([]);
  const [status, setStatus] = useState<Record<"cables" | "datacenters" | "dams", Status>>({
    cables: "idle", datacenters: "idle", dams: "idle",
  });
  const [osmStatus, setOsmStatus] = useState<InfraOsmStatus>("off");
  const requested = useRef(new Set<string>());
  const osmExtra = useRef({ dc: new Map<string, DataCenter>(), dams: new Map<string, Dam>() });
  const base = useRef({ dc: [] as DataCenter[], dams: [] as Dam[] });

  const wantCables = active && (enabled.cables || enabled.landings);
  const wantDc = active && enabled.datacenters;
  const wantDams = active && enabled.dams;

  useEffect(() => {
    if (!active || requested.current.has("summary")) return;
    requested.current.add("summary");
    getJson<InfraSummary>("/api/proxy/infra/summary").then(setSummary).catch(() => requested.current.delete("summary"));
  }, [active]);

  useEffect(() => {
    const jobs: [boolean, "cables" | "datacenters" | "dams", () => Promise<void>][] = [
      [wantCables, "cables", async () => {
        const j = await getJson<{ cables: CableRoute[]; landings: [number, number, string, string][] }>("/api/proxy/infra/cables");
        setCables(j.cables);
        setLandings(decodeLandings(j.landings));
      }],
      [wantDc, "datacenters", async () => {
        const j = await getJson<{ rows: (string | number | null)[][] }>("/api/proxy/infra/datacenters");
        base.current.dc = decodeDataCenters(j.rows);
        setDatacenters([...base.current.dc, ...osmExtra.current.dc.values()]);
      }],
      [wantDams, "dams", async () => {
        const j = await getJson<{ rows: (string | number | null)[][] }>("/api/proxy/infra/dams");
        base.current.dams = decodeDams(j.rows);
        setDams([...base.current.dams, ...osmExtra.current.dams.values()]);
      }],
    ];
    for (const [want, key, run] of jobs) {
      if (!want || requested.current.has(key)) continue;
      requested.current.add(key);
      setStatus((p) => ({ ...p, [key]: "loading" }));
      run()
        .then(() => setStatus((p) => ({ ...p, [key]: "ready" })))
        .catch(() => {
          requested.current.delete(key);
          setStatus((p) => ({ ...p, [key]: "error" }));
        });
    }
  }, [wantCables, wantDc, wantDams]);

  useEffect(() => {
    if (!map || !mapLoaded || (!wantDc && !wantDams)) {
      setOsmStatus("off");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const scan = async () => {
      if (map.getZoom() < OSM_MIN_ZOOM) {
        setOsmStatus("zoom-in");
        return;
      }
      const b = map.getBounds();
      const qs = (kind: string) =>
        new URLSearchParams({ kind, s: String(b.getSouth()), w: String(b.getWest()), n: String(b.getNorth()), e: String(b.getEast()) });
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      setOsmStatus("loading");
      try {
        const [dc, dm] = await Promise.all([
          wantDc ? getJson<{ rows: (string | number | null)[][] }>(`/api/proxy/infra/osm?${qs("datacenters")}`, signal) : null,
          wantDams ? getJson<{ rows: (string | number | null)[][] }>(`/api/proxy/infra/osm?${qs("dams")}`, signal) : null,
        ]);
        if (dc) {
          for (const d of decodeDataCenters(dc.rows, true)) osmExtra.current.dc.set(d.id, d);
          setDatacenters([...base.current.dc, ...osmExtra.current.dc.values()]);
        }
        if (dm) {
          for (const d of decodeDams(dm.rows)) osmExtra.current.dams.set(d.id, d);
          setDams([...base.current.dams, ...osmExtra.current.dams.values()]);
        }
        setOsmStatus("ready");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setOsmStatus((err as { status?: number }).status === 413 ? "zoom-in" : "error");
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(scan, OSM_DEBOUNCE_MS);
    };
    schedule();
    map.on("moveend", schedule);
    return () => {
      clearTimeout(timer);
      controller?.abort();
      map.off("moveend", schedule);
    };
  }, [map, mapLoaded, wantDc, wantDams]);

  return { summary, cables, landings, datacenters, dams, status, osmStatus };
}
