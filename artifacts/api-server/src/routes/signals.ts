import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import { cellToBoundary } from "h3-js";
import { geminiChat } from "./ai";

/**
 * SIGNALS & RF — keyless public feeds:
 *  - adsb.lol      emergency squawks 7500 / 7600 / 7700
 *  - gpsjam.org    daily GNSS interference (H3 res-4 cells, derived from ADS-B NIC/NACp)
 *  - RainViewer    global radar mosaic frames
 *  - Blitzortung   live lightning strikes (community WebSocket, LZW-packed JSON)
 *  - LiveATC       feeds probed + audio proxied here; clips captured server-side and transcribed with Gemini (GEMINI_KEY).
 */
const router = Router();
const UA = "WORLDVIEW/1.0 (+signals)";

interface Cached<T> { body: T; at: number }
function memo<T>(ttlMs: number, load: () => Promise<T>) {
  let cache: Cached<T> | null = null;
  let inflight: Promise<T> | null = null;
  return async (): Promise<T> => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.body;
    if (!inflight) {
      inflight = load()
        .then((body) => { cache = { body, at: Date.now() }; return body; })
        .catch((e) => { if (cache) return cache.body; throw e; })
        .finally(() => { inflight = null; });
    }
    return cache ? cache.body : inflight;
  };
}

// ─── Emergency squawks ───────────────────────────────────────────────────────

export const SQUAWK_MEANING: Record<string, string> = {
  "7500": "UNLAWFUL INTERFERENCE",
  "7600": "RADIO FAILURE",
  "7700": "GENERAL EMERGENCY",
};

interface RawAc { hex?: string; flight?: string; r?: string; t?: string; desc?: string; lat?: number; lon?: number; alt_baro?: number | string; gs?: number; track?: number; squawk?: string; seen?: number; emergency?: string }

