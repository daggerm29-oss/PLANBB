/**
 * Zero-cost command parser. Unambiguous console commands are mapped straight to tool calls so they never
 * spend a model request. Anything with a question, a filter, or more than one clause goes to the model.
 */

export interface LocalCall {
  name: string;
  args: Record<string, unknown>;
}

const VISION: [RegExp, string][] = [
  [/\b(night ?vision|nvg)\b/, "nvg"],
  [/\b(flir|thermal|infra ?red)\b/, "flir"],
  [/\b(crt|retro)\b/, "crt"],
  [/\banime\b/, "anime"],
  [/\bnoir\b/, "noir"],
  [/\bsnow\b/, "snow"],
  [/\b(tactical|default)\b/, "tactical"],
  [/\b(optical|normal)\b/, "normal"],
  [/\bsatellite (mode|recon|view)\b/, "satellite"],
];

const PANELS: [RegExp, string][] = [
  [/\b(aviation|aircraft|flights?|planes?)\b/, "aviation"],
  [/\b(maritime|ships?|vessels?)\b/, "maritime"],
  [/\b(cctv|cameras?)\b/, "cctv"],
  [/\b(traffic)\b/, "traffic"],
  [/\b(infrastructure|cables?|data ?cent(er|re)s?|dams?)\b/, "infrastructure"],
  [/\b(space|launch(es)?|rockets?)\b/, "space"],
  [/\b(satellites?|orbital)\b/, "satellites"],
  [/\bplayback\b/, "playback"],
  [/\b(signals?|rf|gps jam(ming)?|jamming|lightning|weather radar|atc|squawks?)\b/, "signals"],
];

// Words that mean "this needs reasoning" — never short-circuit these.
const NEEDS_MODEL = /\b(how|what|which|why|where|when|who|is there|are there|any|count|biggest|largest|nearest|closest|near|between|route|walk|drive|distance|outline|annotate|draw|track|follow|cockpit|and then|then)\b|\?/;

// A bare place name: no second clause, no follow-up verb. Anything else must reach the model,
// otherwise the whole phrase ("ethiopia and highlight it") gets geocoded as a place.
const EXTRA_CLAUSE = /\b(and|then|also|plus|with|highlight|show|mark|zoom|open|close|enable|turn|switch|fly|go)\b|[,;&+]/;
function isPlainPlace(p: string) {
  return p.length > 0 && p.split(" ").length <= 6 && !NEEDS_MODEL.test(p) && !EXTRA_CLAUSE.test(p);
}

const ROUTE_MODES: Record<string, string> = {
  walking: "walking", walk: "walking", foot: "walking", pedestrian: "walking",
  driving: "driving", drive: "driving", car: "driving",
  cycling: "cycling", bike: "cycling", biking: "cycling", bicycle: "cycling",
};

const FLY_ROUTE = /^(?:now\s+)?(?:fly|follow|animate|play|run)\s+(?:along\s+)?(?:(?:the|that|this|my)\s+)?(?:route|path|it)$/;

// "draw the walking route from the Capitol to Zilker Park" (optionally "... then fly the route").
const DRAW_ROUTE = /^(?:draw|show|plot|get|map|give)(?:\s+me)?\s+(?:(?:the|a|an)\s+)?(?:(walking|walk|foot|pedestrian|driving|drive|car|cycling|bike|biking|bicycle)\s+)?(?:route|path|directions|way)\s+from\s+(.+?)\s+to\s+(.+?)(?:\s*(?:,|;|\band\b|\bthen\b)\s*(?:then\s+)?(fly|follow|animate|play)\s+(?:along\s+)?(?:it|(?:the|that)\s+(?:route|path)))?$/;

function stripArticle(p: string) {
  return p.replace(/^(?:the)\s+/, "").trim();
}

