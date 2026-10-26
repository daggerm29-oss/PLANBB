import { Router, type Request, type Response } from "express";
import { inflateRawSync } from "node:zlib";
import { geminiChat } from "./ai";

/**
 * Open-web event ingestion, normalised into one geocoded feed.
 *
 *   GET  /api/events        -> { fetchedAt, sources, events: WorldEvent[] }
 *   POST /api/events/brief  -> { text, model }   (Gemini analyst briefing over the feed + client correlations)
 *
 * Sources (all free, keyless):
 *   gdelt     GDELT 2.0 event exports (15-min slices, conflict / protest / force-posture CAMEO roots)
 *   usgs      USGS M2.5+ earthquakes, past day
 *   notam     FAA temporary flight restrictions (TFR NOTAMs) with polygons, via the TFR GeoServer
 *   maritime  NGA MSI broadcast navigational warnings (NAVAREA / HYDROLANT / HYDROPAC), coordinates parsed from text
 *
 * Each source has its own cache + TTL, refreshed stale-while-revalidate with in-flight de-duplication,
 * so one slow or broken upstream never blocks the others.
 */

const router = Router();
const UA = "WorldviewOSINT/1.0 (+open-web-events)";

export type EventSource = "gdelt" | "usgs" | "notam" | "maritime";

export interface WorldEvent {
  id: string;
  source: EventSource;
  category: string;
  title: string;
  summary: string;
  lat: number;
  lon: number;
  /** ISO timestamp the event was reported / issued / last modified. */
  time: string;
  /** 1 (routine) … 5 (critical). */
  severity: number;
  url: string | null;
  /** Outer ring for area events (NOTAM airspace, maritime exclusion zones), [lon, lat]. */
  polygon: [number, number][] | null;
  meta: Record<string, string | number | boolean | null>;
}

interface SourceState {
  ok: boolean;
  count: number;
  updatedAt: number | null;
  error: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const validLatLon = (lat: number | null, lon: number | null): lat is number =>
  lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

async function get(url: string, timeoutMs = 25_000): Promise<globalThis.Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

function centroid(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

// ─── GDELT ──────────────────────────────────────────────────────────────────

const GDELT_BASE = "https://data.gdeltproject.org/gdeltv2";
const GDELT_SLOTS_WANTED = 4; // ≈ the last hour
const GDELT_SLOTS_PROBED = 10; // upstream publishes some slices late or not at all

const CAMEO_ROOTS: Record<string, { label: string; category: string; base: number }> = {
  "14": { label: "Protest", category: "protest", base: 2 },
  "15": { label: "Military posture", category: "military", base: 3 },
  "17": { label: "Coercion", category: "coercion", base: 2 },
  "18": { label: "Assault", category: "violence", base: 3 },
  "19": { label: "Armed clash", category: "conflict", base: 4 },
  "20": { label: "Mass violence", category: "conflict", base: 5 },
};

const CONFLICT_LEXICON =
  /\b(attack|strike|struck|kill|dead|death|bomb|missile|drone|clash|fight|militant|war|troop|army|shoot|shot|gun|explo|raid|airstrike|rebel|protest|riot|police|arrest|siege|shell|rocket|hostage|terror|soldier|military|insurg|massacre|violen|assault|stab|wound|injur|offensive|invasion|ceasefire|navy|naval|houthi|hamas|hezbollah|taliban|cartel|gang|coup|unrest|demonstrat|march|strike|crackdown|sanction|threat|tension|border|intercept|warship|jet)/i;

/** Extract the single file from a GDELT zip (local-header parse + raw inflate; no zip dependency). */
function unzipSingle(buf: Buffer): string {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
  const method = buf.readUInt16LE(8);
  const compressed = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const data = buf.subarray(start, compressed > 0 ? start + compressed : undefined);
  return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
}

function slotStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

function stampToIso(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : new Date().toISOString();
}

/** A readable headline from an article URL slug ("…/iran-strikes-tanker-near-hormuz-12345.html"). */
function headlineFromUrl(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean).reverse();
    for (const seg of segs) {
      const words = decodeURIComponent(seg)
        .replace(/\.(s?html?|php|aspx?|cms)$/i, "")
        .split(/[-_+]+/)
        .filter((w) => /[a-z]/i.test(w) && !/^\d+$/.test(w) && !/^[a-f0-9]{8,}$/i.test(w) && w.length < 25);
      if (words.length >= 4) {
        const s = words.slice(0, 16).join(" ");
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
    }
  } catch {
    /* malformed upstream URL */
  }
  return null;
}

function parseGdelt(csv: string): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (const line of csv.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 61) continue;
    const root = CAMEO_ROOTS[f[28]];
    if (!root) continue;
    const lat = num(f[56]);
    const lon = num(f[57]);
    if (!validLatLon(lat, lon)) continue;
    const url = f[60]?.trim() || null;
    const mentions = num(f[31]) ?? 1;
    const goldstein = num(f[30]) ?? 0;
    const place = f[52] || "Unknown location";
    const actor1 = f[6] || null;
    const actor2 = f[16] || null;
    const headline = url ? headlineFromUrl(url) : null;
    // CAMEO coding is machine-generated and noisy: a headline with no conflict/unrest vocabulary is demoted.
    const corroborated = headline ? CONFLICT_LEXICON.test(headline) : null;
    const raw = root.base + (mentions >= 10 ? 1 : 0) + (goldstein <= -9 ? 1 : 0) - (goldstein > -4 ? 1 : 0) - (corroborated === false ? 2 : 0);
    const severity = Math.min(5, raw);
    const actors = [actor1, actor2].filter(Boolean).join(" → ");
    out.push({
      id: `gdelt:${f[0]}`,
      source: "gdelt",
      category: root.category,
      title: headline || `${root.label} reported in ${place}`,
      summary: `${root.label.toUpperCase()} · ${place}${actors ? ` · ${actors}` : ""}`,
      lat: lat!,
      lon: lon!,
      time: stampToIso(f[59]),
      severity: Math.max(1, severity),
      url,
      polygon: null,
      meta: { cameo: f[26], root: root.label, place, country: f[53] || null, actor1, actor2, mentions, sources: num(f[32]), goldstein, tone: num(f[34]), corroborated },
    });
  }
  return out;
}

