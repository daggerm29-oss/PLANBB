import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Router, type Request, type Response } from "express";

/**
 * Physical infrastructure: submarine cables, landing points, data centres, dams.
 *
 * Same architecture as the rest of /api/proxy/*: the browser never talks to the
 * upstream sources. Global datasets are bundled as compact snapshots (built by
 * scripts/build-infrastructure.mjs) because the global Overpass / Wikidata
 * queries take minutes and are rate limited. On top of that:
 *   - cables are refreshed live from TeleGeography (24 h cache, snapshot fallback)
 *   - cable / landing-point details are proxied live on click
 *   - zoomed-in viewports get a live OpenStreetMap top-up (smaller sites the
 *     snapshot misses), de-duplicated against the snapshot server-side
 *
 *   GET /api/proxy/infra/summary
 *   GET /api/proxy/infra/cables
 *   GET /api/proxy/infra/cable/:id
 *   GET /api/proxy/infra/landing/:id
 *   GET /api/proxy/infra/datacenters
 *   GET /api/proxy/infra/dams
 *   GET /api/proxy/infra/osm?kind=datacenters|dams&s=&w=&n=&e=
 */

const router = Router();

const UA = "WorldviewOSINT/1.0 (+infrastructure)";
const TG = "https://www.submarinecablemap.com/api/v3";
const CABLE_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
const OSM_TTL_MS = 60 * 60 * 1000;
const OSM_MAX_SPAN_DEG = 2;
const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

type Row = (string | number | null)[];

interface CablesPayload {
  builtAt: string;
  live?: boolean;
  cables: { id: string; name: string; color: string; lines: [number, number][][] }[];
  landings: [number, number, string, string][];
}

// ── snapshot loading ──────────────────────────────────────────────────────

function snapshotDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "artifacts/api-server/data/infrastructure"),
    path.resolve(process.cwd(), "../api-server/data/infrastructure"),
    path.resolve(process.cwd(), "data/infrastructure"),
  ];
  try {
    candidates.push(fileURLToPath(new URL("../../data/infrastructure", import.meta.url)));
  } catch { /* bundled without a file URL */ }
  return candidates.find((p) => fs.existsSync(path.join(p, "dams.json"))) ?? null;
}