export function parseLocalIntent(raw: string): LocalCall[] | null {
  // Users paste commands wrapped in quotes: “Draw ... Zilker Park” then “Fly the route”.
  const t = raw.replace(/[“”"‘’]/g, "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!t) return null;

  if (FLY_ROUTE.test(t)) return [{ name: "fly_route", args: {} }];

  const route = DRAW_ROUTE.exec(t);
  if (route && t.length <= 160) {
    const [, modeWord, fromRaw, toRaw, flyAfter] = route;
    const from = stripArticle(fromRaw), to = stripArticle(toRaw);
    // Waypoints or extra clauses need the model.
    if (from && to && !/\b(via|through|and|then|avoid)\b|[,;]/.test(`${from} ${to}`)) {
      const calls: LocalCall[] = [{ name: "draw_route", args: { from, to, mode: modeWord ? ROUTE_MODES[modeWord] : "driving" } }];
      if (flyAfter) calls.push({ name: "fly_route", args: {} });
      return calls;
    }
  }

  if (t.length > 80) return null;

  if (/^(stop|halt|freeze|cancel)( (the )?(camera|orbit|animation|it))?$/.test(t)) return [{ name: "stop_camera", args: {} }];
  if (/^(exit|leave|back|go back|return)( to (the )?map)?$|^exit (the )?(view|cockpit|tracking|3d)$/.test(t)) return [{ name: "exit_view", args: {} }];
  if (/^(zoom (all the way )?out( to (the )?(globe|world))?|(show )?(the )?(whole )?(globe|world)( view)?|globe view)$/.test(t)) return [{ name: "zoom_out_globe", args: {} }];
  if (/^zoom in$/.test(t)) return [{ name: "set_camera", args: { zoom_delta: 2 } }];
  if (/^(orbit|circle|spin)( around)?( (this|the) (area|place|spot|city))?$/.test(t)) return [{ name: "orbit", args: {} }];
  if (/^(clear|remove|erase) (all )?(the )?(annotations|drawings|pins|overlays|map)$/.test(t)) return [{ name: "clear_annotations", args: {} }];
  if (/^(switch to |go to )?(2d|flat map|map view)$/.test(t)) return [{ name: "set_camera", args: { view_mode: "2d" } }];
  if (/^(switch to |go to )?(3d|globe)( (mode|view))?$/.test(t)) return [{ name: "set_camera", args: { view_mode: "3d" } }];

  // annotate_place already flies to the place, so "go to X and highlight it" is a single local call.
  const flyHighlight = /^(?:take me to|fly (?:me )?to|go to|navigate to|jump to|head to|show me)\s+(.+?)\s*(?:,|and)\s*(?:then\s+)?(?:highlight|outline|mark)(?: it| that| the (?:border|area|country|region))?$/.exec(t);
  if (flyHighlight && isPlainPlace(flyHighlight[1])) return [{ name: "annotate_place", args: { place: flyHighlight[1] } }];

  const highlight = /^(?:highlight|outline|mark)\s+(.+)$/.exec(t);
  if (highlight && isPlainPlace(highlight[1])) return [{ name: "annotate_place", args: { place: highlight[1] } }];

  const fly = /^(?:take me to|fly (?:me )?to|go to|navigate to|jump to|head to)\s+(.+)$/.exec(t);
  if (fly && isPlainPlace(fly[1])) return [{ name: "fly_to", args: { place: fly[1] } }];

  const vis = /^(?:switch to |turn on |enable |go |use |activate )?(.+?)(?: mode| vision| view| filter)?$/.exec(t);
  if (vis && vis[1].split(" ").length <= 3 && !NEEDS_MODEL.test(t)) {
    for (const [re, mode] of VISION) if (re.test(vis[1]) && !/\b(show|open|layer|panel)\b/.test(t)) return [{ name: "set_vision_mode", args: { mode } }];
  }

  const panel = /^(open|show|enable|turn on|close|hide|disable|turn off)\s+(?:the\s+)?(.+?)(?:\s+(?:panel|layer|intel|feed|network))?$/.exec(t);
  if (panel && !NEEDS_MODEL.test(panel[2]) && panel[2].split(" ").length <= 3) {
    const open = /^(open|show|enable|turn on)$/.test(panel[1]);
    for (const [re, id] of PANELS) if (re.test(panel[2])) return [{ name: "toggle_panel", args: { panel: id, open } }];
  }
  return null;
}