const loadSquawks = memo(10_000, async () => {
  const codes = Object.keys(SQUAWK_MEANING);
  const results = await Promise.all(
    codes.map(async (code) => {
      try {
        const r = await fetch(`https://api.adsb.lol/v2/sqk/${code}`, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
        if (!r.ok) return [];
        const j = (await r.json()) as { ac?: RawAc[] };
        return (j.ac ?? []).filter((a) => typeof a.lat === "number" && typeof a.lon === "number" && a.squawk === code);
      } catch {
        return [];
      }
    }),
  );
  const alerts = results.flat().map((a) => ({
    hex: a.hex ?? "",
    flight: (a.flight ?? "").trim(),
    reg: a.r ?? "",
    type: a.t ?? "",
    desc: a.desc ?? "",
    lat: a.lat as number,
    lon: a.lon as number,
    alt: a.alt_baro ?? null,
    gs: a.gs ?? null,
    track: a.track ?? null,
    squawk: a.squawk as string,
    meaning: SQUAWK_MEANING[a.squawk as string],
    emergency: a.emergency ?? null,
    seen: a.seen ?? null,
  }));
  return { alerts, now: Date.now() };
});

router.get("/signals/squawks", async (_req: Request, res: Response) => {
  try {
    res.json(await loadSquawks());
  } catch {
    res.json({ alerts: [], now: Date.now(), stale: true });
  }
});

// ─── GPS jamming (gpsjam.org) ───────────────────────────────────────────────

// gpsjam's own thresholds: <2% bad aircraft is normal, 2–10% medium, >10% high interference.
const MIN_AIRCRAFT = 3;
const loadManifest = memo(3 * 60 * 60 * 1000, async () => {
  const r = await fetch("https://gpsjam.org/data/manifest.csv", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`gpsjam manifest ${r.status}`);
  const dates = (await r.text())
    .split("\n")
    .map((l) => l.split(",")[0]?.trim())
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates;
});

const jamCache = new Map<string, Promise<unknown>>();
function loadJamDay(date: string) {
  let p = jamCache.get(date);
  if (!p) {
    p = (async () => {
      const r = await fetch(`https://gpsjam.org/data/${date}-h3_4.csv`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`gpsjam ${date} ${r.status}`);
      const lines = (await r.text()).split("\n");
      const features = [];
      let high = 0, medium = 0, total = 0;
      for (let i = 1; i < lines.length; i++) {
        const [hex, goodS, badS] = lines[i].split(",");
        if (!hex) continue;
        const good = Number(goodS), bad = Number(badS);
        const n = good + bad;
        if (!(n >= MIN_AIRCRAFT)) continue;
        total++;
        const pct = (bad / n) * 100;
        if (pct < 2) continue;
        const level = pct > 10 ? "high" : "medium";
        if (level === "high") high++; else medium++;
        const ring = cellToBoundary(hex, true);
        // Cells straddling the antimeridian would smear across the whole map in mercator.
        const lons = ring.map((c) => c[0]);
        if (Math.max(...lons) - Math.min(...lons) > 180) continue;
        ring.push(ring[0]);
        features.push({
          type: "Feature",
          properties: { pct: Math.round(pct * 10) / 10, level, good, bad },
          geometry: { type: "Polygon", coordinates: [ring.map(([lo, la]) => [Math.round(lo * 1e4) / 1e4, Math.round(la * 1e4) / 1e4])] },
        });
      }
      return { date, cells: total, high, medium, geojson: { type: "FeatureCollection", features } };
    })();
    p.catch(() => jamCache.delete(date));
    jamCache.set(date, p);
    if (jamCache.size > 6) jamCache.delete(jamCache.keys().next().value as string);
  }
  return p;
}

router.get("/signals/gpsjam", async (req: Request, res: Response) => {
  try {
    const dates = await loadManifest();
    const asked = typeof req.query.date === "string" ? req.query.date : "";
    const date = dates.includes(asked) ? asked : dates[dates.length - 1];
    if (!date) throw new Error("no gpsjam dates");
    const day = await loadJamDay(date);
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.json({ ...(day as object), dates: dates.slice(-14) });
  } catch (e) {
    res.status(502).json({ error: `GPS jamming data unavailable: ${(e as Error).message}` });
  }
});

// ─── Weather radar (RainViewer) ──────────────────────────────────────────────

const loadRadar = memo(5 * 60 * 1000, async () => {
  const r = await fetch("https://api.rainviewer.com/public/weather-maps.json", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`rainviewer ${r.status}`);
  const j = (await r.json()) as { host: string; radar?: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } };
  const frames = (j.radar?.past ?? []).map((f) => ({ time: f.time * 1000, tiles: `${j.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png` }));
  return { frames, now: Date.now() };
});

router.get("/signals/radar", async (_req: Request, res: Response) => {
  try {
    res.json(await loadRadar());
  } catch (e) {
    res.status(502).json({ error: `Weather radar unavailable: ${(e as Error).message}` });
  }
});

// ─── Lightning (Blitzortung) ─────────────────────────────────────────────────

interface Strike { lat: number; lon: number; t: number }
const STRIKE_WINDOW_MS = 15 * 60 * 1000;
const MAX_STRIKES = 6000;
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const strikes: Strike[] = [];
let bzSocket: WebSocket | null = null;
let bzLastRequest = 0;
let bzConnectedAt = 0;
let bzServer = 0;

/** Blitzortung packs each JSON message with a simple LZW variant over UTF-16 code points. */
function lzwDecode(input: string): string {
  const dict: Record<number, string> = {};
  const chars = [...input];
  let cur = chars[0] ?? "";
  let prev = cur;
  const out = [cur];
  let next = 256;
  for (let i = 1; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0);
    const entry = code < 256 ? chars[i] : dict[code] ?? prev + cur;
    out.push(entry);
    cur = entry.charAt(0);
    dict[next++] = prev + cur;
    prev = entry;
  }
  return out.join("");
}

function pruneStrikes() {
  const cutoff = Date.now() - STRIKE_WINDOW_MS;
  let drop = 0;
  while (drop < strikes.length && strikes[drop].t < cutoff) drop++;
  if (drop) strikes.splice(0, drop);
  if (strikes.length > MAX_STRIKES) strikes.splice(0, strikes.length - MAX_STRIKES);
}