const snapshots = new Map<string, any>();
function snapshot<T>(file: string): T {
  if (!snapshots.has(file)) {
    const dir = snapshotDir();
    if (!dir) throw new Error("infrastructure snapshots not found — run scripts/build-infrastructure.mjs");
    snapshots.set(file, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
  }
  return snapshots.get(file) as T;
}

// ── response helpers ──────────────────────────────────────────────────────

/** Payloads are large (dams ≈ 6 MB raw) so they are pre-gzipped once and reused. */
const gzCache = new WeakMap<object, { json: Buffer; gz: Buffer }>();
function sendBig(req: Request, res: Response, payload: object, maxAgeSec: number) {
  let enc = gzCache.get(payload);
  if (!enc) {
    const json = Buffer.from(JSON.stringify(payload));
    enc = { json, gz: gzipSync(json, { level: 6 }) };
    gzCache.set(payload, enc);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${maxAgeSec}`);
  res.setHeader("Vary", "Accept-Encoding");
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.setHeader("Content-Encoding", "gzip");
    res.end(enc.gz);
  } else {
    res.end(enc.json);
  }
}

async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

const r3 = (n: number) => Math.round(n * 1e3) / 1e3;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clean = (s: unknown): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

// ── submarine cables (live with snapshot fallback) ────────────────────────

let cablesCache: { at: number; data: CablesPayload } | null = null;
let cablesRefresh: Promise<void> | null = null;

async function fetchLiveCables(): Promise<CablesPayload> {
  const [cables, landings] = await Promise.all([
    getJson<any>(`${TG}/cable/cable-geo.json`),
    getJson<any>(`${TG}/landing-point/landing-point-geo.json`),
  ]);
  if (!cables?.features?.length) throw new Error("empty cable collection");
  return {
    builtAt: new Date().toISOString(),
    live: true,
    cables: cables.features.map((f: any) => ({
      id: f.properties.id,
      name: f.properties.name,
      color: f.properties.color,
      lines: (f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates).map(
        (line: [number, number][]) => line.map(([x, y]) => [r3(x), r3(y)] as [number, number]),
      ),
    })),
    landings: landings.features.map((f: any) => [
      r4(f.geometry.coordinates[0]), r4(f.geometry.coordinates[1]), f.properties.name, f.properties.id,
    ]),
  };
}

function refreshCables() {
  cablesRefresh ??= fetchLiveCables()
    .then((data) => { cablesCache = { at: Date.now(), data }; })
    .catch(() => { /* keep serving whatever we have */ })
    .finally(() => { cablesRefresh = null; });
  return cablesRefresh;
}

async function getCables(): Promise<CablesPayload> {
  if (!cablesCache) {
    // First request: try live briefly, otherwise serve the snapshot and keep refreshing.
    await Promise.race([refreshCables(), new Promise((r) => setTimeout(r, 6_000))]);
    if (!cablesCache) cablesCache = { at: 0, data: snapshot<CablesPayload>("cables.json") };
  } else if (Date.now() - cablesCache.at > CABLE_TTL_MS) {
    void refreshCables();
  }
  return cablesCache.data;
}

// ── live detail proxies ───────────────────────────────────────────────────

const detailCache = new Map<string, { at: number; data: unknown }>();
async function cachedDetail(key: string, url: string) {
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.data;
  const data = await getJson<unknown>(url, {}, 10_000);
  detailCache.set(key, { at: Date.now(), data });
  if (detailCache.size > 500) detailCache.delete(detailCache.keys().next().value as string);
  return data;
}

// ── proximity index for de-duplicating live OSM against the snapshot ──────

const CELL = 0.02;
const grids = new Map<string, Map<string, [number, number][]>>();
function grid(kind: "datacenters" | "dams") {
  let g = grids.get(kind);
  if (!g) {
    g = new Map();
    for (const row of snapshot<{ rows: Row[] }>(`${kind}.json`).rows) {
      const lon = row[0] as number, lat = row[1] as number;
      const k = `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push([lon, lat]);
    }
    grids.set(kind, g);
  }
  return g;
}
function nearSnapshot(kind: "datacenters" | "dams", lon: number, lat: number, radiusDeg: number) {
  const g = grid(kind);
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const [x, y] of g.get(`${cy + dy}:${cx + dx}`) ?? []) {
        if (Math.abs(x - lon) < radiusDeg && Math.abs(y - lat) < radiusDeg) return true;
      }
    }
  }
  return false;
}

const osmCache = new Map<string, { at: number; rows: Row[] }>();

// ── routes ────────────────────────────────────────────────────────────────

