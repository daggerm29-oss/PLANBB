import { useEffect, useMemo, useState } from "react";
import {
  bearingTo,
  compassPoint,
  deadReckon,
  distanceM,
  formatDistance,
  formatLatLon,
  M_TO_FT,
  MS_TO_KTS,
  type CockpitContext,
  type CockpitTelemetry,
} from "../lib/cockpit";
import { VISION_MODES, type VisionMode } from "../lib/vision-modes";
import { COCKPIT_CSS } from "./cockpit-hud-css";

interface FlightInfo {
  aircraft: { type?: string; manufacturer?: string; registration?: string; owner?: string } | null;
  route: {
    airline: string | null;
    origin: { name?: string; iata?: string; icao?: string; city?: string } | null;
    destination: { name?: string; iata?: string; icao?: string; city?: string } | null;
  } | null;
}

interface Props {
  hex: string;
  callsign?: string;
  registration?: string;
  typeCode?: string;
  squawk?: string;
  military?: boolean;
  apiBase: string;
  visionMode: VisionMode;
  getTelemetry: () => CockpitTelemetry | null;
  getContext?: () => CockpitContext | null;
  onReset: () => void;
  onExitCockpit: () => void;
}

const COHORT_RADIUS_M = 100_000;

function pad(n: number, w: number) {
  return String(Math.max(0, Math.round(n))).padStart(w, "0");
}

function zuluClock(d: Date) {
  return `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}Z`;
}

function HeadingTape({ heading }: { heading: number }) {
  const pxPerDeg = 6;
  const ticks: { deg: number; x: number }[] = [];
  const start = Math.floor((heading - 35) / 5) * 5;
  for (let d = start; d <= heading + 35; d += 5) ticks.push({ deg: ((d % 360) + 360) % 360, x: (d - heading) * pxPerDeg });
  return (
    <div className="wvc-tape" aria-hidden="true">
      {ticks.map((t) => (
        <div key={`${t.deg}:${Math.round(t.x)}`} className="wvc-tape-tick" style={{ transform: `translateX(${t.x}px)` }}>
          <span className={t.deg % 10 === 0 ? "wvc-tape-line wvc-tape-line-major" : "wvc-tape-line"} />
          {t.deg % 30 === 0 && (
            <span className="wvc-tape-label">{t.deg % 90 === 0 ? compassPoint(t.deg) : pad(t.deg / 10, 2)}</span>
          )}
        </div>
      ))}
      <div className="wvc-tape-caret" />
    </div>
  );
}