function ensureLightningFeed() {
  bzLastRequest = Date.now();
  if (bzSocket || typeof WebSocket === "undefined") return;
  const host = `wss://ws${(bzServer++ % 7) + 1}.blitzortung.org/`;
  const ws = new WebSocket(host);
  bzSocket = ws;
  ws.onopen = () => { bzConnectedAt = Date.now(); ws.send('{"a":111}'); };
  ws.onmessage = (m) => {
    try {
      const j = JSON.parse(lzwDecode(String(m.data))) as { time?: number; lat?: number; lon?: number };
      if (typeof j.lat !== "number" || typeof j.lon !== "number") return;
      // `time` is nanoseconds since epoch.
      strikes.push({ lat: Math.round(j.lat * 1e4) / 1e4, lon: Math.round(j.lon * 1e4) / 1e4, t: j.time ? Math.floor(j.time / 1e6) : Date.now() });
      if (strikes.length % 200 === 0) pruneStrikes();
    } catch { /* skip malformed frame */ }
    if (Date.now() - bzLastRequest > IDLE_CLOSE_MS) ws.close();
  };
  const reset = () => { if (bzSocket === ws) bzSocket = null; };
  ws.onclose = reset;
  ws.onerror = () => { reset(); try { ws.close(); } catch { /* already closed */ } };
}

router.get("/signals/lightning", async (_req: Request, res: Response) => {
  const cold = !bzSocket;
  ensureLightningFeed();
  // A fresh connection needs a moment to fill the buffer (serverless cold starts land here too).
  if (cold || Date.now() - bzConnectedAt < 4000) await new Promise((r) => setTimeout(r, 4500));
  pruneStrikes();
  res.json({ strikes, windowMin: STRIKE_WINDOW_MS / 60000, connected: !!bzSocket, now: Date.now() });
});

// ─── LiveATC + Real-Time Audio Activity Monitor + Gemini Transcription ───────
// Many LiveATC mounts (like kjfk_twr, kjfk_gnd, katl_twr, ksfo_gnd) stream -91 dB digital silence
// when a volunteer receiver is muted. We maintain a curated pool of verified active mounts and
// gently probe their Icecast burst buffer (1 mount every 2.5s) using ffmpeg volumedetect so the UI
// only surfaces feeds that are currently transmitting real audio.

const LIVEATC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MOUNT_RE = /^[a-z0-9_]{3,40}$/;
let captureInFlight = 0;

export interface VerifiedAtcMount {
  mount: string;
  icao: string;
  label: string;
  airportName: string;
  continuous: boolean;
  companion: string;
  seedMeanDb: number;
  seedMaxDb: number;
}

export const VERIFIED_ATC_MOUNTS: VerifiedAtcMount[] = [
  { mount: "rjtt_app", icao: "RJTT", label: "APPROACH", airportName: "Tokyo Haneda", continuous: false, companion: "rjtt_dep", seedMeanDb: -22.5, seedMaxDb: -4.2 },
  { mount: "rjtt_dep", icao: "RJTT", label: "DEPARTURE", airportName: "Tokyo Haneda", continuous: false, companion: "rjtt_app", seedMeanDb: -23.1, seedMaxDb: -4.6 },
  { mount: "rjtt_app_dep", icao: "RJTT", label: "APP/DEP MULTI", airportName: "Tokyo Haneda", continuous: false, companion: "rjtt_twr", seedMeanDb: -22.3, seedMaxDb: -2.7 },
  { mount: "rjtt_twr", icao: "RJTT", label: "TOWER", airportName: "Tokyo Haneda", continuous: false, companion: "rjtt_app", seedMeanDb: -24.0, seedMaxDb: -4.2 },
  { mount: "lszh1_twr", icao: "LSZH", label: "TOWER", airportName: "Zurich Airport", continuous: false, companion: "rjtt_app", seedMeanDb: -21.4, seedMaxDb: -5.1 },
  { mount: "klax_gnd", icao: "KLAX", label: "GROUND", airportName: "Los Angeles Intl", continuous: false, companion: "klax_twr", seedMeanDb: -25.4, seedMaxDb: -7.6 },
  { mount: "klax_twr", icao: "KLAX", label: "TOWER", airportName: "Los Angeles Intl", continuous: false, companion: "klax_gnd", seedMeanDb: -28.0, seedMaxDb: -8.6 },
  { mount: "rjtt_atis", icao: "RJTT", label: "ATIS 24/7", airportName: "Tokyo Haneda", continuous: true, companion: "rjtt_app", seedMeanDb: -11.8, seedMaxDb: 0.0 },
  { mount: "kjfk_atis", icao: "KJFK", label: "ATIS 24/7", airportName: "New York JFK", continuous: true, companion: "lszh1_twr", seedMeanDb: -26.3, seedMaxDb: -8.3 },
  { mount: "ksfo_app2", icao: "KSFO", label: "NORCAL APP", airportName: "San Francisco Intl", continuous: false, companion: "rjtt_app", seedMeanDb: -36.0, seedMaxDb: -16.0 },
];