async function fetchGdelt(): Promise<WorldEvent[]> {
  const idx = await (await get(`${GDELT_BASE}/lastupdate.txt`, 15_000)).text();
  const m = /(\d{14})\.export\.CSV\.zip/.exec(idx);
  const latest = m ? new Date(stampToIso(m[1])) : new Date(Math.floor(Date.now() / 900_000) * 900_000);

  const stamps = Array.from({ length: GDELT_SLOTS_PROBED }, (_, i) => slotStamp(new Date(latest.getTime() - i * 900_000)));
  const results = await Promise.allSettled(
    stamps.map(async (s) => unzipSingle(Buffer.from(await (await get(`${GDELT_BASE}/${s}.export.CSV.zip`, 20_000)).arrayBuffer()))),
  );
  const files = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").slice(0, GDELT_SLOTS_WANTED);
  if (!files.length) throw new Error("no GDELT export slices available");

  // One article often spawns several coded events: keep the most severe per article.
  const byArticle = new Map<string, WorldEvent>();
  for (const f of files) {
    for (const e of parseGdelt(f.value)) {
      const key = e.url ?? e.id;
      const prev = byArticle.get(key);
      if (!prev || e.severity > prev.severity || (e.severity === prev.severity && Number(e.meta.mentions) > Number(prev.meta.mentions))) byArticle.set(key, e);
    }
  }
  return [...byArticle.values()]
    .sort((a, b) => b.severity - a.severity || Number(b.meta.mentions) - Number(a.meta.mentions))
    .slice(0, 450);
}

// ─── USGS ───────────────────────────────────────────────────────────────────

