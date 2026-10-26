import { Router, type Request, type Response } from "express";

/**
 * Space missions from The Space Devs Launch Library 2 (free tier: 15 req / hour / IP).
 *
 *   GET /api/launches        -> { fetchedAt, upcoming: Launch[], previous: Launch[] }
 *
 * Both lists are fetched with mode=detailed (booster serials + recovery info), slimmed to
 * what the replay needs, cached for 30 min (served stale while refreshing, in-flight deduped).
 */

const router = Router();
const LL2 = "https://ll.thespacedevs.com/2.3.0/launches";
const TTL_MS = 30 * 60 * 1000;
const LIMIT = 25;

export interface SlimStage {
  serial: string | null;
  type: string | null;
  reused: boolean | null;
  flight: number | null;
  landingAttempt: boolean | null;
  landingSuccess: boolean | null;
  landingType: string | null;
  landingName: string | null;
  landingDownrangeKm: number | null;
}

export interface SlimLaunch {
  id: string;
  name: string;
  net: string;
  status: string;
  statusName: string;
  provider: string | null;
  rocket: string;
  rocketLengthM: number | null;
  rocketDiameterM: number | null;
  mission: string | null;
  missionType: string | null;
  missionDescription: string | null;
  orbit: string | null;
  orbitName: string | null;
  pad: { name: string; location: string | null; lat: number; lon: number; country: string | null };
  image: string | null;
  patch: string | null;
  webcast: string | null;
  stages: SlimStage[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slim(r: any): SlimLaunch | null {
  const lat = num(r?.pad?.latitude);
  const lon = num(r?.pad?.longitude);
  if (lat === null || lon === null) return null;
  const cfg = r?.rocket?.configuration ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vids: any[] = Array.isArray(r?.vid_urls) ? r.vid_urls : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stages: any[] = Array.isArray(r?.rocket?.launcher_stage) ? r.rocket.launcher_stage : [];
  return {
    id: String(r.id),
    name: String(r.name ?? "Unknown launch"),
    net: String(r.net),
    status: String(r?.status?.abbrev ?? "TBD"),
    statusName: String(r?.status?.name ?? "To Be Determined"),
    provider: r?.launch_service_provider?.name ?? null,
    rocket: String(cfg.full_name ?? cfg.name ?? "Launch vehicle"),
    rocketLengthM: num(cfg.length),
    rocketDiameterM: num(cfg.diameter),
    mission: r?.mission?.name ?? null,
    missionType: r?.mission?.type ?? null,
    missionDescription: r?.mission?.description ?? null,
    orbit: r?.mission?.orbit?.abbrev ?? null,
    orbitName: r?.mission?.orbit?.name ?? null,
    pad: {
      name: String(r?.pad?.name ?? "Launch pad"),
      location: r?.pad?.location?.name ?? null,
      lat,
      lon,
      country: r?.pad?.country?.alpha_3_code ?? r?.pad?.country_code ?? null,
    },
    image: r?.image?.image_url ?? (typeof r?.image === "string" ? r.image : null),
    patch: Array.isArray(r?.mission_patches) && r.mission_patches[0]?.image_url ? r.mission_patches[0].image_url : null,
    webcast: vids.sort((a, b) => (a?.priority ?? 99) - (b?.priority ?? 99))[0]?.url ?? null,
    stages: stages.map((s) => ({
      serial: s?.launcher?.serial_number ?? null,
      type: s?.type ?? null,
      reused: typeof s?.reused === "boolean" ? s.reused : null,
      flight: num(s?.launcher_flight_number),
      landingAttempt: typeof s?.landing?.attempt === "boolean" ? s.landing.attempt : null,
      landingSuccess: typeof s?.landing?.success === "boolean" ? s.landing.success : null,
      landingType: s?.landing?.type?.abbrev ?? null,
      landingName: s?.landing?.landing_location?.abbrev ?? s?.landing?.landing_location?.name ?? null,
      landingDownrangeKm: num(s?.landing?.downrange_distance),
    })),
  };
}

async function fetchList(kind: "upcoming" | "previous"): Promise<SlimLaunch[]> {
  const url = `${LL2}/${kind}/?limit=${LIMIT}&mode=detailed&format=json${kind === "upcoming" ? "&hide_recent_previous=true" : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": "WorldviewOSINT/1.0 (+space-missions)" }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`LL2 ${kind} HTTP ${res.status}`);
  const json = (await res.json()) as { results?: unknown[] };
  return (json.results ?? []).map(slim).filter((x): x is SlimLaunch => !!x);
}

let cache: { fetchedAt: number; upcoming: SlimLaunch[]; previous: SlimLaunch[] } | null = null;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const [up, prev] = await Promise.allSettled([fetchList("upcoming"), fetchList("previous")]);
    const upcoming = up.status === "fulfilled" ? up.value : cache?.upcoming ?? [];
    const previous = prev.status === "fulfilled" ? prev.value : cache?.previous ?? [];
    if (up.status === "rejected") console.error("[launches] upcoming failed:", up.reason);
    if (prev.status === "rejected") console.error("[launches] previous failed:", prev.reason);
    if (up.status === "fulfilled" || prev.status === "fulfilled" || !cache) {
      cache = { fetchedAt: Date.now(), upcoming, previous };
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

router.get("/launches", async (_req: Request, res: Response) => {
  try {
    if (!cache) await refresh();
    else if (Date.now() - cache.fetchedAt > TTL_MS) void refresh();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(cache ?? { fetchedAt: Date.now(), upcoming: [], previous: [] });
  } catch (e) {
    res.status(502).json({ error: "Launch Library unavailable", detail: String(e) });
  }
});

export default router;