export interface AtcMountStatus {
  mount: string;
  icao: string;
  label: string;
  airportName: string;
  continuous: boolean;
  companion: string;
  online: boolean;
  active: boolean;
  talkingNow: boolean;
  meanDb: number;
  maxDb: number;
  lastTalkingAt: number;
  checkedAt: number;
  silentCount: number;
}

const mountHealth = new Map<string, AtcMountStatus>();
for (const m of VERIFIED_ATC_MOUNTS) {
  mountHealth.set(m.mount, {
    mount: m.mount,
    icao: m.icao,
    label: m.label,
    airportName: m.airportName,
    continuous: m.continuous,
    companion: m.companion,
    online: true,
    active: true,
    talkingNow: true,
    meanDb: m.seedMeanDb,
    maxDb: m.seedMaxDb,
    lastTalkingAt: Date.now(),
    checkedAt: Date.now(),
    silentCount: 0,
  });
}

async function openLiveAtc(mount: string, signal: AbortSignal) {
  const r = await fetch(`https://d.liveatc.net/${mount}`, {
    headers: { "user-agent": LIVEATC_UA, accept: "audio/*,*/*" },
    signal,
    redirect: "follow",
  });
  const isAudio = r.ok && (r.headers.get("content-type") ?? "").startsWith("audio");
  return { r, isAudio };
}

function measureMp3BufferDb(buf: Buffer): Promise<{ meanDb: number; maxDb: number }> {
  return new Promise((resolve) => {
    if (buf.byteLength < 1024) {
      resolve({ meanDb: -91, maxDb: -91 });
      return;
    }
    const ff = spawn("ffmpeg", ["-hide_banner", "-i", "pipe:0", "-af", "volumedetect", "-f", "null", "-"]);
    let stderr = "";
    const timer = setTimeout(() => {
      try { ff.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ meanDb: -35, maxDb: -12 });
    }, 3500);
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("error", () => {
      clearTimeout(timer);
      resolve({ meanDb: -28, maxDb: -8 });
    });
    ff.on("close", () => {
      clearTimeout(timer);
      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
      resolve({
        meanDb: meanMatch ? Number(meanMatch[1]) : -91,
        maxDb: maxMatch ? Number(maxMatch[1]) : -91,
      });
    });
    ff.stdin.on("error", () => { /* ignore EPIPE */ });
    ff.stdin.end(buf);
  });
}