async function fetchUsgs(): Promise<WorldEvent[]> {
  const j = (await (await get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson")).json()) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    features: any[];
  };
  return (j.features ?? [])
    .map((f): WorldEvent | null => {
      const [lon, lat, depth] = f?.geometry?.coordinates ?? [];
      if (!validLatLon(num(lat), num(lon))) return null;
      const p = f.properties ?? {};
      const mag = num(p.mag) ?? 0;
      const severity = mag >= 7 ? 5 : mag >= 6 ? 4 : mag >= 5 ? 3 : mag >= 4 ? 2 : 1;
      return {
        id: `usgs:${f.id}`,
        source: "usgs",
        category: p.tsunami ? "tsunami" : "earthquake",
        title: String(p.title ?? `M${mag.toFixed(1)} earthquake`),
        summary: `M${mag.toFixed(1)} · depth ${Math.round(num(depth) ?? 0)} km${p.tsunami ? " · TSUNAMI FLAG" : ""}${p.alert ? ` · PAGER ${String(p.alert).toUpperCase()}` : ""}`,
        lat,
        lon,
        time: new Date(num(p.time) ?? Date.now()).toISOString(),
        severity: Math.min(5, severity + (p.tsunami ? 1 : 0)),
        url: p.url ?? null,
        polygon: null,
        meta: { magnitude: mag, depthKm: num(depth), felt: num(p.felt), alert: p.alert ?? null, tsunami: !!p.tsunami, place: p.place ?? null },
      };
    })
    .filter((e): e is WorldEvent => !!e);
}

// ─── FAA TFR NOTAMs ─────────────────────────────────────────────────────────

const TFR_WFS =
  "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsname=EPSG:4326";

const TFR_TYPES: Record<string, { category: string; severity: number; label: string }> = {
  "SECURITY": { category: "security", severity: 3, label: "Security TFR" },
  "VIP": { category: "vip", severity: 4, label: "VIP movement TFR" },
  "SPACE OPERATIONS": { category: "space", severity: 3, label: "Space operations TFR" },
  "HAZARDS": { category: "hazard", severity: 2, label: "Hazard TFR" },
  "UAS PUBLIC GATHERING": { category: "uas", severity: 2, label: "Drone restriction" },
  "SPECIAL": { category: "special", severity: 2, label: "Special TFR" },
  "AIR SHOWS/SPORTS": { category: "event", severity: 1, label: "Air show / stadium TFR" },
};

function parseTfrTime(s: unknown): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(s ?? ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z` : new Date().toISOString();
}

async function fetchNotams(): Promise<WorldEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await (await get(TFR_WFS)).json()) as { features: any[] };
  const byNotam = new Map<string, WorldEvent>();
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const ring: [number, number][] | undefined =
      f.geometry?.type === "Polygon" ? f.geometry.coordinates?.[0] : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates?.[0]?.[0] : undefined;
    if (!ring?.length) continue;
    const notamId = String(p.NOTAM_KEY ?? f.id).split("-")[0];
    if (byNotam.has(notamId)) continue; // multi-shape TFRs: the first shape is the outer boundary
    const [lon, lat] = centroid(ring);
    const legal = String(p.LEGAL ?? "SPECIAL").toUpperCase();
    const t = TFR_TYPES[legal] ?? { category: "special", severity: 2, label: `${legal} TFR` };
    const title = String(p.TITLE ?? "Temporary flight restriction");
    byNotam.set(notamId, {
      id: `notam:${notamId}`,
      source: "notam",
      category: t.category,
      title,
      summary: `${t.label.toUpperCase()} · NOTAM ${notamId} · ${p.CNS_LOCATION_ID ?? "FAA"}${p.STATE ? ` · ${p.STATE}` : ""}`,
      lat,
      lon,
      time: parseTfrTime(p.LAST_MODIFICATION_DATETIME),
      severity: t.severity,
      url: `https://tfr.faa.gov/tfr3/?page=detail_${notamId.replace("/", "_")}`,
      polygon: ring.map(([x, y]) => [x, y] as [number, number]),
      meta: { notam: notamId, type: legal, facility: p.CNS_LOCATION_ID ?? null, state: p.STATE ?? null },
    });
  }
  return [...byNotam.values()];
}

// ─── NGA maritime warnings ──────────────────────────────────────────────────

