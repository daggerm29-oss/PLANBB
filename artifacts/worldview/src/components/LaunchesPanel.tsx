import { useEffect, useMemo, useState } from "react";
import { Play, Radio } from "lucide-react";
import {
  defaultPlayMode,
  formatMissionClock,
  formatUtc,
  isLiveWindow,
  missionClockSec,
  missionTitle,
  statusColor,
  type Launch,
  type LaunchesPayload,
} from "../lib/launches";
import { orbitSpec } from "../lib/launch-trajectory";
import { rocketSvg } from "../lib/rocket-icon";

const FONT = "'Share Tech Mono','Courier New',monospace";
const CYAN = "#22d3ee";
const DIM = "rgba(125,249,255,0.5)";

interface Props {
  data: LaunchesPayload | null;
  status: "idle" | "loading" | "ready" | "error";
  onReload: () => void;
  selectedId: string | null;
  onSelect: (l: Launch) => void;
  onPlay: (l: Launch, list: Launch[]) => void;
  onFly: (l: Launch) => void;
}

type Tab = "upcoming" | "previous";

function RocketGlyph({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size * 1.5, display: "inline-block", flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: rocketSvg(color, { size, glow: false }) }}
    />
  );
}

function relative(l: Launch, nowMs: number) {
  const t = missionClockSec(l, nowMs);
  if (Math.abs(t) < 86400 * 2) return formatMissionClock(t);
  const days = Math.round(Math.abs(t) / 86400);
  return t < 0 ? `IN ${days} DAYS` : `${days} DAYS AGO`;
}

