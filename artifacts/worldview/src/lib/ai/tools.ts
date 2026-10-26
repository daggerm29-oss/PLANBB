/**
 * Tool declarations sent to the model (JSON-schema subset accepted by both Gemini functionDeclarations
 * and OpenAI Responses tools). Kept terse: they ride along with every request.
 *
 * ACTION tools only change the console; their result is a short confirmation, so when a round contains only
 * action tools the agent finishes locally without a second model call (see agent.ts).
 */

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });

const REGION = str('Place name ("Texas", "Los Angeles", "Strait of Hormuz") or "view" for the current viewport. Omit for worldwide.');
const RADIUS = num("Optional radius in km around the place instead of its boundary.");
const POINT = str('Place name or "lat,lon".');
const ENTITY_KIND = str("Entity kind.", { enum: ["aircraft", "ship", "satellite"] });

export const TOOL_DECLS: ToolDecl[] = [
  // ── DIRECT IT (camera) ──
  { name: "fly_to", description: "Fly the camera to a place or coordinate.", parameters: obj({ place: str("Place name."), lat: num("Latitude."), lon: num("Longitude."), zoom: num("0-19. City≈11, street≈16, country≈5."), pitch: num("0-85 degrees tilt."), bearing: num("Compass bearing.") }) },
  { name: "set_camera", description: "Adjust the camera in place or switch 2D map / 3D globe.", parameters: obj({ zoom: num("Zoom level."), zoom_delta: num("Relative zoom change, e.g. -2 to zoom out."), pitch: num("Tilt."), bearing: num("Bearing."), view_mode: str("2d or 3d globe.", { enum: ["2d", "3d"] }) }) },
  { name: "zoom_out_globe", description: "Zoom all the way out to a full 3D globe view.", parameters: obj({}) },
  { name: "orbit", description: "Cinematic orbit around a place (or the current centre).", parameters: obj({ place: str("Optional place to orbit."), duration_sec: num("Default 40."), speed_deg_per_sec: num("Default 12."), zoom: num("Optional zoom.") }) },
  { name: "stop_camera", description: "Stop any orbit / route flight animation.", parameters: obj({}) },
  { name: "frame_results", description: "Fit the camera to the entities returned by the last query (e.g. after 'show me the planes overhead').", parameters: obj({ pitch: num("Optional tilt.") }) },
  { name: "track_entity", description: "Lock the cinematic 3D follow camera onto an aircraft, ship or satellite. Omit id/query to track the currently selected entity.", parameters: obj({ kind: ENTITY_KIND, id: str("hex / MMSI / NORAD id."), query: str("Callsign, registration, vessel or satellite name."), cockpit: bool("Aircraft only: enter cockpit view.") }) },
  { name: "select_entity", description: "Select an entity (opens its info panel and flies to it).", parameters: obj({ kind: ENTITY_KIND, id: str("hex / MMSI / NORAD id."), query: str("Callsign / name.") }, ["kind"]) },
  { name: "exit_view", description: "Exit tracking / cockpit / airport / infrastructure 360 / launch replay and return to the map.", parameters: obj({}) },
  { name: "fly_route", description: "Cinematic drone flight along a drawn route (default: the last one) over photorealistic 3D buildings. Use for 'fly the route', 'follow it', 'drone shot of the route'.", parameters: obj({ id: str("Annotation id."), duration_sec: num("Optional duration.") }) },

  // ── OPERATE IT (UI) ──
  { name: "set_vision_mode", description: "Switch the sensor / visual style.", parameters: obj({ mode: str("Vision mode.", { enum: ["tactical", "normal", "crt", "nvg", "flir", "anime", "noir", "snow", "satellite"] }), flir_palette: str("FLIR palette.", { enum: ["whot", "bhot", "iron"] }) }, ["mode"]) },
  { name: "toggle_panel", description: "Open or close a console panel/layer (also shows/hides its map layer).", parameters: obj({ panel: str("Panel.", { enum: ["aviation", "maritime", "airport", "traffic", "infrastructure", "space", "cctv", "playback", "events", "signals", "satellites"] }), open: bool("true=open") }, ["panel", "open"]) },
  { name: "set_aircraft_feed", description: "Switch the ADS-B feed between civil and military aircraft, global or local.", parameters: obj({ mode: str("Feed.", { enum: ["civil", "military"] }), area: str("Area.", { enum: ["global", "local"] }) }) },
  { name: "set_infrastructure_layer", description: "Toggle an infrastructure sub-layer.", parameters: obj({ layer: str("Layer.", { enum: ["cables", "landings", "datacenters", "dams"] }), on: bool("Visible.") }, ["layer", "on"]) },
  { name: "set_cctv_coverage", description: "Show CCTV camera coverage cones or occluded viewsheds.", parameters: obj({ mode: str("Mode.", { enum: ["off", "cone", "viewshed"] }) }, ["mode"]) },
  { name: "open_airport_view", description: "Open the live photorealistic 3D airport view.", parameters: obj({ query: str('Airport name, city, IATA or ICAO, or "here" for the map centre.') }, ["query"]) },
  { name: "open_infrastructure_360", description: "Open the 360° orbit view of a data centre, dam or cable landing.", parameters: obj({ kind: str("Kind.", { enum: ["datacenter", "dam", "landing"] }), name: str("Name contains."), near: str("Or nearest to this place.") }, ["kind"]) },
  { name: "play_launch", description: "Play the cinematic space-launch replay.", parameters: obj({ which: str("List.", { enum: ["upcoming", "previous"] }), query: str("Mission / rocket name contains. Omit for the most recent.") }) },

  // ── ANNOTATE IT ──
  { name: "annotate_place", description: "Geocode a place and annotate it: outline its boundary (states, countries, parks, buildings) and/or drop a labelled pin.", parameters: obj({ place: str("Place / landmark."), label: str("Optional label."), outline: bool("Draw the boundary polygon if available (default true)."), color: str("CSS colour.") }, ["place"]) },
  { name: "draw_pin", description: "Drop a labelled pin at a coordinate.", parameters: obj({ lat: num("Lat."), lon: num("Lon."), label: str("Label."), color: str("CSS colour.") }, ["lat", "lon", "label"]) },
  { name: "draw_route", description: "Draw a real road/foot/bike route (or straight line) between places on photorealistic 3D tiles (2D map beyond 500 km) and report distance + duration.", parameters: obj({ from: POINT, to: POINT, via: { type: "array", items: { type: "string" }, description: "Optional waypoints." }, mode: str("Travel mode.", { enum: ["walking", "driving", "cycling", "straight"] }), label: str("Label.") }, ["from", "to"]) },
  { name: "measure_distance", description: "Measure the great-circle distance between two places and draw it.", parameters: obj({ from: POINT, to: POINT }, ["from", "to"]) },
  { name: "draw_circle", description: "Draw a radius ring around a place.", parameters: obj({ center: POINT, radius_km: num("Radius km."), label: str("Label.") }, ["center", "radius_km"]) },
  { name: "draw_polygon", description: "Draw a polygon from coordinates.", parameters: obj({ points: { type: "array", items: obj({ lat: num("Lat."), lon: num("Lon.") }, ["lat", "lon"]), description: "≥3 vertices." }, label: str("Label."), color: str("CSS colour.") }, ["points"]) },
  { name: "clear_annotations", description: "Remove one annotation by id, or all.", parameters: obj({ id: str("Annotation id; omit to clear all.") }) },

  // ── INTERROGATE IT (live analytics; computed locally on live data) ──
  { name: "query_aircraft", description: "Count / list live aircraft (ADS-B) with filters. Use for 'how many flights over X', 'anything above 40,000 ft', 'planes overhead'.", parameters: obj({ region: REGION, radius_km: RADIUS, min_alt_ft: num("Min altitude ft."), max_alt_ft: num("Max altitude ft."), callsign: str("Callsign / reg / hex contains."), type: str("ICAO type contains, e.g. B77, A38, C17."), military: bool("Only military (switches feed)."), sort_by: str("Sort.", { enum: ["altitude", "speed", "distance"] }), limit: num("Rows to return (default 8).") }) },
  { name: "query_ships", description: "Count / list live vessels (AIS + dark fleet) with filters, e.g. 'ships headed to Oakland'.", parameters: obj({ region: REGION, radius_km: RADIUS, destination: str("Destination contains."), name: str("Vessel name / MMSI contains."), category: str("TANKER, MILITARY, …"), dark_only: bool("Only AIS-dark / gap candidates."), min_speed_kn: num("Min speed."), limit: num("Rows (default 8).") }) },
  { name: "query_satellites", description: "Search tracked satellites (enables the orbital layer).", parameters: obj({ name: str("Name contains, e.g. ISS, STARLINK."), region: REGION, radius_km: RADIUS, limit: num("Rows.") }) },
  { name: "query_infrastructure", description: "Search data centres, dams, cable landings, submarine cables.", parameters: obj({ kind: str("Kind.", { enum: ["datacenters", "dams", "landings", "cables"] }), region: REGION, radius_km: RADIUS, name: str("Name / operator contains."), limit: num("Rows.") }, ["kind"]) },
  { name: "query_hazards", description: "Live natural hazards: wildfires, earthquakes, severe storms, volcanoes (NASA EONET / USGS). Optionally plot them.", parameters: obj({ kind: str("Kind.", { enum: ["fires", "earthquakes", "storms", "volcanoes"] }), region: REGION, radius_km: RADIUS, sort_by: str("Sort.", { enum: ["magnitude", "recent", "distance"] }), limit: num("Rows."), plot: bool("Drop pins for results (default true).") }, ["kind"]) },
  { name: "query_events", description: "Open-web events geocoded on the map: GDELT news events (strikes, clashes, protests, military posture), FAA airspace NOTAMs/TFRs, NGA maritime safety warnings, USGS earthquakes. Each result includes live correlations (aircraft currently inside a restricted airspace, ships inside a warning zone). Use for 'any airspace closures near X', 'news reports of strikes in Y', 'maritime warnings in the Red Sea'.", parameters: obj({ source: str("Source.", { enum: ["all", "news", "notam", "maritime", "earthquake"] }), region: REGION, radius_km: RADIUS, hours: num("Report window in hours for news/quakes (default 1; NOTAMs and NAV warnings are always the active ones)."), query: str("Title / place / actor contains."), min_severity: num("1-5 (default 1)."), correlated_only: bool("Only events with live aircraft/ships inside."), limit: num("Rows (default 8)."), plot: bool("Fly to the first result and highlight it (default true when 1 result).") }) },
  { name: "event_brief", description: "Analyst situation brief: 'what happened in the last hour', 'sitrep', 'brief me'. Summarises news events, airspace closures, maritime warnings, quakes, AIS-dark ship clusters and NOTAM x aircraft correlations. Return its text to the user verbatim (it is already written).", parameters: obj({ hours: num("Window hours (default 1).") }) },
  { name: "query_launches", description: "List upcoming or recent orbital launches.", parameters: obj({ which: str("List.", { enum: ["upcoming", "previous"] }), query: str("Name / provider contains."), limit: num("Rows.") }) },
  { name: "query_cctv", description: "Find public CCTV cameras near a place.", parameters: obj({ region: REGION, radius_km: RADIUS, limit: num("Rows.") }) },
  { name: "inspect_selected", description: "Full live telemetry/metadata of the currently selected or tracked entity ('what's this?').", parameters: obj({}) },
  { name: "describe_view", description: "Reverse-geocode the camera centre (street / city / country) and summarise what is visible.", parameters: obj({}) },
  { name: "capture_view", description: "Take a screenshot of the current view so you can visually identify signs, buildings, terrain. Only describe what is actually legible.", parameters: obj({}) },
];

export const ACTION_TOOLS = new Set([
  "fly_to", "set_camera", "zoom_out_globe", "orbit", "stop_camera", "frame_results", "track_entity", "select_entity", "exit_view", "fly_route",
  "set_vision_mode", "toggle_panel", "set_aircraft_feed", "set_infrastructure_layer", "set_cctv_coverage", "open_airport_view",
  "open_infrastructure_360", "play_launch", "draw_pin", "draw_polygon", "draw_circle", "clear_annotations", "annotate_place",
  "draw_route", "measure_distance",
]);