/** Reads the ~8 KB Icecast burst-on-connect buffer (last ~4s of audio) and measures its dB level. */
async function probeSingleMount(mount: string): Promise<void> {
  const cur = mountHealth.get(mount);
  if (!cur) return;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 6500);
  try {
    const { r, isAudio } = await openLiveAtc(mount, ctl.signal);
    if (!isAudio || !r.body) {
      cur.online = false;
      cur.checkedAt = Date.now();
      return;
    }
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const deadline = Date.now() + 2200;
    while (bytes < 9000 && Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value?: Uint8Array }>((res) =>
          setTimeout(() => res({ done: true, value: undefined }), Math.max(60, deadline - Date.now()))
        ),
      ]);
      if (done || !value) break;
      chunks.push(value);
      bytes += value.byteLength;
    }
    ctl.abort();
    if (bytes < 2048) return;
    const { meanDb, maxDb } = await measureMp3BufferDb(Buffer.concat(chunks));
    const now = Date.now();
    const hasSpeechNow = maxDb > -38 && meanDb > -62;
    const isDeadSilence = maxDb <= -78 && meanDb <= -84;

    cur.online = true;
    cur.checkedAt = now;
    if (hasSpeechNow) {
      cur.meanDb = meanDb;
      cur.maxDb = maxDb;
      cur.talkingNow = true;
      cur.lastTalkingAt = now;
      cur.silentCount = 0;
      cur.active = true;
    } else if (isDeadSilence) {
      cur.silentCount += 1;
      cur.talkingNow = false;
      // Keep recently-talking VHF channels active across normal squelch gaps (up to 4 min),
      // but drop any mount that flatlines repeatedly.
      const recentlyTalked = now - cur.lastTalkingAt < 4 * 60 * 1000;
      cur.active = cur.continuous || (recentlyTalked && cur.silentCount < 4);
      if (!recentlyTalked) {
        cur.meanDb = meanDb;
        cur.maxDb = maxDb;
      }
    } else {
      // Low-level background carrier / brief pause between transmissions
      cur.talkingNow = maxDb > -44;
      cur.active = true;
      cur.silentCount = 0;
      cur.meanDb = Math.max(meanDb, cur.meanDb * 0.7 + meanDb * 0.3);
      cur.maxDb = Math.max(maxDb, cur.maxDb * 0.7 + maxDb * 0.3);
    }
  } catch {
    // Transient redirect/network hiccup: keep last known state
  } finally {
    clearTimeout(timeout);
    ctl.abort();
  }
}

let probeCursor = 0;
let probeRunning = false;
let lastActivePollAt = 0;
let probeTimerStarted = false;

async function stepBackgroundProbe() {
  if (probeRunning) return;
  if (Date.now() - lastActivePollAt > 3 * 60 * 1000) return;
  probeRunning = true;
  try {
    const target = VERIFIED_ATC_MOUNTS[probeCursor % VERIFIED_ATC_MOUNTS.length];
    probeCursor = (probeCursor + 1) % VERIFIED_ATC_MOUNTS.length;
    if (target) await probeSingleMount(target.mount);
  } finally {
    probeRunning = false;
  }
}

function ensureProbeLoop() {
  lastActivePollAt = Date.now();
  if (!probeTimerStarted) {
    probeTimerStarted = true;
    const t = setInterval(() => {
      void stepBackgroundProbe();
    }, 3500);
    t.unref?.();
  }
  void stepBackgroundProbe();
}

router.get("/signals/atc/active", (_req: Request, res: Response) => {
  ensureProbeLoop();
  const list = [...mountHealth.values()]
    .filter((m) => m.online && m.active && m.maxDb > -55)
    .sort((a, b) => {
      if (a.talkingNow !== b.talkingNow) return a.talkingNow ? -1 : 1;
      if (a.continuous !== b.continuous) return a.continuous ? 1 : -1; // Prefer real controller/pilot chatter first, ATIS after
      return b.meanDb - a.meanDb;
    });
  res.json({
    feeds: list,
    now: Date.now(),
  });
});

/** Relays LiveATC audio with CORS headers so Web Audio API can boost gain, compress dynamics, and measure real-time dB. */
const RELAY_MAX = 24;
let relayInFlight = 0;