/** Space missions picker: live, upcoming and past launches from Launch Library 2, each playable as a cinematic replay. */
export function LaunchesPanel({ data, status, onReload, selectedId, onSelect, onPlay, onFly }: Props) {
  const [tab, setTab] = useState<Tab>("upcoming");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const live = useMemo(() => [...(data?.upcoming ?? []), ...(data?.previous ?? [])].filter((l) => isLiveWindow(l, now)), [data, now]);
  const list = tab === "upcoming" ? data?.upcoming ?? [] : data?.previous ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", fontFamily: FONT }}>
      <div style={{ padding: "10px 12px 6px" }}>
        <p style={{ margin: "0 0 8px", fontSize: 10, color: DIM, lineHeight: 1.5 }}>
          Select a mission to inspect. Replay plays the launch as a cinematic multi-camera film: pad 360°, liftoff, tracking, stage separation, booster landing and the full orbit.
        </p>
        <div role="tablist" aria-label="Mission lists" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(["upcoming", "previous"] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              style={{
                fontFamily: FONT,
                fontSize: 10,
                letterSpacing: "0.22em",
                padding: "8px 0",
                cursor: "pointer",
                textTransform: "uppercase",
                color: tab === k ? "#e6fdff" : DIM,
                background: tab === k ? "rgba(34,211,238,0.14)" : "transparent",
                border: `1px solid ${tab === k ? "rgba(34,211,238,0.6)" : "rgba(34,211,238,0.2)"}`,
                boxShadow: tab === k ? "inset 0 0 10px rgba(34,211,238,0.25)" : "none",
              }}
            >
              {k === "upcoming" ? "Upcoming" : "Past"} {data ? `· ${(k === "upcoming" ? data.upcoming : data.previous).length}` : ""}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 12px 12px" }}>
        {status === "loading" && !data && <p style={{ fontSize: 10, color: DIM, letterSpacing: "0.2em" }}>QUERYING LAUNCH LIBRARY…</p>}
        {status === "error" && (
          <div style={{ fontSize: 10, color: "#fb7185", letterSpacing: "0.14em" }}>
            LAUNCH FEED UNAVAILABLE.{" "}
            <button type="button" onClick={onReload} style={{ fontFamily: FONT, background: "none", border: "none", color: CYAN, cursor: "pointer", textDecoration: "underline" }}>
              RETRY
            </button>
          </div>
        )}

        {live.length > 0 && (
          <section aria-label="Live missions" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9.5, letterSpacing: "0.3em", color: "#f43f5e", marginBottom: 6 }}>● LIVE NOW</div>
            {live.map((l) => (
              <Row key={`live-${l.id}`} l={l} now={now} selected={selectedId === l.id} onSelect={onSelect} onPlay={(x) => onPlay(x, live)} onFly={onFly} live />
            ))}
          </section>
        )}

        <section aria-label={tab === "upcoming" ? "Upcoming missions" : "Past missions"}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, letterSpacing: "0.26em", color: DIM, marginBottom: 6 }}>
            <span>AVAILABLE MISSIONS</span>
            <span>{list.length}</span>
          </div>
          {list.map((l) => (
            <Row key={l.id} l={l} now={now} selected={selectedId === l.id} onSelect={onSelect} onPlay={(x) => onPlay(x, list)} onFly={onFly} />
          ))}
        </section>
        {data && (
          <p style={{ fontSize: 8.5, color: "rgba(125,249,255,0.35)", letterSpacing: "0.1em", marginTop: 10 }}>
            SOURCE · THE SPACE DEVS LAUNCH LIBRARY 2 · UPDATED {formatUtc(data.fetchedAt)}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ l, now, selected, onSelect, onPlay, onFly, live }: { l: Launch; now: number; selected: boolean; onSelect: (l: Launch) => void; onPlay: (l: Launch) => void; onFly: (l: Launch) => void; live?: boolean }) {
  const mode = defaultPlayMode(l, now);
  const spec = useMemo(() => orbitSpec(l), [l]);
  const sc = statusColor(l.status);
  return (
    <div
      style={{
        position: "relative",
        marginBottom: 6,
        border: `1px solid ${selected ? "rgba(34,211,238,0.7)" : "rgba(34,211,238,0.18)"}`,
        background: selected ? "rgba(34,211,238,0.08)" : "rgba(2,8,14,0.6)",
        boxShadow: selected ? "0 0 16px rgba(34,211,238,0.25), inset 0 0 12px rgba(34,211,238,0.12)" : "none",
        transition: "all .15s ease",
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(l)}
        aria-expanded={selected}
        style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 10px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: FONT, color: "#e6fdff" }}
      >
        <RocketGlyph color={live ? "#f43f5e" : CYAN} size={14} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 11, letterSpacing: "0.14em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.rocket.toUpperCase()}</span>
          <span style={{ display: "block", fontSize: 9.5, color: DIM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {missionTitle(l)}
          </span>
          <span style={{ display: "flex", gap: 8, fontSize: 9, color: "rgba(165,243,252,0.75)", marginTop: 2 }}>
            <span>{l.net.slice(0, 10)}</span>
            <span style={{ color: live ? "#f43f5e" : "rgba(165,243,252,0.75)" }}>{relative(l, now)}</span>
          </span>
        </span>
        <span title={l.statusName} style={{ width: 7, height: 7, borderRadius: "50%", background: sc, boxShadow: `0 0 8px ${sc}`, flexShrink: 0 }} />
        <span aria-hidden style={{ color: DIM, fontSize: 12 }}>›</span>
      </button>

      {selected && (
        <div style={{ padding: "0 10px 10px", fontSize: 10, color: "#cfefff", lineHeight: 1.55 }}>
          {l.image && (
            <img
              src={l.image}
              alt={`${l.rocket} — ${missionTitle(l)}`}
              crossOrigin="anonymous"
              loading="lazy"
              style={{ width: "100%", height: 110, objectFit: "cover", border: "1px solid rgba(34,211,238,0.2)", marginBottom: 8, filter: "saturate(0.85) contrast(1.05)" }}
            />
          )}
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", margin: 0 }}>
            <dt style={{ color: DIM }}>STATUS</dt>
            <dd style={{ margin: 0, color: sc }}>{l.statusName.toUpperCase()}</dd>
            <dt style={{ color: DIM }}>PROVIDER</dt>
            <dd style={{ margin: 0 }}>{l.provider ?? "—"}</dd>
            <dt style={{ color: DIM }}>PAD</dt>
            <dd style={{ margin: 0 }}>{l.pad.name}</dd>
            <dt style={{ color: DIM }}>ORBIT</dt>
            <dd style={{ margin: 0 }}>
              {spec.label} · {spec.inclinationDeg.toFixed(1)}°
            </dd>
            <dt style={{ color: DIM }}>NET</dt>
            <dd style={{ margin: 0 }}>{formatUtc(Date.parse(l.net))}</dd>
            {l.stages[0]?.serial && (
              <>
                <dt style={{ color: DIM }}>BOOSTER</dt>
                <dd style={{ margin: 0 }}>
                  {l.stages[0].serial}
                  {l.stages[0].flight ? ` · FLIGHT ${l.stages[0].flight}` : ""}
                  {l.stages[0].landingName ? ` · ${l.stages[0].landingName}` : ""}
                </dd>
              </>
            )}
          </dl>
          {l.missionDescription && (
            <p style={{ margin: "6px 0 0", color: DIM, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{l.missionDescription}</p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => onPlay(l)}
              style={{
                fontFamily: FONT,
                fontSize: 10.5,
                letterSpacing: "0.24em",
                padding: "9px 0",
                cursor: "pointer",
                color: "#02060c",
                background: mode === "live" ? "#f43f5e" : CYAN,
                border: "none",
                boxShadow: `0 0 18px ${mode === "live" ? "rgba(244,63,94,0.55)" : "rgba(34,211,238,0.55)"}`,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {mode === "live" ? <Radio size={13} aria-hidden /> : <Play size={12} fill="currentColor" aria-hidden />}
                {mode === "live" ? "WATCH LIVE" : mode === "replay" ? "REPLAY MISSION" : "SIMULATE LAUNCH"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onFly(l)}
              style={{ fontFamily: FONT, fontSize: 10, letterSpacing: "0.18em", padding: "9px 10px", cursor: "pointer", color: CYAN, background: "transparent", border: "1px solid rgba(34,211,238,0.45)" }}
            >
              PAD
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
