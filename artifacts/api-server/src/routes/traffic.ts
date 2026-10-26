import { Router, type Request, type Response } from "express";

/**
 * Live street traffic — TomTom Traffic Flow vector tiles (v4, relative flow) proxied so the
 * API key never reaches the browser. MapLibre decodes the tiles client-side; the client reads
 * the decoded road segments back out to animate vehicles. Without a key the client runs the
 * same pipeline on basemap (OpenMapTiles) roads in simulation mode.
 */
const router = Router();

const TILE_TTL_MS = 120_000;
const MAX_CACHED_TILES = 600;
const FETCH_TIMEOUT_MS = 12_000;
const MIN_Z = 10;
const MAX_Z = 18;
const HOSTS = ["a", "b", "c", "d"];
const TAGS = "[road_type,traffic_level,traffic_road_coverage,left_hand_traffic,road_closure,road_category]";

function tomtomKey(): string | null {
  const key = (process.env.TomTom_API ?? process.env.TOMTOM_API_KEY ?? process.env.TOMTOM_API ?? "").trim();
  return key.length > 0 ? key : null;
}

interface TileEntry {
  body: Buffer;
  fetchedAt: number;
}
const tileCache = new Map<string, TileEntry>();
const tileInflight = new Map<string, Promise<Buffer | null>>();
let lastUpstreamError: { status: number; at: number } | null = null;

function remember(key: string, body: Buffer) {
  tileCache.delete(key);
  tileCache.set(key, { body, fetchedAt: Date.now() });
  while (tileCache.size > MAX_CACHED_TILES) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
}

async function fetchFlowTile(z: number, x: number, y: number, key: string): Promise<Buffer | null> {
  const host = HOSTS[(x + y) % HOSTS.length];
  const url =
    `https://${host}.api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf` +
    `?key=${encodeURIComponent(key)}&tags=${encodeURIComponent(TAGS)}&margin=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      lastUpstreamError = { status: res.status, at: Date.now() };
      return null;
    }
    lastUpstreamError = null;
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

router.get("/proxy/traffic/status", (_req: Request, res: Response) => {
  const hasKey = tomtomKey() !== null;
  const upstreamFailing = !!lastUpstreamError && Date.now() - lastUpstreamError.at < 60_000;
  res.set("Cache-Control", "no-store");
  res.json({
    hasKey,
    mode: hasKey && !upstreamFailing ? "live" : "simulation",
    provider: hasKey ? "TomTom Traffic Flow v4" : null,
    ttlSec: TILE_TTL_MS / 1000,
    tileZoom: { min: MIN_Z, max: MAX_Z },
    upstreamError: upstreamFailing ? lastUpstreamError?.status ?? null : null,
  });
});

router.get("/proxy/traffic/flow/:z/:x/:y.pbf", async (req: Request, res: Response) => {
  const key = tomtomKey();
  if (!key) {
    res.status(204).end();
    return;
  }
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < MIN_Z || z > MAX_Z || x < 0 || y < 0 || x >= n || y >= n) {
    res.status(204).end();
    return;
  }

  const cacheKey = `${z}/${x}/${y}`;
  const send = (body: Buffer, ageMs: number) => {
    res.set({
      "Content-Type": "application/x-protobuf",
      "Cache-Control": `public, max-age=${Math.max(0, Math.round((TILE_TTL_MS - ageMs) / 1000))}`,
      "X-Traffic-Age": String(Math.round(ageMs / 1000)),
    });
    res.send(body);
  };

  const cached = tileCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TILE_TTL_MS) {
    send(cached.body, Date.now() - cached.fetchedAt);
    return;
  }

  let pending = tileInflight.get(cacheKey);
  if (!pending) {
    pending = fetchFlowTile(z, x, y, key)
      .catch(() => null)
      .finally(() => tileInflight.delete(cacheKey));
    tileInflight.set(cacheKey, pending);
  }
  const body = await pending;
  if (body) {
    remember(cacheKey, body);
    send(body, 0);
    return;
  }
  // Upstream failed: serve a recently expired tile rather than nothing, else an empty tile so
  // the client keeps simulating on those roads instead of showing an error.
  if (cached && Date.now() - cached.fetchedAt < TILE_TTL_MS * 5) {
    send(cached.body, Date.now() - cached.fetchedAt);
    return;
  }
  res.status(204).end();
});

export default router;