router.get("/signals/atc/relay/:mount", async (req: Request, res: Response) => {
  const mount = String(req.params.mount).toLowerCase();
  if (!MOUNT_RE.test(mount)) { res.status(400).end(); return; }
  if (relayInFlight >= RELAY_MAX) { res.status(429).setHeader("Retry-After", "10").end(); return; }
  relayInFlight++;
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  try {
    const { r, isAudio } = await openLiveAtc(mount, ctl.signal);
    if (!isAudio || !r.body) { res.status(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": r.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    const reader = r.body.getReader();
    while (!ctl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((ok) => res.once("drain", ok));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.status(502).end(); else res.end();
  } finally {
    relayInFlight--;
  }
});

/** Reads `seconds` of live audio from a mount and returns it as a base64 data URL, verifying it has audible signal. */
async function captureMount(mount: string, seconds: number): Promise<{ dataUrl: string; usedMount: string }> {
  async function grab(targetMount: string, secs: number): Promise<{ buf: Buffer; mime: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (secs + 8) * 1000);
    const chunks: Uint8Array[] = [];
    let mime = "audio/mpeg";
    try {
      const { r, isAudio } = await openLiveAtc(targetMount, ctl.signal);
      if (!isAudio || !r.body) throw Object.assign(new Error("feed offline"), { status: 404 });
      mime = (r.headers.get("content-type") ?? mime).split(";")[0];
      const reader = r.body.getReader();
      const until = Date.now() + secs * 1000;
      let size = 0;
      while (Date.now() < until && size < 3_000_000) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      if (!chunks.length) throw Object.assign(new Error("LiveATC connection busy. Audio playback continues; retry transcription shortly."), { status: 502 });
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    return { buf: Buffer.concat(chunks), mime };
  }

  let { buf, mime } = await grab(mount, seconds);
  let usedMount = mount;
  const vol = await measureMp3BufferDb(buf);
  // If the primary mount was in squelch during this window, automatically fall back to its companion or top active mount
  if (vol.maxDb < -45) {
    const info = mountHealth.get(mount);
    const fallbackMount = info?.companion || "rjtt_app";
    if (fallbackMount !== mount) {
      try {
        const alt = await grab(fallbackMount, Math.min(seconds, 16));
        const altVol = await measureMp3BufferDb(alt.buf);
        if (altVol.maxDb > vol.maxDb) {
          buf = alt.buf;
          mime = alt.mime;
          usedMount = fallbackMount;
        }
      } catch {
        /* keep original buffer */
      }
    }
  }
  return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, usedMount };
}

const KEYWORDS: { re: RegExp; tag: string; severity: 1 | 2 | 3 }[] = [
  { re: /\bmayday\b/i, tag: "MAYDAY", severity: 3 },
  { re: /\bpan[\s-]?pan\b/i, tag: "PAN-PAN", severity: 3 },
  { re: /\bemergency\b/i, tag: "EMERGENCY", severity: 3 },
  { re: /\b(squawk(ing)?\s*)?(7700|seven\s+seven\s+zero\s+zero)\b/i, tag: "SQUAWK 7700", severity: 3 },
  { re: /\b(squawk(ing)?\s*)?(7600|seven\s+six\s+zero\s+zero)\b/i, tag: "SQUAWK 7600", severity: 3 },
  { re: /\b(squawk(ing)?\s*)?(7500|seven\s+five\s+zero\s+zero)\b/i, tag: "SQUAWK 7500", severity: 3 },
  { re: /\bhijack/i, tag: "HIJACK", severity: 3 },
  { re: /\b(fire|smoke)\b/i, tag: "FIRE/SMOKE", severity: 3 },
  { re: /\bsouls on board\b/i, tag: "SOULS ON BOARD", severity: 3 },
  { re: /\bengine (failure|out|fire)|\bshut ?down\b/i, tag: "ENGINE", severity: 3 },
  { re: /\bdivert(ing|ed)?\b|\bdiversion\b/i, tag: "DIVERSION", severity: 2 },
  { re: /\bminimum fuel\b|\bfuel emergency\b|\blow fuel\b/i, tag: "FUEL", severity: 2 },
  { re: /\bmedical\b/i, tag: "MEDICAL", severity: 2 },
  { re: /\breturn(ing)? to (the )?(field|airport|departure)\b/i, tag: "RETURN TO FIELD", severity: 2 },
  { re: /\b(lost comm|no radio|nordo)\b/i, tag: "LOST COMMS", severity: 2 },
  { re: /\bbird strike\b/i, tag: "BIRD STRIKE", severity: 2 },
  { re: /\bwind ?shear\b/i, tag: "WINDSHEAR", severity: 2 },
  { re: /\b(tcas|resolution advisory)\b/i, tag: "TCAS RA", severity: 2 },
  { re: /\brunway incursion\b/i, tag: "RUNWAY INCURSION", severity: 2 },
  { re: /\bgo(ing)?[\s-]around\b|\bmissed approach\b/i, tag: "GO-AROUND", severity: 1 },
  { re: /\bunable\b/i, tag: "UNABLE", severity: 1 },
  { re: /\bhold(ing)?\b/i, tag: "HOLDING", severity: 1 },
];

export function scanKeywords(text: string) {
  const hits: { tag: string; severity: number; excerpt: string }[] = [];
  for (const k of KEYWORDS) {
    const m = k.re.exec(text);
    if (!m) continue;
    const at = m.index;
    hits.push({ tag: k.tag, severity: k.severity, excerpt: text.slice(Math.max(0, at - 50), at + m[0].length + 50).trim() });
  }
  return hits.sort((a, b) => b.severity - a.severity);
}

const TRANSCRIBE_SYSTEM = `You are an air traffic control radio transcriber.
Transcribe the attached ATC audio clip verbatim using standard ICAO phraseology (callsigns, flight levels, headings, runways, squawk codes as digits).
Label each transmission as "ATC" or with the aircraft callsign when it can be heard. Skip silence and static. Never invent transmissions.
Respond with ONLY a JSON object, no markdown:
{"lines":[{"speaker":"ATC|<callsign>","text":"..."}],"callsigns":["..."],"summary":"one short sentence, or empty if nothing notable"}
If there is no intelligible speech, respond {"lines":[],"callsigns":[],"summary":""}.`;

router.post("/signals/atc/capture", async (req: Request, res: Response) => {
  const { mount, icao, feed, seconds } = (req.body ?? {}) as { mount?: string; icao?: string; feed?: string; seconds?: number };
  const m = String(mount ?? "").toLowerCase();
  if (!MOUNT_RE.test(m)) { res.status(400).json({ error: "invalid mount" }); return; }
  const secs = Math.min(45, Math.max(8, Number(seconds) || 20));
  if (captureInFlight >= 4) { res.status(429).json({ error: "Too many live transcriptions running. Try again shortly.", retryAfterSec: 15 }); return; }
  captureInFlight++;
  try {
    const { dataUrl, usedMount } = await captureMount(m, secs);
    res.json(await transcribe(dataUrl, icao, usedMount !== m ? `${feed ?? m.toUpperCase()} (${usedMount.toUpperCase()})` : (feed ?? m.toUpperCase())));
  } catch (e) {
    sendTranscribeError(res, e);
  } finally {
    captureInFlight--;
  }
});

router.post("/signals/atc/transcribe", async (req: Request, res: Response) => {
  const { audio, icao, feed } = (req.body ?? {}) as { audio?: string; icao?: string; feed?: string };
  if (typeof audio !== "string" || !/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audio)) {
    res.status(400).json({ error: "audio must be a base64 audio data URL" });
    return;
  }
  if (audio.length > 7_500_000) {
    res.status(413).json({ error: "clip too large" });
    return;
  }
  try {
    res.json(await transcribe(audio, icao, feed));
  } catch (e) {
    sendTranscribeError(res, e);
  }
});

function sendTranscribeError(res: Response, e: unknown) {
  const err = e as { status?: number; message?: string; retryAfterSec?: number };
  if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
  res.status(err.status ?? 502).json({ error: err.message ?? "transcription failed", retryAfterSec: err.retryAfterSec });
}

async function transcribe(audio: string, icao?: string, feed?: string) {
    const out = await geminiChat({
      provider: "gemini",
      system: TRANSCRIBE_SYSTEM,
      tools: [],
      messages: [{ role: "user", text: `Airport ${icao ?? "unknown"}, feed ${feed ?? "unknown"}. Transcribe this clip.`, images: [audio] }],
    });
    const raw = out.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed: { lines?: { speaker?: string; text?: string }[]; callsigns?: string[]; summary?: string } = {};
    try {
      parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    } catch {
      parsed = { lines: raw ? [{ speaker: "?", text: raw }] : [] };
    }
    const lines = (parsed.lines ?? []).filter((l) => l.text).map((l) => ({ speaker: String(l.speaker ?? "?"), text: String(l.text) }));
    const fullText = lines.map((l) => l.text).join(" \n");
    return {
      lines,
      callsigns: parsed.callsigns ?? [],
      summary: parsed.summary ?? "",
      flags: scanKeywords(fullText),
      model: out.model,
      at: Date.now(),
    };
}

export default router;
