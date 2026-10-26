# WORLDVIEW OSINT — Progress Log

> Hand-off file. Any AI/dev continuing this work: read this first, then continue from **Next steps**.
> Source repo: https://github.com/daggerm29-oss/sky8 (branch `main`, imported into the v0 workspace without `.git`).
> Latest import (2026-10-23): https://github.com/daggerm29-oss/PLANS.git

## Step 18 — AI COPILOT (voice-controlled geospatial assistant) — IN PROGRESS, started 2026-10-23
Request: AI that can Direct (camera), Annotate (draw on globe), Interrogate (live analytics) and Operate (UI) the
console, with voice in + spoken replies. Two providers:
1. **Gemini free tier** (web + local) — key in env `GEMINI_KEY`, flash model, aggressive rate-limit economy.
2. **OpenAI via OAuth** (LOCAL ONLY — ChatGPT/Codex PKCE login, redirect to http://localhost:1455/auth/callback),
   user picks the OpenAI model. Fallback: `OPENAI_API_KEY` env -> standard Responses API.

Architecture / files (all new unless noted):
- `artifacts/api-server/src/routes/ai.ts` — `/api/ai/status`, `/api/ai/chat` (provider-neutral messages + tool decls in,
  `{text, toolCalls}` out), `/api/ai/openai/login|logout|models`, `/api/ai/hazards` (EONET fires/storms/volcanoes + USGS quakes, cached).
  Gemini: REST generateContent with functionDeclarations, thinkingBudget 0, sliding-window RPM limiter + daily counter,
  queued waits, 429 retry-after parsing + fallback model. OpenAI OAuth: PKCE, callback server on :1455, tokens in
  `.data/openai-auth.json` (gitignored), refresh, calls `chatgpt.com/backend-api/codex/responses` (SSE).
  Mounted in `routes/index.ts` AND `worldview/vite.config.ts` (API runs inside Vite in dev).
- `worldview/src/lib/ai/tools.ts` — ~30 tool declarations (JSON schema).
- `worldview/src/lib/ai/bridge.ts` — `WorldBridge` type: what WorldviewMap exposes to the agent (state getters + actions).
- `worldview/src/lib/ai/executor.ts` — runs tool calls against the bridge (analytics are computed locally = 0 LLM calls).
- `worldview/src/lib/ai/annotations.ts` — MapLibre `ai-annotations` source/layers (pins, labels, lines, polygons, circles).
- `worldview/src/lib/ai/geo.ts` — Nominatim geocode (cached), OSRM routing, haversine, point-in-polygon, camera orbit/fly-route.
- `worldview/src/lib/ai/fast-intents.ts` — local regex commands (fly to / zoom out / vision mode / open panel / stop)
  handled WITHOUT any LLM call (biggest quota saver).
- `worldview/src/lib/ai/agent.ts` — agent loop (max 4 tool rounds, history trimmed, compact scene context per turn).
- `worldview/src/lib/ai/voice.ts` — Web Speech API recognition + speechSynthesis (free, no API calls).
- `worldview/src/components/AiCopilot.tsx` — floating console: provider/model select, chat log, mic, speak toggle, quota meter.
- `WorldviewMap.tsx` (edit) — builds the bridge each render into a ref, mounts `<AiCopilot>`.
- `CinematicTracker.tsx` (edit) — listens to `worldview:cockpit` window event so the AI can enter cockpit mode.

Checklist:
- [x] 18a server route ai.ts (gemini + openai oauth + hazards + /ai/route OSRM proxy) + mounting (vite.config.ts, routes/index.ts, json limit 8mb)
- [x] 18b client lib (tools, bridge, executor, annotations, geo, fast-intents, agent, voice)
- [x] 18c AiCopilot UI + WorldviewMap wiring (`aiBridgeRef` built right before the JSX return; `<AiCopilot>` before EntityInfoPanel) + cockpit event
- [x] 18d typecheck clean (worldview + api-server ai.ts)
- [ ] 18e live test with Gemini key in browser

## Architecture (as found)

```
next dev (port 3000, scripts/dev.mjs)  --rewrites /*-->  Vite dev server (5173)
                                                           artifacts/worldview (React 19 + MapLibre GL v5 + Cesium + three)
                                                           vite.config.ts mounts the Express routers from
                                                           artifacts/api-server/src/routes (proxy.ts, cctv.ts) at /api
Express proxy (/api/proxy/*)  --> upstream maritime backend (SHIPS_UPSTREAM_URL) + adsb.lol + CelesTrak + CCTV feeds
```

- `artifacts/worldview/src/pages/WorldviewMap.tsx` (~2.5k lines) — main map page, state, layers, toolbar.
- `components/ShipsLayer.tsx`, `SatelliteLayer.tsx`, `PlaybackLayer.tsx`, `CctvLayer.tsx` — MapLibre layers.
- `components/CesiumFollowCam.tsx` — Cesium 3D follow camera (pre-existing, aircraft only).
- `components/CinematicOverlay.tsx`, `FloatingPanel.tsx`, `MaritimePanel.tsx`, `MasterToolbar.tsx`.
- `artifacts/api-server/src/routes/proxy.ts` — all upstream proxies (ships, dark-fleet, oil, status, playback, adsb).
- 3D models in `artifacts/worldview/public/`: `aeroplane.glb`, `military-aircraft.glb`, `satellite.glb`, `iss.glb`, `ship.glb`, `tanker.glb`.
- npm workspaces (root `package.json`); install with `npm install` at repo root.

## New backend: https://worldview-intel-i09c.onrender.com

Verified live 2026-10-17 (same JSON schema as the old Render backend):
- `/api/status` → `{live_vessels, dark_ships_tracked, ais:{...}, uptime_min}`
- `/api/radar` → `[{mmsi, vessel_name, lat, lon, sog, cog, last_updated, dwt, est_barrels, category, source}]` (~3.3 MB)
- `/api/live` → same without dwt/category
- `/api/dark-fleet` → `[{mmsi, ship_name, last_known_lat, last_known_lon, time_went_dark, last_sog, last_cog}]`
- `/api/analytics/live-oil`, `/api/playback/config` → OK

## Step log

- [x] **Step 1** — Cloned repo, mapped architecture, probed new backend (all endpoints 200).
- [x] **Step 2** — Imported repo into v0 workspace; removed conflicting v0 template files.
- [x] **Step 3** — Backend migration: `proxy.ts` default `SHIPS_UPSTREAM_URL` → `https://worldview-intel-i09c.onrender.com`,
      `.env.example` + `replit.md` updated. `grep -r onrender` is clean.
- [x] **Step 4** — Single-click → right-side `EntityInfoPanel` (ship / aircraft / satellite). `ShipsLayer` got `onSelect/onTrack`
      (padded bbox picking); `SatelliteLayer` got `onFocus/onTrack` (dblclick); aircraft already had click/dblclick and now also feeds the panel via `focus` state in `WorldviewMap.tsx`.
- [x] **Step 5** — Double-click → cinematic 3D follow view. New `lib/tracked-entity.ts`, `components/CinematicTracker.tsx`
      (Cesium, own lookAt camera: log-range intro zoom-in from 3000 km, drag-orbit, wheel zoom, dead reckoning, trail, fade),
      `CinematicHost.tsx` (keeps last target mounted so exit = pull-back + fade, ~1.5s), `CinematicController` in `WorldviewMap.tsx`.
      Models: aeroplane/military-aircraft/ship/tanker/satellite/iss .glb. Esc or panel EXIT 3D exits. Old `CesiumFollowCam.tsx` is now unused (safe to delete).
- [x] **Step 6** — `npm install` + `node scripts/dev.mjs` (Next :3000 -> Vite :5173). Browser-verified aircraft path end to end:
      click -> right panel, TRACK 3D -> intro zoom + GLB aircraft over 3D terrain with panel kept visible, Esc -> pull-back + fade + map restore.
      Ships/satellites share the same code path and type-check, but were NOT live-tested: the new backend currently reports
      `live_vessels: 0` (AIS socket closed), only 50 dark-fleet gap candidates; satellites need 3D ORBITAL + SATS on.

- [x] **Step 7** — Aircraft feed hardening: `proxy.ts` slims adsb.lol payload (7 MB → ~2 MB), dedupes in-flight
      upstream fetches, serves stale while refreshing; `WorldviewMap.tsx` `fetchData` skips overlapping polls,
      45 s timeout, keeps last aircraft on transient failure (no more "FEED INTERRUPTED" + 0 contacts).

## Step 8 — 3D cinematic view fixes (IN PROGRESS, all in `components/CinematicTracker.tsx` unless noted)
User report: dblclick 3D slow / sometimes no model; ship floats above sea; plane faces wrong way;
model jitters forward/back; remove red/white/green dots (wingtip lights) and the line (trail).
Root causes found:
- Slow: entity was created only AFTER `await loadGoogleTileset()` → model waited on tiles. Fix: add entity first,
  load tiles in background; prefetch GLBs on app start (`lib/tracked-entity.ts` `preloadModels`).
- Floating ship: placed at ellipsoid h=0, Google tiles sea is at geoid (~-30..-60 m in Arabian Sea). Fix: sample
  surface height under the vessel from the tileset (`scene.clampToHeightMostDetailed`) and put hull at waterline.
- Jitter: each new sample restarted dead reckoning from an older position → snap back. Fix: display has its own
  velocity, error corrected smoothly with forward-only along-track clamp.
- Wrong facing: per-model heading offset verified visually (see `MODEL_HEADING_OFFSET`).
- Extra root cause of jitter: `CinematicController` (WorldviewMap.tsx) rebuilds `target` every render, and the
  tracker treated each render as a new sample → dead reckoning restarted from the stale fix. Now keyed by value.
- [x] 8a remove lights + trail  - [x] 8b non-blocking load + `preloadModels` (called in WorldviewMap)
- [x] 8c sea-level: `scene.sampleHeightMostDetailed` every 5 s, hull at `surface + keelDepth*scale` (`MODEL_GEOMETRY`)
- [x] 8d smooth motion (own velocity + clamped error correction; aircraft `seen` → `sampleAgeSec`)
- [x] Fixed vessel "LAST UPDATE: Invalid Date" (ISO string timestamps)
- [x] 8e heading offset verified in browser (side view, yaw -90°): all 4 aircraft/ship models need 180°
      (was -90 → sideways). Satellites kept at -90 (unchanged, unverified).
- [x] Model is now a `Cesium.Model` primitive whose matrix is set in the same preRender as the camera
      (entity version trailed ~1 frame behind the camera → stutter).
- [x] Ship waterline verified over Google tiles sea (Spain coast, sampled surface ≈ +37 m ellipsoidal).
- [x] Temp debug hooks removed. **Step 8 DONE.**
- tsc clean (except pre-existing `src/components/ui/*`). `scripts/analyze-glb.mjs` = model bounds tool.

## Step 9 — VISION MODES (IN PROGRESS, started 2026-10-19)
Request: switchable vision modes over the map AND the photorealistic Google 3D tiles (cinematic view):
Tactical (existing dark, default), Normal (optical), CRT/Retro, NVG, FLIR (thermal), Anime, Noir, Snow, Satellite.
Aircraft/ship/satellite icons + 3D models must match each mode.

Design (all new code is self-contained):
- `src/lib/vision-modes.ts` — `VisionMode` type, `VISION_MODES` config (label, hotkey, CSS `filter` string,
  imagery on/off, entity paint overrides), `applyVisionToMap(map, mode, baseLayerIds)`:
  adds Esri World Imagery raster under the base-style labels for every mode except Tactical, and overrides
  icon/circle/line colours + halos of all app (non-base-style) layers (FLIR/NVG/Noir → white-hot; Anime/Snow/Optical → dark outline). Originals are cached and restored.
- `src/components/VisionFilters.tsx` — hidden `<svg>` with SVG filter chains (NVG phosphor+bloom, FLIR WHOT/BHOT/IRONBOW,
  CRT RGB split+bloom, Anime posterize+ink edges, Noir S-curve, Snow whitening, Satellite sharpen).
- `src/components/VisionOverlay.tsx` — pointer-events:none effects + HUD per mode (grain, scanlines, aperture grille,
  tube vignette, falling-snow canvas, FLIR reticle + palette bar, satellite telemetry/grid).
- `src/components/VisionModeSelector.tsx` — top-centre switcher (hotkeys 1–9) + FLIR palette sub-toggle. Persisted in localStorage (UI pref only).
- `WorldviewMap.tsx` — all world layers (map canvas, satellite canvas, Cesium cinematic) wrapped in one `<div style={{filter}}>`
  so map, icons and 3D models get the identical treatment; records base-style layer ids on load; re-applies on `styledata`.
- `CinematicTracker.tsx` — `visionMode` prop: night tile shader only in Tactical; Esri imagery globe otherwise.

Checklist:
- [x] 9a vision-modes.ts  - [x] 9b VisionFilters  - [x] 9c VisionOverlay  - [x] 9d Selector
- [x] 9e wired into WorldviewMap (+CinematicController/Host/Tracker `visionMode` prop). tsc clean.
- [x] 9f browser-verified all 9 modes on the 2D map + cinematic 3D (Google photorealistic tiles) in OPT/NVG/FLIR/ANIME.
      Tuning done: Anime blur 1.6→0.8, saturate 2.1→1.7, entities white + ink halo (cyan icons vanished into posterized sea).
      3D model now matches each mode: `MODEL_VISION` + `applyModelVision` in `CinematicTracker.tsx`
      (FLIR yellow→white-hot, NVG/Noir bright, Snow dark, Anime/CRT silhouette outline).
- [x] Bug fix: after EXIT 3D, TRACK 3D was silently cancelled (selectedAircraft null → "selection cleared" effect).
      `trackFocused` now re-selects the aircraft. **Step 9 DONE.**
- [x] Bug fix: map remount (HMR) threw `getLayer` on undefined / "Style is not done loading" in Ships/Cctv/Playback layers.
      WorldviewMap cleanup now `setMapLoadedState(false)`; layer teardowns bail when `!map.style` (map already removed).
- Note: switching modes, aircraft tiles may briefly keep the previous mode's colour until MapLibre re-renders them (transient).

## Step 10 — 3D cinematic upgrades (IN PROGRESS, started 2026-10-19, repo now github.com/daggerm29-oss/PLANJ)
Requests: (a) aircraft camera a little closer + zoom in/out control for 3D models; (b) ship view: animated
turquoise neon ocean shader (procedural waves, crest highlights, starry dark backdrop, glowing wake ripples,
splash particles); (c) satellite 3D: 2D satellite icon canvas was drawn on top of the 3D view (SatelliteLayer
canvas zIndex 6 > Cesium 5) -> hide it while tracking; (d) animated marching dashed glowing-green orbit path.
Plan / files:
- `CinematicTracker.tsx`: realistic aircraft scale (zoom now changes model size), closer default range,
  zoom HUD (+ / - / reset, portal to body, also +/- keys). Ship: no Google tiles; `lib/ocean-shader.ts`
  builds a GLB grid + CustomShader (waves in VS, neon crests/grid/Kelvin wake/rings in FS) and a Cesium
  ParticleSystem bow/stern spray; ship bobs with the waves. Satellite: if `target.ecefAt` exists the model is
  placed exactly on the SGP4 propagated position each frame and an orbit polyline with a custom
  marching-dash glow material is drawn (rebuilt every 2 s, dense samples near the satellite).
- `SatelliteLayer.tsx`: `hidden` prop (canvas hidden, propagation continues) + exported `satEcefAt(id, date)`.
- `WorldviewMap.tsx`: pass `hidden={!!trackedSatId}`; CinematicController adds `ecefAt` to the satellite target.
Checklist: - [x] 10a aircraft scale/zoom HUD (`components/CinematicZoomControl.tsx`)  - [x] 10b ocean shader + spray
(`lib/ocean-shader.ts`)  - [x] 10c hide sat canvas  - [x] 10d orbit path (`lib/orbit-path.ts`)  — all code written, tsc clean.
- [ ] 10e browser verify (aircraft, ship, satellite) + tune

## Step 11 — Ship 3D on the REAL map + real forward motion (IN PROGRESS, 2026-10-19, repo github.com/daggerm29-oss/PLANK)
User report (with screenshots): ship view ocean was an artificial square tile floating in black space (zooming out
showed the whole tile, no land/coast); ship looked like it floated in place (feed speed/course = N/A -> speed 0).
Plan / files:
- `CinematicTracker.tsx` (ship): real globe = Esri World Imagery via `ArcGisMapServerImageryProvider` (discards
  "map data not available" ocean tiles) + Cesium World Terrain with water mask (animated real ocean, real coastlines),
  sky atmosphere + stars. Sea level sampled from terrain (geoid), neon ocean sits on it.
- `lib/ocean-shader.ts`: mesh becomes TRANSLUCENT; alpha fades radially (blends into the real sea),
  fades with camera range (zoom out -> pure real map), land-mask texture (terrain-sampled grid around ship) hides
  the neon water over land. JS port of the swell (`swellHeight`) drives ship heave/pitch/roll so hull rides the visible waves.
- `lib/tracked-entity.ts` `shipCruiseSpeedMs(category)` + `WorldviewMap.tsx`: when sog/cog unknown -> realistic
  estimated cruise speed (tanker 12 kn, cargo 14 kn, military 18 kn) so the ship sails forward through the
  world-anchored waves/grid with a wake.
Checklist: - [x] 11a real globe/terrain/imagery  - [x] 11b translucent fading ocean + land mask (+ neon coastline)
- [x] 11c estimated cruise speed (`motionEstimated` -> free-run dead reckoning, steers away from land via mask)
      + wave-driven heave/pitch/roll  — code written, tsc clean.
- [x] 11d browser verified (via `window.__wv.trackShip(mmsi)`):
      Port Qasim tanker 563005900 -> hull on real sea (terrain sea level ≈ -43.7 m), real land/imagery around;
      open-sea tanker 563094300 (7.77N 72.84E) -> neon ocean + wake on real globe, zoom out to 400 km shows
      real globe, atmosphere, stars, coast on the horizon; 207 km = top-down real ocean.
      Tuning: land threshold sea+3 m, clear channel of 3 ship lengths around the vessel (creeks/tidal flats),
      coast glow 0.5; camera auto-tilts to top-down when zooming out (`effectivePitch`); distance uses real
      elapsed time (`moveDt`, cap 1 s) so low-fps devices don't slow the ship. **Step 11 DONE.**
- Note: sandbox GPU renders ~1 fps, so live speed there reads low; on real hardware tanker = 6.2 m/s (12 kn).
- `window.__wv` debug hook in `WorldviewMap.tsx` (pre-existing) is used for testing; remove before production.

## Step 12 — LIVE AIRPORT VIEW (IN PROGRESS, started 2026-10-19, repo github.com/daggerm29-oss/PLANL)
Request: "drop the camera into any busy airport" -> photorealistic 3D airport with LIVE aircraft, including
aircraft on the ground (taxiing / parked) sitting on the runway/taxiway surface (like bilawalsidhu/gods-eye-view).
Approach (fits our architecture: Express proxy -> adsb.lol, Vite client, Cesium + Google 3D tiles):
- `api-server/src/routes/proxy.ts`:
  - `GET /api/proxy/adsb/airport?lat&lon&radius` (nm, 2-40, default 12) -> adsb.lol `/point`, 3 s cache,
    richer slim (alt_geom, baro_rate, true_heading, ground flag) so ground traffic is kept.
  - `GET /api/proxy/adsb/route/:callsign` -> adsbdb.com callsign route enrichment (origin/destination), 6 h cache + in-flight dedupe.
- `worldview/src/lib/airports.ts` — curated busy airports (ICAO/IATA/name/lat/lon/elevFt) + `nearestAirport()`.
- `worldview/src/lib/airport-traffic.ts` — pure helpers: normalise contact (ground detection: alt_baro "ground"
  or gs<40kt & AGL<60 m), model + scale per ADS-B category, AGL from field elevation, dead reckoning.
- `worldview/src/components/AirportView.tsx` — Cesium viewer (Google photorealistic tiles via exported
  `loadGoogleTileset` from CinematicTracker), free camera (orbit/pan/zoom), one `Cesium.Model` per contact,
  ground snapping: `scene.sampleHeightMostDetailed` at 5 points (min, so jet bridges/roofs/baked-in aircraft
  meshes don't lift it) + wheel offset (`model minY * scale`); airborne = field surface + (alt_baro - elev) AGL.
  Labels (callsign + GND/alt), click to select -> HUD info + route enrichment. Polls every 3 s.
- `worldview/src/components/AirportHud.tsx` — portal HUD (outside the vision filter): airport header,
  ground/airborne counts, contact list, selected contact card, view buttons (TOP/OBLIQUE), EXIT (Esc).
- `worldview/src/components/AirportPanel.tsx` — FloatingPanel airport picker (search) + "DROP AT MAP CENTRE".
- `WorldviewMap.tsx` — toolbar button "Airport View", `airportView` state, auto chip when map zoom >= 11 near
  a known airport, mounts AirportView inside the world stack (vision modes apply).
Checklist:
- [x] 12a proxy endpoints (`/proxy/adsb/airport`, `/proxy/adsb/info`)  - [x] 12b `lib/airports.ts` + `lib/airport-traffic.ts`
  (CinematicTracker now exports `loadGoogleTileset`, `TILESET_NIGHT_SHADER`, `applyModelVision`)
- [x] 12c `components/AirportView.tsx` + `components/AirportHud.tsx` written
- [x] 12d `components/AirportPanel.tsx` (+ `AirportProximityChip`), `AirportIcon` in MasterToolbar, WorldviewMap wiring
      (`enterAirport` / `exitAirport` / `dropAirportAtCenter`, moveend proximity check)
- [x] 12e tsc clean (only pre-existing `src/components/ui/*` errors). Browser verified at KJFK: 67-71 live contacts
      (~35 parked, ~15-20 taxi, rolling + ~16 airborne), GLB models sitting on the Google tiles surface, labels
      (parked labels only < 1.8 km to avoid gate clutter), click list -> fly-to + follow + cyan silhouette, adsbdb
      enrichment (AAL525 DFW -> ORD, A319, photo), Esc -> exits and restores Aviation panel.
      Fixes during verify: sky atmosphere/fog disabled (white-out once globe hidden); proxy returns `fetchedAt` so the
      HUD shows the real snapshot age (adsb.lol is intermittently unreachable -> cached snapshot served, "FEED DEGRADED" > 20 s).
      **Step 12 DONE.**
- Ideas not done yet: taxi trails draped on the surface, runway/taxiway overlay from OSM `aeroway`, aircraft pitch on
  climb/descent, show ground aircraft distinctly on the 2D map, larger airport DB (OurAirports CSV) for name lookup on custom drops.
- Note: the proxy routes are mounted by `vite.config.ts`, so changes in `api-server/src/routes/*` need a Vite restart.

## Step 13 — AIRCRAFT COCKPIT VIEW (DONE, started 2026-10-19, repo github.com/daggerm29-oss/PLANM)
Request: while in the aircraft 3D (chase) view, add a first-person COCKPIT view like the reference
(circular visor over photorealistic tiles, labelled nearby flights, GS / HDG / ALT readout, side intel panels,
RESET + EXIT COCKPIT). Built on our architecture: same Cesium viewer in `CinematicTracker.tsx`, same live adsb.lol
aircraft array from `WorldviewMap.tsx` (no new polling), route via existing `/api/proxy/adsb/info` (adsbdb).
Plan / files:
- `lib/cockpit.ts` — types (`CockpitContact`, `CockpitContext`, `CockpitTelemetry`), haversine distance/bearing,
  dead reckoning helpers.
- `lib/cockpit-contacts.ts` — Cesium Label+Point collections for nearby aircraft (<= 150 km), dead-reckoned
  from the last feed sample, depth test off so they read over tiles; shown only in cockpit.
- `components/CockpitHud.tsx` — portal HUD (outside vision filter, zIndex 5000): visor vignette + ring, heading tape,
  pitch ladder (rolls with bank), reticle, GS/HDG/ALT, top status bar (FIRST PERSON, callsign, vision mode, Z clock),
  left flight card, right CONTACT panel (nearest contact bearing/dist, cohort counts aircraft/military/AIS within 100 km)
  + ESTIMATED FLIGHT PLAN (adsbdb origin -> destination), RESET / EXIT COCKPIT buttons, help line.
- `CinematicTracker.tsx` — `cockpit` mode (aircraft only): camera at pilot eye (model hidden), heading + look offset,
  flight pitch from vertical rate, bank from turn rate, drag = look around, wheel/+/- = FOV, `C` toggles,
  sky atmosphere on + sun at local solar noon; exiting 3D drops back to chase first.
- `CinematicZoomControl.tsx` — optional COCKPIT button.
- `tracked-entity.ts` FollowTarget gains callsign/registration/typeCode/squawk/military.
- `WorldviewMap.tsx` CinematicController passes those + `getCockpitContext` (latest aircraft + ships via ref).
Checklist:
- [x] 13a lib/cockpit.ts + cockpit-contacts.ts
- [x] 13b CockpitHud.tsx (+ styles in components/cockpit-hud-css.ts)
- [x] 13c CinematicTracker cockpit camera + input + wiring, zoom-control COCKPIT button
- [x] 13d WorldviewMap wiring (target fields + `getCockpitContext` via useMemo/ref in CinematicController)
- [x] tsc clean (only pre-existing src/components/ui/* errors)
- [x] 13e browser verified (RYR9QX FL370 over France, ECA3ER): COCKPIT button / `C` -> visor HUD, 40+ labelled live
      contacts (callsign, FL, NM), nearest contact BRG/DIST/ΔALT, cohort counts (45 aircraft / 149 AIS within 54 NM),
      adsbdb route NCL -> LPA + airline, GS/HDG/ALT, heading tape, pitch ladder; EXIT COCKPIT -> chase view + model restored.
      Fix during verify: Google photorealistic tiles stay at coarse LOD at cruise altitude (giant blocks at grazing angles),
      so the cockpit uses the Esri imagery globe + fog above 2.5 km (`handles.cockpitGlobe`, hysteresis 2.0 km) and Google
      tiles below. **Step 13 DONE.**
- Ideas not done: Cesium World Terrain in cockpit (mountains on the horizon), declutter labels (only inside visor / top N
  by distance), radio/weather/news pages from the reference, cockpit for military jets with a different HUD colour.
- Workspace note: this v0 workspace was re-imported from PLANM (no .git); upload the changed files to GitHub.
  Run with `npm install` + `node scripts/dev.mjs` (or Vite alone on 5173 behind `next dev`).

## Step 14 — CCTV VIEWSHED (IN PROGRESS, started 2026-10-20)
Request: like the reference "God's Eye View" project — cycle CCTV coverage to VIEWSHED and every camera draws its
estimated coverage (where it reaches, where it goes blind). Reference builds a pose frustum (heading/pitch/FOV/range/
mount height) and clamps range with a ray pick. Our version, on our architecture (MapLibre 2D/2.5D map, cameras from
`/api/proxy/cctv/cameras` + OSM `/api/proxy/cctv/osm` via `hooks/use-cctv.ts`, NO new fetches):
- `lib/viewshed.ts` — pure math:
  * `estimatePose(camera)` — heading parsed from the feed's `direction` (numeric deg, N/NE/.., North, Northbound,
    N/B, "East Facing", "Facing South"); Caltrans/Florida/TfL have it, NYC/Maryland/Austin/Singapore don't ->
    heading unknown -> omnidirectional (360��) line-of-sight at reduced range (honest, labelled "HDG UNKNOWN").
    Per-source mount height / FOV / range defaults (highway 12 m/60°/320 m, urban 8 m/70°/170 m, OSM by camera:type).
  * `computeViewshed(pose, buildings)` — 2D ray cast (1 ray / ~2°) against building footprints from the basemap vector
    tiles (`openmaptiles` source, `building` layer, `render_height`, z13+). Building of height hb at distance d blocks
    everything beyond if hb >= mount, else shadow to d*H/(H-hb) (blocked if that reaches range). The camera's own
    building is ignored (point-in-polygon). Outputs visible polygon, blind polygons, 3D wedge bands, visible %.
- `components/CctvViewshedLayer.tsx` — MapLibre layers: ground fill + outline (source colour), blind fill (red),
  fill-extrusion wedge volume (height falls from mount height to 0 at range), optional 3D buildings; recomputed on
  moveend/idle for <= 250 cameras nearest the centre at z>=13 (CONE mode: unoccluded, z>=12).
- Coverage mode cycle OFF / CONE / VIEWSHED in `CctvPanel.tsx` (+ hotkey V while CCTV panel open), summary stats and
  selected camera pose (heading source, FOV, range, mount, visible %).
- `WorldviewMap.tsx` — state `cctvCoverage`, render layer, pass stats to the panel.
Checklist:
- [x] 14a lib/viewshed.ts
- [x] 14b CctvViewshedLayer.tsx
- [x] 14c CctvPanel coverage control + stats, WorldviewMap wiring (`cctvCoverage`, V hotkey, auto-tilt to 58° on VIEWSHED)
- [x] 14d tsc clean (only pre-existing `src/components/ui/*`). Browser verified 2026-10-20:
      Midtown Manhattan z15.8 -> 120 NYC DOT cameras, 0 aimed / 120 360° LOS, 18,585 building occluders, mean visible 46%,
      LOS follows street canyons, blind zones red, auto-tilt to 58° on VIEWSHED.
      Downtown LA z15.6 pitched -> 20 Caltrans cameras, 20/20 aimed from feed direction, wedges clipped by buildings
      with red blind tails, mean visible 57%. No console errors. **Step 14 DONE.**
- Ideas not done: ray-pick range clamp against terrain in the Cesium views.

## Step 15 — In-scene CCTV frame projection (God's Eye "Upper St Nth/Duncan St" reference) — DONE 2026-10-20
- [x] 15a `lib/live-frame.ts` — shared ref-counted per-camera frame poller (`useLiveFrame`), 2s release grace;
      `CctvViewer`'s RefreshingImage now uses it, so the panel + projection share ONE poll of `/api/proxy/cctv/frame`.
- [x] 15b `lib/frustum.ts` — `buildFrustum(pose, {distanceM, aspect, viewerBearingDeg})`: lens apex at mount height,
      optical axis pitched so it meets ground at 35% of range, image plane corners TL/TR/BR/BL, corner rays to ground.
      `quadToMatrix3d` = Heckbert square→quad homography as CSS matrix3d (perspective-correct warp).
- [x] 15c `components/CctvProjectionLayer.tsx` — MapLibre custom layer (`cctv-frustum-projection`); in `render()`
      projects geo points via `transform.getMatrixForModel` × `defaultProjectionData.mainMatrix` (works mercator + globe),
      then imperatively positions a portal overlay: live frame on the image plane, frustum edges apex→corners,
      dashed ground rays + ground wedge, name/HDG/FOV/RANGE label. Plane distance auto-scales with zoom (~300px wide).
      Shown for the selected camera when zoom ≥ 14; aspect from the frame's natural size. Omni cams face the viewer ("FACING VIEWER").
- [x] 15d `selectCctvCamera` → chase view: z18.3, pitch ≤62°, bearing = camera heading, centre 28 m ahead of lens.
- [x] 15e `parseHeading` now understands "Zoom south - …", "View east", "Looking west" (TfL JamCam text) → TfL cams aimed.
- Verified: TfL "Upper St Nth/Duncan St" → HDG 180°, live frame projected, stays world-anchored when orbiting; tsc clean, no console errors.
- Not done: depth-occlusion of the plane by extruded buildings (overlay is drawn above the canvas); HLS-only cams show
  "STREAM · SEE FEED PANEL" on the plane instead of the video (avoids a second stream).
- Resumed 2026-10-20 in a fresh v0 workspace imported from github.com/daggerm29-oss/PLANN (code for 14a–c found complete).

## Step 16 — INFRASTRUCTURE 360° VIEW (DONE 2026-10-20, workspace imported from github.com/daggerm29-oss/PLANP)
Request: 360° view of every dam / data centre / infrastructure site over Google photorealistic 3D tiles (God's Eye reference:
Three Gorges close-up in a circular lens, labelled blue stems for surrounding dams).
Built on the existing infra layer (`/api/proxy/infra/*` via `hooks/use-infrastructure.ts`, NO new fetches) + the AirportView pattern:
- `lib/infra-site.ts` — `InfraSite` (from any non-cable `InfraSelection`), `orbitFraming` (range by kind / MW / height),
  `nearbySites` (bbox-prefiltered, 30 km), `cablesNear`, DMS formatting.
- `components/InfraSiteView.tsx` — own Cesium viewer, `loadGoogleTileset` + Esri fallback, vision shader (Tactical night tint).
  Fly-in on Cesium World Terrain height, then exact surface from `sampleHeightMostDetailed` (focus marker re-seated).
  Continuous auto-orbit (`camera.lookAt` each preRender, 60 s per revolution × speed); drag/wheel hands control to the
  user and the orbit resumes from the user's camera after 3.5 s. Target ring + glow draped on tiles (ClassificationType.BOTH),
  nearby installations as stems + labels (click to hop, no viewer remount), nearby cables clamped to the tiles. Lens aperture overlay.
- `components/InfraSiteHud.tsx` — portal HUD: site intel card, heading tape, 360° sweep ring (% + revolutions), HDG/TILT/RNG,
  nearby list (distance + cardinal), controls (orbit pause, 0.5–4×, ORBIT/LOW/TOP/WIDE, zoom, LENS, EXIT).
  Keys: Space pause, 1–4 views, +/- zoom, ] next nearby, Esc exit.
- Entry points: "360° 3D VIEW" button in the infra selection card; double-click any dam / DC / landing on the map
  (`InfrastructureLayer` `onView360`). `WorldviewMap.tsx`: `infraSite` state, `enterInfraSite` (closes overlapping panels),
  `changeInfraSite`, `exitInfraSite` (reopens infra panel, map jumps to the site), toolbar infra button exits.
- Verified: Three Gorges Dam (OPT) — orbit locked on the dam crest over Google tiles, ground 158 m ELL, sweep advancing;
  hop to Gezhouba Dam (27 km E) re-targets in place. tsc clean (only pre-existing `components/ui/*`).
- Dev note: the v0 platform already runs `next dev` on :3000, so only Vite is started (`npm run dev --workspace=@workspace/worldview -- --port 5173`).

## Step 17 — LIVE SPACE MISSIONS + CINEMATIC LAUNCH REPLAY (IN PROGRESS, started 2026-10-21, repo github.com/daggerm29-oss/PLANQ)
Request: "God's Eye View" style space missions — list of live/upcoming/past launches, click -> cinematic replay:
close 360° view of the rocket lifting off the pad, camera follows like real launch footage (auto-switching shots,
movie transitions), climbs to space, then fully zooms out to show the trajectory + orbital path. Good rocket visual.
Better + more sci-fi than the reference (reference = Cesium camera fly-through over a precomputed ascent/orbit path).
Data: Launch Library 2 (`https://ll.thespacedevs.com/2.3.0/launches/{upcoming,previous}/?mode=detailed`), free tier
15 req/h -> server cache 30 min + in-flight dedupe + serve stale. Fields used: name, net, status, pad lat/lon/name,
rocket.configuration (full_name, length, diameter), mission (name, type, orbit.abbrev, description),
rocket.launcher_stage[] (serial, reused, flight no, landing.type ASDS/RTLS, downrange_distance, success), vid_urls, image.
Plan / files:
- `api-server/src/routes/launches.ts` — `GET /api/launches` (slim JSON, upcoming 25 + previous 25), mounted in vite.config.ts.
- `worldview/src/lib/launch-trajectory.ts` — pure math: orbit params from orbit abbrev (LEO/ISS/SSO/Polar/GTO/MEO...),
  launch azimuth from inclination + pad latitude, ascent profile (alt/downrange vs T), events (MAX-Q, MECO, stage sep,
  fairing, SECO), orbit ellipse (GTO apogee 35 786 km), booster return path to ASDS/RTLS.
- `worldview/src/lib/launch-director.ts` — the "movie": shot list (PAD 360, LIFTOFF LOW ANGLE, TRACKING LONG LENS,
  CHASE, ONBOARD DOWN, STAGE SEP, HIGH ALT, ORBIT WIDE) with playback-time -> mission-time warp + camera pose per shot.
- `worldview/src/components/LaunchReplayView.tsx` — Cesium viewer (Google tiles near pad, Esri globe), procedural rocket
  (body/interstage/nose/fins entities), exhaust plume particles, glowing ascent trail, orbit polyline, booster path, pad ring.
- `worldview/src/components/LaunchReplayHud.tsx` — portal HUD: letterbox, shot name, T+ clock, ALT/VEL/DOWNRANGE,
  event timeline, stage/recovery table, speed slider, pause/focus/prev/next/exit.
- `worldview/src/components/LaunchesPanel.tsx` + toolbar button + MapLibre pad markers.
Checklist:
- [x] 17a API route (`launches.ts`, mounted in routes/index.ts + vite.config.ts; LL2 verified reachable)
- [x] 17b `lib/launch-trajectory.ts` + `lib/launches.ts` (types, `useLaunches`, play modes live/replay/simulation)
- [x] 17c `lib/launch-director.ts` (shots, `sampleReplay`, `sampleLive`, `playbackForMissionTime`) + `lib/rocket-icon.ts`
- [x] 17d `components/LaunchReplayView.tsx` written (procedural rocket primitives w/ modelMatrix per frame in scene.preUpdate,
      plume cones + glow + ParticleSystem smoke/ground cloud, trails, orbit, booster, drone ship, free 360° cam, intro flyTo)
- [x] 17e `components/LaunchReplayHud.tsx` written (letterbox, cut flash, trackers, telemetry, recovery table, speed, timeline)
- NOT yet type-checked / browser-tested at this point.
- [x] 17f panel + toolbar + WorldviewMap wiring (found complete on resume 2026-10-21 from github.com/daggerm29-oss/PLANR:
      `LaunchesPanel`, `LaunchPadMarkers`, toolbar rocket button, `playLaunch`/`stepLaunch`/`exitLaunchReplay`, `LaunchReplayView` mount)
- [x] 17g tsc clean (fixed `sampleHeightMostDetailed` possibly-undefined result). Browser verified 2026-10-21 with
      live LL2 data (25 upcoming / 25 past, Ceres-1S LIVE NOW): Falcon 9 Bandwagon 5 replay -> CAM 01 PAD 360 + T-10 countdown,
      CAM 02 liftoff, CAM 03 1200 mm tracking (plume + glow trail), CAM 07 limb view at 194 km, booster telemetry
      (entry burn / touchdown on ASOG), CAM 11 orbit overview (globe, dashed orbit, pad / recovery / SECO labels). No page errors.
      Fixes during verify:
      * Tactical night shader made the pad unreadable -> launch film always uses daylight tiles (vision CSS filters still apply).
      * Globe hidden under Google tiles also hid the sky atmosphere (pad on black starfield) -> transparent WebGL canvas
        (`contextOptions.webgl.alpha`) over an altitude-faded CSS daylight sky (`skyGradient`, fades out by ~45 km), skybox off near ground.
      * Viewer now uses Cesium World Terrain (pad no longer sunk below the ellipsoid before tiles stream).
      * Frame dt cap 0.25 s -> 1 s so playback keeps real time on low-fps devices.
      * Tofu glyph buttons (pause/exit/restart/prev/next/webcast/replay) -> lucide-react icons; timeline labels decluttered.
      **Step 17 DONE.**
- Ideas not done: GLB rocket model option, fairing-halves separation animation, real webcast embed in the HUD.

## Step 19 — OPEN-WEB EVENT INGESTION (IN PROGRESS, resumed 2026-10-26 from github.com/daggerm29-oss/PLANX)
Request: pull GDELT (15-min news events), USGS quakes, NOTAMs (airspace closures), maritime safety warnings; geocode
onto the map; copilot summarises "In the last hour: airspace closed over X, tankers went dark near Y, strike in Z";
correlate NOTAMs with aircraft movements.
Files:
- `api-server/src/routes/events.ts` — `GET /api/events` (gdelt / usgs / notam=FAA TFR WFS / maritime=NGA MSI, per-source
  TTL cache, stale-while-revalidate) + `POST /api/events/brief` (Gemini brief over digest + client correlations). Mounted
  in routes/index.ts + vite.config.ts.
- `worldview/src/lib/events.ts` — types, `useWorldEvents`, `filterEvents`, `correlate` (aircraft inside TFR polygons,
  ships inside NAV warning zones), `summarizeDarkShips`, `requestBrief`.
- `components/EventsLayer.tsx` (MapLibre points + polygons), `components/EventsPanel.tsx` (filters, list, correlations, AI brief).
- `WorldviewMap.tsx` — state, toolbar button `WorldEventsIcon`, panel + layer mount, bridge `panels.events` + `events`.
Checklist:
- [x] 19a server route + mounting  - [x] 19b client lib  - [x] 19c layer + panel + WorldviewMap wiring
- [x] 19d copilot: `PanelId` += "events", bridge `state.events` + actions `flyToEvent` / `showEventBrief`;
      tools `query_events` (source/region/hours/query/severity/correlated_only, results carry live correlations) and
      `event_brief` (correlations + dark-ship clusters computed locally, one Gemini call server-side, brief mirrored into
      the panel; on quota/key error returns raw digest so the agent can still brief). Scene context gets `open_web_events`
      counts; agent SYSTEM prompt routes "last hour / sitrep" -> event_brief.
- [x] 19e tsc clean (only pre-existing `components/ui/*`). Live 2026-10-26: gdelt 141, notam 58, maritime 103, usgs 44;
      browser: panel + map markers, "13 aircraft in 7 TFRs", "30 ships in 8 warning zones", "50 AIS-dark vessels".
- [x] 19f live-tested with GEMINI_KEY: `/api/events/brief` 200 (gemini-3.5-flash); copilot "What happened in the last
      hour?" -> event_brief with NOTAM x aircraft + ship-zone + AIS-dark correlations; "Any airspace closures with aircraft
      inside?" -> query_events. Fix: agent loop now falls back to the tool's `say` when the model's final turn is empty
      (flash-lite returned "" -> "Done."). Note: Vite reads .env at config load — touch vite.config.ts after env changes.
STEP 19 COMPLETE.
- Ideas: GDELT lexicon is noisy ("border", "shot" corroborate non-conflict stories) — tighten; ICAO NOTAMs outside the US
  (FAA TFR covers US only) need a keyed source (e.g. FAA NOTAM API / Notamify).

## Step 20 — EVENT THUMBNAIL MARKERS + DETAIL CARD (DONE 2026-10-26, resumed from github.com/daggerm29-oss/PLANY)
Request: replace basic dots with real image thumbnail icons; clicking one shows its details.
- `EventsLayer.tsx` — each event is a `maplibregl.Marker` (round photo thumbnail sized by severity, accent ring per source,
  N/A/M/Q badge, pulse when correlated, enlarge on hover/selected). Polygons for TFR / NAV warning zones kept.
- `EventDetailCard.tsx` — dossier card pinned next to the marker (hero image, chips, title, place, severity, UTC time,
  summary, correlations, meta grid, ZOOM TO + READ ARTICLE / OPEN SOURCE), follows map moves, Esc closes.
- `lib/events.ts` `eventImage` (GDELT -> `/api/events/thumb?u=` og:image proxy) / `eventFallbackImage` (`public/events/*.jpg`).
- `api-server/src/routes/events.ts` `GET /api/events/thumb` (og:image fetch, cache, 6-way concurrency).
Fixes during verify:
- `.wev-marker { position: relative }` overrode MapLibre's absolute marker positioning -> markers stacked in document flow
  and drifted (US NOTAMs over Africa). Removed.
- Detail card could slide under the vision toolbar -> `TOP_SAFE = 52px` clamp.
- v0 import: removed scaffold `pnpm-workspace.yaml`/`pnpm-lock.yaml`/`postcss.config.mjs`/`components.json`/`lib/utils.ts`
  (repo uses npm workspaces; `npm install` at root).
- Ideas: declutter/cluster overlapping thumbnails at low zoom; server-side resize of large og:images (some ~400 KB).

## Step 21 — SIGNALS & RF LAYER (IN PROGRESS, resumed 2026-10-26 from github.com/daggerm29-oss/PLANZ)
Request: (1) LiveATC audio geolocated to the airport in view + Gemini transcription flagging "emergency", "7700",
"mayday", "diversion"...; (2) ADS-B emergency squawks 7500/7600/7700 as instant global alerts; (3) GPS jamming map
(gpsjam.org daily H3 data); (4) lightning (Blitzortung) + weather radar (RainViewer) overlays.
API keys: only `GEMINI_KEY` (already set) for ATC transcription. adsb.lol / gpsjam / RainViewer / Blitzortung are keyless.
Files (found written by previous chat, wiring state verified on resume):
- `api-server/src/routes/signals.ts` (mounted in routes/index.ts + vite.config.ts)
- `worldview/src/lib/signals.ts`, `components/SignalsPanel.tsx` (SignalsWorkspace), `AtcConsole.tsx`, `SquawkMarkers.tsx`,
  `SignalAlertBanner.tsx`, `SignalsLayer.tsx`; toolbar `SignalsIcon`; WorldviewMap state/banner/markers mounted.
Checklist:
- [x] 21a server route + mounting  - [x] 21b client lib + panel/ATC/squawk/banner components + WorldviewMap wiring
- [x] 21c SignalsLayer is mounted inside `SignalsWorkspace` (panel owns layer toggles + polling hooks)
- [x] 21d tsc clean. Fixed on resume: `formatAlt` import clashed with local fn in WorldviewMap (now `formatSquawkAlt`);
      copilot bridge `panels` was missing `signals`. `npm install` needed for `h3-js` (api-server dep).
- [x] 21e live 2026-10-26: `/api/signals/gpsjam` 2026-10-24 (926 high / 935 med cells), `/radar` RainViewer frames,
      `/lightning` Blitzortung WS connected (260 strikes/15 min), `/squawks` 200 (adsb.lol: 0 active, verified direct).
      Browser: panel + jamming hexes + lightning + ATC console (nearest airport DNMM, feed buttons) render, no errors.
- [x] 21f Gemini key now synced to `.env.development.local`. vite.config.ts loads .env only at startup, so touching
      the config (Vite auto-restart) picked it up. `/api/ai/status` -> configured:true; `/atc/transcribe` returns a
      valid result via gemini-flash-lite-latest (test tone clip -> empty transcript, as expected).
STEP 21 COMPLETE.

### Step 21g — ATC audio fix (2026-10-26)
Problem: user heard nothing. Root cause: console guessed mounts `<icao>_twr/gnd/app/...`; LiveATC's redirector 302s for
ANY name and most guesses 404 (EDDF/LFPG/EGLL have NO LiveATC feeds — ATC streaming restricted in DE/FR/UK).
LESSONS: (1) LiveATC rejects non-browser UAs (403). (2) LiveATC BANS IPs that open many streams — bursts of ~80
probes got the sandbox IP TLS-blocked at s1-bos.liveatc.net. NEVER scan/probe mounts from the server.
Fix:
- `lib/signals.ts`: `ATC_DIRECTORY` of verified mounts (KJFK, KATL, KSFO, RJTT) + `ATC_QUICK_PICKS`; browser plays
  `https://d.liveatc.net/<mount>` directly (listener's own IP). Add airports by hand from liveatc.net search.
- AtcConsole: no-coverage notice + quick-pick buttons; custom mount box kept; tab-share capture REMOVED.
- Server `POST /api/signals/atc/capture {mount,icao,feed,seconds}`: opens ONE stream per clip (max 3 concurrent),
  records ~25s, sends to Gemini, returns transcript+flags. Console loops clips while TRANSCRIBE is on.
- Not verifiable from sandbox (its IP is temporarily banned by LiveATC). Verify on user's browser / Vercel deploy.

## Next steps
- Space missions (Step 17) complete. In v0 the platform runs `next dev` on :3000; start Vite separately:
  `PORT=5173 BASE_PATH=/ npm run dev --workspace=@workspace/worldview -- --port 5173` (Next rewrites everything to it).
- Live-test ship (dblclick a dark-fleet dot) and satellite (3D ORBITAL, SATS) cinematic views; tune `KIND_CONFIG` in `CinematicTracker.tsx` (scale/range per kind).
- Aircraft wingtip/strobe lights use fixed metre offsets and look too wide vs the min-pixel-sized model; scale them or drop them.
- Exiting 3D currently also deselects the aircraft (legacy behaviour); ships/satellites keep their panel open.
- Remaining pre-existing TS errors are only in `src/components/ui/*` (React type version mismatch).

## Design for steps 4–5

New / changed files:
- `src/lib/tracked-entity.ts` — `EntityRef = {kind:"aircraft"|"ship"|"satellite", id}`, `FollowTarget`
  (lat, lon, altM, headingDeg, speedMs), model-URL/scale picker per entity.
- `src/components/EntityInfoPanel.tsx` — right-side panel (top-right, zIndex 30) with live name / position /
  movement / intel fields + "TRACK 3D" / "EXIT 3D" button. Stays visible during tracking.
- `src/components/CinematicTracker.tsx` — generic Cesium follow-cam (replaces aircraft-only CesiumFollowCam usage):
  camera.lookAt each frame with own drag/wheel orbit, dead-reckoning between samples (heading+speed),
  intro zoom-in + fade, exit zoom-out + fade then `onExited`. Trail polyline behind the model.
- `ShipsLayer.tsx` — `onSelect(ship)` on click, `onTrack(ship)` on dblclick.
- `SatelliteLayer.tsx` — `onSelect` + `onTrack` (dblclick) via the projected hit test.
- `WorldviewMap.tsx` — `selectedEntity` + `trackedEntity` state.

Models: `aeroplane.glb` (civil), `military-aircraft.glb` (mil — old code pointed at a missing `jet.glb`),
`ship.glb`, `tanker.glb` (TANKER), `satellite.glb`, `iss.glb` (ISS/ZARYA). All ~1.9 units long on X →
same `heading - 90°` orientation; scale per kind.

