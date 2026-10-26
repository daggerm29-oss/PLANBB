import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type maplibregl from "maplibre-gl";
import { Crosshair, ExternalLink, Plane, Ship as ShipIcon, X } from "lucide-react";
import { eventFallbackImage, eventImage, relativeAge, SOURCE_META, type Correlation, type WorldEvent } from "../lib/events";

const FONT = "'Share Tech Mono','Courier New',monospace";
const CARD_W = 320;
const GAP = 26;
// Keeps the card clear of the vision-mode toolbar pinned to the top of the map.
const TOP_SAFE = 52;

interface Props {
  map: maplibregl.Map;
  event: WorldEvent;
  correlation: Correlation | undefined;
  onClose: () => void;
  onFly: (e: WorldEvent) => void;
}

function metaRows(e: WorldEvent): [string, string][] {
  const skip = new Set(["mentions_raw", "url", "lat", "lon", "place"]);
  return Object.entries(e.meta)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== "" && v !== false && String(v).length <= 60)
    .slice(0, 6)
    .map(([k, v]) => [k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase(), v === true ? "YES" : String(v)]);
}

/** Floating dossier pinned to an event marker: article image, what/where/when, live correlations, source link. */
export function EventDetailCard({ map, event, correlation, onClose, onFly }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState(() => eventImage(event));
  const meta = SOURCE_META[event.source];

  useEffect(() => setSrc(eventImage(event)), [event]);

  useLayoutEffect(() => {
    const place = () => {
      const el = cardRef.current;
      if (!el) return;
      const { clientWidth: W, clientHeight: H } = map.getContainer();
      const p = map.project([event.lon, event.lat]);
      const h = el.offsetHeight;
      const w = Math.min(CARD_W, W - 16);
      const clampX = (x: number) => Math.min(Math.max(x, 8), W - w - 8);
      const clampY = (y: number) => Math.min(Math.max(y, TOP_SAFE), H - h - 8);
      let left: number;
      let top: number;
      // Prefer above, then below, then beside — never cover the marker itself.
      if (p.y - GAP - h >= TOP_SAFE) [left, top] = [clampX(p.x - w / 2), p.y - GAP - h];
      else if (p.y + GAP + h <= H - 8) [left, top] = [clampX(p.x - w / 2), p.y + GAP];
      else if (p.x + GAP + w <= W - 8) [left, top] = [p.x + GAP, clampY(p.y - h / 2)];
      else [left, top] = [Math.max(8, p.x - GAP - w), clampY(p.y - h / 2)];
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    place();
    const img = cardRef.current?.querySelector("img");
    img?.addEventListener("load", place);
    map.on("move", place);
    map.on("resize", place);
    return () => {
      img?.removeEventListener("load", place);
      map.off("move", place);
      map.off("resize", place);
    };
  }, [map, event, src]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const when = new Date(event.time);
  const rows = metaRows(event);

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${meta.label}: ${event.title}`}
      className="wev-card"
      style={{ width: CARD_W, fontFamily: FONT, ["--wev-accent" as string]: meta.color }}
      onMouseDown={(ev) => ev.stopPropagation()}
      onWheel={(ev) => ev.stopPropagation()}
    >
      <div className="wev-card-hero">
        <img src={src} alt="" onError={() => setSrc((s) => (s === eventFallbackImage(event) ? s : eventFallbackImage(event)))} />
        <div className="wev-card-hero-shade" />
        <div className="wev-card-chips">
          <span className="wev-chip" style={{ background: meta.color }}>{meta.short}</span>
          <span className="wev-chip wev-chip-dim">{event.category.toUpperCase()}</span>
        </div>
        <button type="button" className="wev-card-close" onClick={onClose} aria-label="Close event details">
          <X size={14} aria-hidden />
        </button>
        <div className="wev-card-age">{relativeAge(event.time)}</div>
      </div>

      <div className="wev-card-body">
        <h3 className="wev-card-title">{event.title}</h3>
        {event.meta.place ? <p className="wev-card-place">{String(event.meta.place)}</p> : null}

        <div className="wev-card-sev" aria-label={`Severity ${event.severity} of 5`}>
          <span>SEVERITY</span>
          <span className="wev-card-bars" aria-hidden>
            {[1, 2, 3, 4, 5].map((i) => (
              <i key={i} style={{ height: 4 + i * 2, background: i <= event.severity ? meta.color : "rgba(125,249,255,0.15)" }} />
            ))}
          </span>
          <span className="wev-card-time">{when.toISOString().slice(0, 16).replace("T", " ")} UTC</span>
        </div>

        {event.summary && event.summary !== event.title ? <p className="wev-card-summary">{event.summary}</p> : null}

        {correlation ? (
          <div className="wev-card-corr">
            {correlation.kind === "aircraft_in_tfr" ? <Plane size={13} aria-hidden /> : <ShipIcon size={13} aria-hidden />}
            <span>
              <b>{correlation.count} {correlation.kind === "aircraft_in_tfr" ? "AIRCRAFT INSIDE" : "SHIPS INSIDE"}</b>
              {correlation.sample.length ? ` · ${correlation.sample.slice(0, 4).join(", ")}` : ""}
            </span>
          </div>
        ) : null}

        {rows.length ? (
          <dl className="wev-card-meta">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd title={v}>{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="wev-card-actions">
          <button type="button" onClick={() => onFly(event)}>
            <Crosshair size={13} aria-hidden /> ZOOM TO
          </button>
          {event.url ? (
            <a href={event.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} aria-hidden /> {event.source === "gdelt" ? "READ ARTICLE" : "OPEN SOURCE"}
            </a>
          ) : null}
        </div>
        <p className="wev-card-origin">VIA {meta.origin.toUpperCase()}</p>
      </div>
    </div>,
    map.getContainer(),
  );
}