const NGA_URL = "https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=active";
const COORD_RE = /(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s?([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s?([EW])/g;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const MARITIME_RULES: { re: RegExp; category: string; severity: number; label: string }[] = [
  { re: /PIRACY|ARMED ROBBERY|HIJACK|ATTACK|BOARDED|SUSPICIOUS APPROACH|UNMANNED (SURFACE|AERIAL)|DRONE/, category: "security", severity: 4, label: "Maritime security" },
  { re: /MISSILE|GUNNERY|LIVE FIRING|FIRING EXERCISE|NAVAL EXERCISE|MILITARY EXERCISE|MILITARY OPERATIONS|WEAPONS|TORPEDO|MINE/, category: "military", severity: 3, label: "Military exercise / firing" },
  { re: /ROCKET LAUNCH|SPACE DEBRIS|SPACE OPERATIONS|SATELLITE|RE-?ENTRY/, category: "space", severity: 3, label: "Rocket / space debris" },
  { re: /SEARCH AND RESCUE|OVERDUE|MISSING|PERSON(S)? IN WATER|MAYDAY|DISTRESS/, category: "sar", severity: 3, label: "Search & rescue" },
  { re: /HAZARDOUS OPERATIONS|DERELICT|ADRIFT|DISABLED|AGROUND|SUNKEN|WRECK|OIL SPILL|POLLUTION/, category: "hazard", severity: 2, label: "Navigation hazard" },
  { re: /CABLE|PIPELINE|SURVEY|DREDGING|SEISMIC/, category: "operations", severity: 1, label: "Seabed / survey operations" },
];

function parseNgaDate(s: unknown): string {
  const m = /^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{4})/.exec(String(s ?? ""));
  if (!m) return new Date().toISOString();
  const mon = MONTHS.indexOf(m[4]);
  return new Date(Date.UTC(Number(m[5]), mon < 0 ? 0 : mon, Number(m[1]), Number(m[2]), Number(m[3]))).toISOString();
}

async function fetchMaritime(): Promise<WorldEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await (await get(NGA_URL, 30_000)).json()) as { "broadcast-warn": any[] };
  const out: WorldEvent[] = [];
  for (const w of j["broadcast-warn"] ?? []) {
    const text = String(w.text ?? "").toUpperCase();
    // Position lists of offshore drilling rigs etc. are inventory, not events.
    if (/DRILLING UNITS|DRILLING RIGS|IN FORCE|CANCEL (THIS MSG|NAVAREA|HYDRO)/.test(text) && !/MISSILE|FIRING|PIRACY/.test(text)) continue;
    const points: [number, number][] = [];
    for (const m of text.matchAll(COORD_RE)) {
      const lat = (Number(m[1]) + Number(m[2]) / 60) * (m[3] === "S" ? -1 : 1);
      const lon = (Number(m[4]) + Number(m[5]) / 60) * (m[6] === "W" ? -1 : 1);
      if (validLatLon(lat, lon)) points.push([lon, lat]);
    }
    if (!points.length || points.length > 40) continue;
    const rule = MARITIME_RULES.find((r) => r.re.test(text));
    if (!rule) continue;

    const isArea = points.length >= 3 && /BOUND BY|AREA BOUNDED|AREAS BOUND|WITHIN AREA|JOINING/.test(text);
    const [lon, lat] = isArea ? centroid(points) : points[0];
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const region = lines[0]?.replace(/\.$/, "") ?? "Open sea";
    const subject = lines.find((l) => rule.re.test(l))?.replace(/\.$/, "") ?? rule.label.toUpperCase();
    const ref = `${w.navArea ?? ""} ${w.msgNumber}/${String(w.msgYear).slice(-2)}`.trim();
    out.push({
      id: `maritime:${w.navArea}-${w.msgYear}-${w.msgNumber}`,
      source: "maritime",
      category: rule.category,
      title: `${region} · ${subject}`.slice(0, 140),
      summary: `${rule.label.toUpperCase()} · NAVAREA ${ref}${w.authority ? ` · ${String(w.authority).split(" ")[0]}` : ""}`,
      lat,
      lon,
      time: parseNgaDate(w.issueDate),
      severity: rule.severity,
      url: "https://msi.nga.mil/NavWarnings",
      polygon: isArea ? [...points, points[0]] : null,
      meta: { navArea: w.navArea ?? null, message: ref, authority: w.authority ?? null, text: String(w.text ?? "").slice(0, 900), points: points.length },
    });
  }
  return out;
}

// ─── cache orchestration ────────────────────────────────────────────────────

interface Feed {
  ttl: number;
  load: () => Promise<WorldEvent[]>;
  events: WorldEvent[];
  state: SourceState;
  inflight: Promise<void> | null;
}

const feeds: Record<EventSource, Feed> = {
  gdelt: { ttl: 15 * 60_000, load: fetchGdelt, events: [], state: { ok: false, count: 0, updatedAt: null, error: null }, inflight: null },
  usgs: { ttl: 5 * 60_000, load: fetchUsgs, events: [], state: { ok: false, count: 0, updatedAt: null, error: null }, inflight: null },
  notam: { ttl: 15 * 60_000, load: fetchNotams, events: [], state: { ok: false, count: 0, updatedAt: null, error: null }, inflight: null },
  maritime: { ttl: 60 * 60_000, load: fetchMaritime, events: [], state: { ok: false, count: 0, updatedAt: null, error: null }, inflight: null },
};