function PitchLadder({ t }: { t: CockpitTelemetry }) {
  if (Math.abs(t.lookYawDeg) > 35) return null;
  const h = window.innerHeight;
  const aspect = window.innerWidth / h;
  const fov = (t.fovDeg * Math.PI) / 180;
  // Cesium's fov is horizontal when the viewport is wider than tall.
  const vHalf = aspect > 1 ? Math.atan(Math.tan(fov / 2) / aspect) : fov / 2;
  const camPitch = t.pitchDeg + t.lookPitchDeg;
  const yFor = (a: number) => ((h / 2) * Math.tan(((camPitch - a) * Math.PI) / 180)) / Math.tan(vHalf);
  const rungs = [-30, -20, -10, -5, 0, 5, 10, 20, 30];
  return (
    <div className="wvc-ladder" style={{ transform: `rotate(${-t.rollDeg}deg)` }} aria-hidden="true">
      {rungs.map((a) => {
        const y = yFor(a);
        if (Math.abs(y) > h * 0.34) return null;
        const cls = a === 0 ? "wvc-rung wvc-rung-horizon" : a < 0 ? "wvc-rung wvc-rung-neg" : "wvc-rung";
        return (
          <div key={a} className={cls} style={{ transform: `translateY(${y}px)` }}>
            {a !== 0 && <span className="wvc-rung-label wvc-rung-label-l">{Math.abs(a)}</span>}
            {a !== 0 && <span className="wvc-rung-label wvc-rung-label-r">{Math.abs(a)}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Row({ k, v, alert }: { k: string; v: string; alert?: boolean }) {
  return (
    <div className="wvc-row">
      <dt>{k}</dt>
      <dd className={alert ? "wvc-alert" : undefined}>{v}</dd>
    </div>
  );
}

/** First-person HUD over the cockpit camera. Portaled outside the vision filter so it stays crisp. */
export function CockpitHud(props: Props) {
  const { hex, callsign, registration, typeCode, squawk, military, apiBase, visionMode, getTelemetry, getContext, onReset, onExitCockpit } = props;
  const [tel, setTel] = useState<CockpitTelemetry | null>(() => getTelemetry());
  const [ctx, setCtx] = useState<CockpitContext | null>(() => getContext?.() ?? null);
  const [now, setNow] = useState(() => new Date());
  const [info, setInfo] = useState<FlightInfo | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 66) {
        last = ts;
        setTel(getTelemetry());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const slow = window.setInterval(() => {
      setCtx(getContext?.() ?? null);
      setNow(new Date());
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(slow);
    };
  }, [getTelemetry, getContext]);

  const cleanCallsign = (callsign ?? "").trim().toUpperCase();
  useEffect(() => {
    const params = new URLSearchParams();
    if (/^[0-9a-f]{6}$/i.test(hex)) params.set("hex", hex.toLowerCase());
    if (/^[A-Z0-9]{2,8}$/.test(cleanCallsign)) params.set("callsign", cleanCallsign);
    if (!params.toString()) return;
    const ac = new AbortController();
    fetch(`${apiBase}/api/proxy/adsb/info?${params}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FlightInfo | null) => setInfo(d ?? { aircraft: null, route: null }))
      .catch(() => {});
    return () => ac.abort();
  }, [apiBase, hex, cleanCallsign]);

  // Recomputed on the 1 s context tick, not on every telemetry frame.
  const telRef = tel;
  const surroundings = useMemo(() => {
    if (!telRef || !ctx) return null;
    const age = (Date.now() - ctx.aircraftSampleMs) / 1000;
    let nearest: { callsign: string; d: number; brg: number; dAlt: number; military: boolean; type?: string } | null = null;
    let aircraftCount = 0;
    let milCount = 0;
    for (const c of ctx.aircraft) {
      if (c.hex === hex) continue;
      const p = deadReckon(c, age);
      const d = distanceM(telRef.lat, telRef.lon, p.lat, p.lon);
      if (d > COHORT_RADIUS_M) continue;
      aircraftCount++;
      if (c.military) milCount++;
      if (!nearest || d < nearest.d) {
        nearest = {
          callsign: c.callsign || c.hex.toUpperCase(),
          d,
          brg: bearingTo(telRef.lat, telRef.lon, p.lat, p.lon),
          dAlt: c.altM - telRef.altM,
          military: c.military,
          type: c.typeCode,
        };
      }
    }
    let vessels = 0;
    for (const s of ctx.ships) if (distanceM(telRef.lat, telRef.lon, s.lat, s.lon) <= COHORT_RADIUS_M) vessels++;
    return { nearest, aircraftCount, milCount, vessels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, hex]);

  const vision = VISION_MODES.find((m) => m.id === visionMode);
  const gsKts = tel ? tel.speedMs * MS_TO_KTS : 0;
  const altFt = tel ? tel.altM * M_TO_FT : 0;
  const vsFpm = tel ? tel.verticalRateMs * M_TO_FT * 60 : 0;
  const hdg = tel ? tel.headingDeg : 0;
  const viewHdg = tel ? (((tel.headingDeg + tel.lookYawDeg) % 360) + 360) % 360 : 0;
  const origin = info?.route?.origin;
  const dest = info?.route?.destination;
  const label = cleanCallsign || registration || hex.toUpperCase();
  const emergency = squawk === "7700" || squawk === "7600" || squawk === "7500";

  return (
    <div className="wvc-root" role="region" aria-label={`Cockpit view for ${label}`}>
      <style>{COCKPIT_CSS}</style>
      <div className="wvc-visor" aria-hidden="true">
        <div className="wvc-visor-ring" />
        <div className="wvc-visor-ring wvc-visor-ring-inner" />
      </div>
      <div className="wvc-frame" aria-hidden="true" />

      <header className="wvc-top">
        <div>
          <p className="wvc-kicker">
            <span className="wvc-dot" /> FIRST PERSON · {military ? "MILITARY FLIGHT" : "CIVIL FLIGHT"}
          </p>
          <h2 className="wvc-callsign">{label}</h2>
          <p className="wvc-sub">LIVE TRACK · COURSE ALIGNED</p>
        </div>
        <div className="wvc-top-center">
          <span className="wvc-chip">VISION</span>
          <span className="wvc-chip wvc-chip-active">{vision?.short ?? visionMode.toUpperCase()}</span>
          <span className="wvc-chip">{tel && Math.abs(tel.lookYawDeg) > 2 ? `LOOK ${pad(viewHdg, 3)}°` : "BORESIGHT"}</span>
        </div>
        <div className="wvc-top-right">
          <p className="wvc-clock">{zuluClock(now)}</p>
          <p className="wvc-sub">{tel ? formatLatLon(tel.lat, tel.lon) : "--"}</p>
        </div>
      </header>

      <div className="wvc-tape-wrap">
        <HeadingTape heading={viewHdg} />
        <span className="wvc-tape-readout">{pad(viewHdg, 3)}°</span>
      </div>

      {tel && <PitchLadder t={tel} />}

      <svg className="wvc-reticle" viewBox="-60 -30 120 60" aria-hidden="true">
        <circle cx="0" cy="0" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="-30" y1="0" x2="-8" y2="0" stroke="currentColor" strokeWidth="1.5" />
        <line x1="8" y1="0" x2="30" y2="0" stroke="currentColor" strokeWidth="1.5" />
        <line x1="0" y1="-8" x2="0" y2="-16" stroke="currentColor" strokeWidth="1.5" />
        <path d="M-56 -4 L-48 0 L-56 4 M56 -4 L48 0 L56 4" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      </svg>

      <aside className="wvc-panel wvc-panel-left" aria-label="Ownship data">
        <p className="wvc-panel-title">OWNSHIP</p>
        <dl>
          <Row k="TYPE" v={info?.aircraft?.type ?? typeCode ?? "—"} />
          <Row k="REG" v={info?.aircraft?.registration ?? registration ?? "—"} />
          <Row k="ICAO HEX" v={hex.toUpperCase()} />
          <Row k="SQUAWK" v={squawk ?? "—"} alert={emergency} />
          <Row k="V/S" v={`${vsFpm >= 0 ? "+" : "−"}${pad(Math.abs(vsFpm), 4)} FPM`} />
          <Row k="BANK" v={tel ? `${tel.rollDeg >= 0 ? "R" : "L"} ${Math.abs(tel.rollDeg).toFixed(0)}°` : "—"} />
          <Row k="FOV" v={tel ? `${tel.fovDeg.toFixed(0)}°` : "—"} />
        </dl>
        {info?.aircraft?.owner && <p className="wvc-note">{info.aircraft.owner}</p>}
      </aside>

      <aside className="wvc-panel wvc-panel-right" aria-label="Nearby contacts and flight plan">
        <p className="wvc-panel-title">CONTACT · NEAREST</p>
        {surroundings?.nearest ? (
          <>
            <p className={surroundings.nearest.military ? "wvc-contact wvc-mil" : "wvc-contact"}>
              {surroundings.nearest.callsign}
              {surroundings.nearest.type ? <span className="wvc-sub"> {surroundings.nearest.type}</span> : null}
            </p>
            <dl>
              <Row k="BRG / DIST" v={`${pad(surroundings.nearest.brg, 3)}° · ${formatDistance(surroundings.nearest.d)}`} />
              <Row
                k="Δ ALT"
                v={`${surroundings.nearest.dAlt >= 0 ? "+" : "−"}${Math.round(Math.abs(surroundings.nearest.dAlt * M_TO_FT)).toLocaleString()} FT`}
              />
            </dl>
          </>
        ) : (
          <p className="wvc-note">No traffic within 54 NM</p>
        )}
        <div className="wvc-cohort">
          <div>
            <span className="wvc-big">{surroundings?.aircraftCount ?? 0}</span>
            <span className="wvc-sub">AIRCRAFT</span>
          </div>
          <div>
            <span className="wvc-big wvc-mil">{surroundings?.milCount ?? 0}</span>
            <span className="wvc-sub">MILITARY</span>
          </div>
          <div>
            <span className="wvc-big">{surroundings?.vessels ?? 0}</span>
            <span className="wvc-sub">AIS</span>
          </div>
        </div>
        <p className="wvc-sub">WITHIN 54 NM · FEED {ctx ? zuluClock(new Date(ctx.aircraftSampleMs)) : "--"}</p>

        <p className="wvc-panel-title wvc-mt">ESTIMATED FLIGHT PLAN</p>
        {origin || dest ? (
          <div className="wvc-route">
            <div>
              <span className="wvc-big">{origin?.iata ?? origin?.icao ?? "???"}</span>
              <span className="wvc-sub">{origin?.city ?? origin?.name ?? "—"}</span>
            </div>
            <span className="wvc-route-arrow" aria-label="to">
              {"→"}
            </span>
            <div>
              <span className="wvc-big">{dest?.iata ?? dest?.icao ?? "???"}</span>
              <span className="wvc-sub">{dest?.city ?? dest?.name ?? "—"}</span>
            </div>
          </div>
        ) : (
          <p className="wvc-note">{info ? "No filed route for this callsign" : "Resolving route…"}</p>
        )}
        {info?.route?.airline && <p className="wvc-note">{info.route.airline}</p>}
      </aside>

      <div className="wvc-readouts">
        <div className="wvc-readout">
          <span className="wvc-sub">GROUND SPEED</span>
          <span className="wvc-num">{pad(gsKts, 3)}</span>
          <span className="wvc-sub">KTS</span>
        </div>
        <div className="wvc-readout wvc-readout-mid">
          <span className="wvc-sub">HDG</span>
          <span className="wvc-num wvc-num-sm">{pad(hdg, 3)}</span>
        </div>
        <div className="wvc-readout">
          <span className="wvc-sub">ALTITUDE</span>
          <span className="wvc-num">{Math.round(altFt).toLocaleString()}</span>
          <span className="wvc-sub">FT</span>
        </div>
      </div>

      <div className="wvc-actions">
        <button type="button" className="wvc-btn" onClick={onReset}>
          RESET VIEW
        </button>
        <button type="button" className="wvc-btn wvc-btn-exit" onClick={onExitCockpit}>
          EXIT COCKPIT
        </button>
      </div>
      <p className="wvc-help">C TOGGLE COCKPIT · DRAG LOOK AROUND · WHEEL / + − FOV · ESC EXIT 3D</p>
    </div>
  );
}
