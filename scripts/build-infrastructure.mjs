#!/usr/bin/env node
/**
 * Builds the bundled physical-infrastructure snapshots served by
 * /api/proxy/infra/* (artifacts/api-server/src/routes/infrastructure.ts).
 *
 *   node scripts/build-infrastructure.mjs            # download everything
 *   INFRA_RAW=/tmp node scripts/build-infrastructure.mjs  # reuse raw downloads in /tmp if present
 *
 * Sources
 *   cables.json      TeleGeography Submarine Cable Map (CC BY-NC-SA 3.0)
 *   datacenters.json OpenStreetMap telecom=data_center via Overpass (ODbL 1.0)
 *   dams.json        Wikidata dams (CC0), capacity enriched from the WRI
 *                    Global Power Plant Database hydro plants (CC BY 4.0)
 *
 * The global Overpass/Wikidata queries take minutes and are rate limited, which
 * is why the server ships these snapshots and only refreshes them in the background.
 */
import fs from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "../artifacts/api-server/data/infrastructure");
const RAW = process.env.INFRA_RAW;
const UA = "WorldviewOSINT/1.0 (infrastructure snapshot builder)";

async function raw(file, fetcher) {
  if (RAW) {
    try {
      return await fs.readFile(path.join(RAW, file), "utf8");
    } catch { /* fall through to network */ }
  }
  console.log(`fetching ${file}…`);
  const text = await fetcher();
  if (RAW) await fs.writeFile(path.join(RAW, file), text);
  return text;
}

const get = (url, init = {}) =>
  fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) } }).then(async (r) => {
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.text();
  });

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r3 = (n) => Math.round(n * 1e3) / 1e3;
const clean = (s) => (typeof s === "string" ? s.trim() || null : null);

// ── submarine cables ──────────────────────────────────────────────────────
async function buildCables() {
  const cables = JSON.parse(await raw("cable.json", () => get("https://www.submarinecablemap.com/api/v3/cable/cable-geo.json")));
  const landings = JSON.parse(await raw("lp.json", () => get("https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json")));
  const out = {
    cables: cables.features.map((f) => ({
      id: f.properties.id,
      name: f.properties.name,
      color: f.properties.color,
      lines: (f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates).map((line) =>
        line.map(([x, y]) => [r3(x), r3(y)]),
      ),
    })),
    landings: landings.features.map((f) => [r4(f.geometry.coordinates[0]), r4(f.geometry.coordinates[1]), f.properties.name, f.properties.id]),
  };
  console.log(`cables: ${out.cables.length} cables, ${out.landings.length} landing points`);
  return out;
}

// ── data centres ──────────────────────────────────────────────────────────
async function buildDatacenters() {
  const q = '[out:json][timeout:180];nwr["telecom"="data_center"];out center tags;';
  const j = JSON.parse(
    await raw("dc.json", () =>
      get("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }) }),
    ),
  );
  const rows = [];
  for (const e of j.elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const t = e.tags ?? {};
    // [lon, lat, name, operator, osmRef, city, country]
    rows.push([
      r4(lon), r4(lat),
      clean(t.name) ?? clean(t["name:en"]),
      clean(t.operator) ?? clean(t.brand) ?? clean(t.owner),
      `${e.type[0]}${e.id}`,
      clean(t["addr:city"]),
      clean(t["addr:country"]),
    ]);
  }
  console.log(`datacenters: ${rows.length}`);
  return { rows };
}

// ── dams ──────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function buildDams() {
  const sparql = `SELECT ?d ?name ?coord ?river ?height ?year WHERE {
  ?d wdt:P31/wdt:P279? wd:Q12323 ; wdt:P625 ?coord .
  OPTIONAL { ?d rdfs:label ?name . FILTER(LANG(?name) = "en") }
  OPTIONAL { ?d wdt:P177/rdfs:label ?river . FILTER(LANG(?river) = "en") }
  OPTIONAL { ?d wdt:P2048 ?height . }
  OPTIONAL { ?d wdt:P571 ?inc . BIND(YEAR(?inc) AS ?year) }
}`;
  const wd = JSON.parse(
    await raw("dams.json", () =>
      get("https://query.wikidata.org/sparql", {
        method: "POST",
        headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: sparql }),
      }),
    ),
  );

  const byId = new Map();
  for (const b of wd.results.bindings) {
    const qid = b.d.value.split("/").pop();
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord.value);
    if (!m) continue;
    const lon = Number(m[1]), lat = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const prev = byId.get(qid);
    const height = b.height ? Number(b.height.value) : null;
    const year = b.year ? Number(b.year.value) : null;
    if (!prev) {
      byId.set(qid, { lon, lat, name: b.name?.value ?? null, river: b.river?.value ?? null, height, year, mw: null, qid });
    } else {
      prev.name ??= b.name?.value ?? null;
      prev.river ??= b.river?.value ?? null;
      if (height && height < 400 && (!prev.height || height > prev.height)) prev.height = height;
      prev.year ??= year;
    }
  }
  const dams = [...byId.values()];

  // Attach installed hydro capacity (MW) from WRI to the nearest dam within ~4 km.
  const csv = await raw("gppd.csv", () =>
    get("https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv"),
  );
  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = (k) => header.indexOf(k);
  const [iName, iCap, iLat, iLon, iFuel, iYear, iOwner] = ["name", "capacity_mw", "latitude", "longitude", "primary_fuel", "commissioning_year", "owner"].map(col);

  const CELL = 0.05;
  const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const grid = new Map();
  for (const d of dams) {
    const k = key(d.lat, d.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(d);
  }

  let matched = 0, added = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseCsvLine(lines[i]);
    if (r[iFuel] !== "Hydro") continue;
    const lat = Number(r[iLat]), lon = Number(r[iLon]), mw = Number(r[iCap]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(mw > 0)) continue;
    let best = null, bestD = 0.04 * 0.04;
    const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const d of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const dd = (d.lat - lat) ** 2 + ((d.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
          if (dd < bestD) { bestD = dd; best = d; }
        }
      }
    }
    if (best) {
      best.mw = Math.max(best.mw ?? 0, mw);
      best.owner ??= clean(r[iOwner]);
      matched++;
    } else if (mw >= 10) {
      // Large hydro stations missing from Wikidata's dam class still belong on the map.
      const year = Number(r[iYear]);
      dams.push({
        lon, lat, name: clean(r[iName]), river: null, height: null,
        year: Number.isFinite(year) && year > 1800 ? Math.round(year) : null,
        mw, qid: null, owner: clean(r[iOwner]),
      });
      added++;
    }
  }
  console.log(`dams: ${byId.size} wikidata, ${matched} hydro matched, ${added} hydro-only added`);

  // [lon, lat, name, river, heightM, mw, year, wikidataId, owner]
  const rows = dams.map((d) => [
    r4(d.lon), r4(d.lat), d.name, d.river,
    d.height ? Math.round(d.height) : null,
    d.mw ? Math.round(d.mw * 10) / 10 : null,
    d.year, d.qid, d.owner ?? null,
  ]);
  return { rows };
}

await fs.mkdir(OUT, { recursive: true });
const builtAt = new Date().toISOString();
for (const [file, build] of [["cables.json", buildCables], ["datacenters.json", buildDatacenters], ["dams.json", buildDams]]) {
  const data = await build();
  await fs.writeFile(path.join(OUT, file), JSON.stringify({ builtAt, ...data }));
}
console.log(`snapshots written to ${OUT}`);