function refreshFeed(name: EventSource): Promise<void> {
  const feed = feeds[name];
  if (feed.inflight) return feed.inflight;
  feed.inflight = feed
    .load()
    .then((events) => {
      feed.events = events;
      feed.state = { ok: true, count: events.length, updatedAt: Date.now(), error: null };
    })
    .catch((e: unknown) => {
      console.error(`[events] ${name} failed:`, e);
      // Keep serving the last good batch; surface the error.
      feed.state = { ...feed.state, ok: feed.events.length > 0, error: String((e as Error)?.message ?? e) };
      if (!feed.state.updatedAt) feed.state.updatedAt = Date.now();
    })
    .finally(() => {
      feed.inflight = null;
    });
  return feed.inflight;
}

async function snapshot(): Promise<{ fetchedAt: number; sources: Record<EventSource, SourceState>; events: WorldEvent[] }> {
  const names = Object.keys(feeds) as EventSource[];
  const cold = names.filter((n) => !feeds[n].state.updatedAt);
  for (const n of names) {
    const st = feeds[n].state;
    if (st.updatedAt && Date.now() - st.updatedAt > feeds[n].ttl) void refreshFeed(n);
  }
  if (cold.length) await Promise.all(cold.map(refreshFeed));
  const sources = Object.fromEntries(names.map((n) => [n, feeds[n].state])) as Record<EventSource, SourceState>;
  return { fetchedAt: Date.now(), sources, events: names.flatMap((n) => feeds[n].events) };
}

router.get("/events", async (_req: Request, res: Response) => {
  try {
    const snap = await snapshot();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(snap);
  } catch (e) {
    res.status(502).json({ error: "Event feeds unavailable", detail: String(e) });
  }
});

// ─── AI briefing ────────────────────────────────────────────────────────────

interface BriefCorrelation {
  eventId: string;
  kind: "aircraft_in_tfr" | "ships_in_warning";
  count: number;
  sample: string[];
}

interface BriefBody {
  hours?: number;
  correlations?: BriefCorrelation[];
  darkShips?: { count: number; tankers: number; clusters: { lat: number; lon: number; count: number }[] };
  region?: string;
}

const BRIEF_SYSTEM = `You are an intelligence analyst writing a live situation brief for an OSINT watch officer.
You receive a JSON digest of open-source events (GDELT news-coded events, USGS earthquakes, FAA TFR NOTAMs, NGA maritime warnings)
plus live sensor correlations (aircraft inside restricted airspace, ships inside maritime warning zones, AIS-dark vessels).

Write the brief as 4-7 short lines of plain text, no markdown symbols, no bullets characters other than a leading "- ".
Start with the single most significant development. Group by theme (conflict and unrest, airspace, maritime, natural hazards).
Name places concretely (resolve coordinates to the nearest well-known region or sea using your own geography knowledge).
Quote counts exactly from the data. Correlations are the most valuable signal: call out aircraft operating inside restricted airspace and ships inside warning zones.
Never invent events, actors or numbers that are not in the digest. GDELT items are machine-coded from news and can be noisy: say "reported" not "confirmed".
End with one line starting "Watch:" naming the one thing most worth monitoring next.`;