router.get("/proxy/infra/summary", async (_req, res) => {
  try {
    const [cables, dcs, dams] = [await getCables(), snapshot<any>("datacenters.json"), snapshot<any>("dams.json")];
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json({
      cables: { count: cables.cables.length, landings: cables.landings.length, live: !!cables.live, updated: cables.builtAt },
      datacenters: { count: dcs.rows.length, updated: dcs.builtAt },
      dams: { count: dams.rows.length, updated: dams.builtAt },
      attribution: [
        "Submarine cables © TeleGeography (CC BY-NC-SA 3.0)",
        "Data centres © OpenStreetMap contributors (ODbL)",
        "Dams: Wikidata (CC0) · hydro capacity WRI Global Power Plant Database (CC BY 4.0)",
      ],
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/proxy/infra/cables", async (req, res) => {
  try {
    sendBig(req, res, await getCables(), 3600);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/proxy/infra/datacenters", (req, res) => {
  try {
    sendBig(req, res, snapshot<object>("datacenters.json"), 86_400);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/proxy/infra/dams", (req, res) => {
  try {
    sendBig(req, res, snapshot<object>("dams.json"), 86_400);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const SLUG = /^[a-z0-9-]{1,120}$/;

router.get("/proxy/infra/cable/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!SLUG.test(id)) return void res.status(400).json({ error: "bad id" });
  try {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(await cachedDetail(`cable:${id}`, `${TG}/cable/${id}.json`));
  } catch {
    res.status(502).json({ error: "cable detail unavailable" });
  }
});

router.get("/proxy/infra/landing/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!SLUG.test(id)) return void res.status(400).json({ error: "bad id" });
  try {
    const raw = (await cachedDetail(`landing:${id}`, `${TG}/landing-point/${id}.json`)) as any;
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      id: raw.id,
      name: raw.name,
      country: raw.country,
      cables: (raw.cables ?? []).map((c: any) => ({ id: c.id, name: c.name, rfs_year: c.rfs_year, is_planned: c.is_planned })),
    });
  } catch {
    res.status(502).json({ error: "landing detail unavailable" });
  }
});

router.get("/proxy/infra/osm", async (req, res) => {
  const kind = req.query.kind === "dams" ? "dams" : req.query.kind === "datacenters" ? "datacenters" : null;
  const [s, w, n, e] = ["s", "w", "n", "e"].map((k) => Number(req.query[k]));
  if (!kind || ![s, w, n, e].every(Number.isFinite) || s >= n || w >= e) {
    return void res.status(400).json({ error: "kind and s,w,n,e required" });
  }
  if (n - s > OSM_MAX_SPAN_DEG || e - w > OSM_MAX_SPAN_DEG) {
    return void res.status(413).json({ error: "zoom in", rows: [] });
  }
  // Snap to a 0.25° grid so panning reuses cached tiles.
  const q = (v: number, f: (x: number) => number) => f(v * 4) / 4;
  const bbox = [q(s, Math.floor), q(w, Math.floor), q(n, Math.ceil), q(e, Math.ceil)];
  const key = `${kind}:${bbox.join(",")}`;
  const hit = osmCache.get(key);
  if (hit && Date.now() - hit.at < OSM_TTL_MS) return void res.json({ rows: hit.rows });

  const b = bbox.join(",");
  const query = kind === "datacenters"
    ? `[out:json][timeout:25];(nwr["telecom"="data_center"](${b});nwr["building"="data_center"](${b}););out center tags 2000;`
    : `[out:json][timeout:25];nwr["waterway"="dam"](${b});out center tags 3000;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const j = await getJson<{ elements: any[] }>(
        endpoint,
        { method: "POST", body: new URLSearchParams({ data: query }), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        30_000,
      );
      const rows: Row[] = [];
      for (const el of j.elements ?? []) {
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (typeof lat !== "number" || typeof lon !== "number") continue;
        const t = el.tags ?? {};
        const ref = `${el.type[0]}${el.id}`;
        if (kind === "datacenters") {
          if (nearSnapshot("datacenters", lon, lat, 0.001)) continue;
          rows.push([r4(lon), r4(lat), clean(t.name), clean(t.operator) ?? clean(t.brand), ref, clean(t["addr:city"]), clean(t["addr:country"])]);
        } else {
          if (nearSnapshot("dams", lon, lat, 0.006)) continue;
          const name = clean(t.name) ?? clean(t["name:en"]);
          const height = Number.parseFloat(t.height);
          rows.push([r4(lon), r4(lat), name, null, Number.isFinite(height) ? Math.round(height) : null, null, null, null, clean(t.operator), ref]);
        }
      }
      osmCache.set(key, { at: Date.now(), rows });
      if (osmCache.size > 300) osmCache.delete(osmCache.keys().next().value as string);
      return void res.json({ rows });
    } catch {
      /* try next mirror */
    }
  }
  res.status(502).json({ error: "Overpass unavailable", rows: [] });
});

export default router;