router.post("/events/brief", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as BriefBody;
  const hours = Math.max(1, Math.min(48, Number(body.hours) || 1));
  try {
    const snap = await snapshot();
    const cutoff = Date.now() - hours * 3600_000;
    const recent = (src: EventSource, minSeverity: number, limit: number, ignoreWindow = false) =>
      snap.events
        .filter((e) => e.source === src && e.severity >= minSeverity && (ignoreWindow || Date.parse(e.time) >= cutoff))
        .sort((a, b) => b.severity - a.severity || Date.parse(b.time) - Date.parse(a.time))
        .slice(0, limit)
        .map((e) => ({ id: e.id, cat: e.category, sev: e.severity, title: e.title, where: e.meta.place ?? undefined, lat: Math.round(e.lat * 10) / 10, lon: Math.round(e.lon * 10) / 10, time: e.time.slice(0, 16) }));

    const byId = new Map(snap.events.map((e) => [e.id, e]));
    const digest = {
      window_hours: hours,
      now_utc: new Date().toISOString().slice(0, 16),
      region_focus: body.region ?? "worldwide",
      totals: Object.fromEntries((Object.keys(feeds) as EventSource[]).map((s) => [s, snap.sources[s].count])),
      news_events: recent("gdelt", 3, 25),
      earthquakes: recent("usgs", 2, 8),
      // TFRs and NAV warnings are standing restrictions: include active ones regardless of issue time.
      airspace_notams: recent("notam", 3, 10, true),
      maritime_warnings: recent("maritime", 3, 10, true),
      correlations: (body.correlations ?? []).slice(0, 15).map((c) => ({ ...c, event: byId.get(c.eventId)?.title ?? c.eventId })),
      dark_ships: body.darkShips ?? null,
    };

    const out = await geminiChat({
      provider: "gemini",
      system: BRIEF_SYSTEM,
      messages: [{ role: "user", text: `Digest:\n${JSON.stringify(digest)}` }],
      tools: [],
    });
    res.json({ text: out.text.trim(), model: out.model, generatedAt: Date.now(), digest: { window_hours: hours, totals: digest.totals } });
  } catch (e) {
    const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 502;
    res.status(status).json({ error: String((e as Error)?.message ?? e) });
  }
});

// ── Article thumbnails ───────────────────────────────────────────────────────
// GET /api/events/thumb?u=<article url> → the article's og:image bytes (proxied so hotlink/CORS rules don't bite).
// 404 when the page has no usable image; the client then falls back to a category photo.

const THUMB_MAX_BYTES = 4 * 1024 * 1024;
const THUMB_TTL_MS = 6 * 60 * 60 * 1000;
const thumbCache = new Map<string, { at: number; type: string; body: Buffer } | { at: number; miss: true }>();
let thumbActive = 0;
const thumbQueue: (() => void)[] = [];

async function withThumbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (thumbActive >= 6) await new Promise<void>((r) => thumbQueue.push(r));
  thumbActive++;
  try {
    return await fn();
  } finally {
    thumbActive--;
    thumbQueue.shift()?.();
  }
}

/** Public http(s) only: blocks loopback, link-local and RFC1918 literals to keep this from being an SSRF hop. */
function safePublicUrl(raw: string, base?: string): URL | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (
      h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h.startsWith("[") ||
      /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) return null;
    return u;
  } catch {
    return null;
  }
}

async function readCapped(res: globalThis.Response, cap: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return chunks.length ? Buffer.concat(chunks) : null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

function findOgImage(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const want = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];
  const found = new Map<string, string>();
  for (const tag of metas) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && content && want.includes(key) && !found.has(key)) found.set(key, content.replace(/&amp;/g, "&").trim());
  }
  for (const k of want) if (found.get(k)) return found.get(k)!;
  const link = /<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  return link ?? null;
}

async function resolveThumb(articleUrl: URL): Promise<{ type: string; body: Buffer } | null> {
  const page = await fetch(articleUrl, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) return null;
  const html = (await readCapped(page, 600_000))?.toString("utf8");
  if (!html) return null;
  const raw = findOgImage(html);
  const imgUrl = raw ? safePublicUrl(raw, page.url || articleUrl.href) : null;
  if (!imgUrl) return null;
  const img = await fetch(imgUrl, { headers: { "User-Agent": BROWSER_UA, Referer: articleUrl.origin, Accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
  const type = img.headers.get("content-type") ?? "";
  if (!img.ok || !type.startsWith("image/") || type.includes("svg")) return null;
  const body = await readCapped(img, THUMB_MAX_BYTES);
  return body && body.length > 800 ? { type, body } : null;
}

router.get("/events/thumb", async (req: Request, res: Response) => {
  const u = typeof req.query.u === "string" ? safePublicUrl(req.query.u) : null;
  if (!u) {
    res.status(400).json({ error: "bad url" });
    return;
  }
  const key = u.href;
  const hit = thumbCache.get(key);
  let entry = hit && Date.now() - hit.at < THUMB_TTL_MS ? hit : null;
  if (!entry) {
    const got = await withThumbSlot(() => resolveThumb(u)).catch(() => null);
    entry = got ? { at: Date.now(), ...got } : { at: Date.now(), miss: true };
    if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value!);
    thumbCache.set(key, entry);
  }
  if ("miss" in entry) {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", entry.type);
  res.setHeader("Cache-Control", "public, max-age=21600, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(entry.body);
});

export default router;
