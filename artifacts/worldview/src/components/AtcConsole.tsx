import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type maplibregl from "maplibre-gl";
import { Activity, ExternalLink, Mic, MicOff, Pin, PinOff, Radio, Square, Volume2 } from "lucide-react";
import { AIRPORTS } from "../lib/airports";
import {
  atcRelayUrl,
  atcStreamUrl,
  captureAndTranscribe,
  liveAtcSearchUrl,
  nearestActiveAtcAirport,
  useActiveAtcFeeds,
  type ActiveAtcFeed,
  type AtcTranscript,
} from "../lib/signals";

type AudioRoute = "relay" | "direct";

const FONT = "'Share Tech Mono','Courier New',monospace";
const ACCENT = "#a3e635";
const DIM = "rgba(217,249,157,0.55)";
const CLIP_SECONDS = 20;
const MAX_TRANSCRIPTS = 40;
const SQUELCH_DB_THRESHOLD = -46;

type PlayState = "stopped" | "connecting" | "live" | "offline";

interface Props {
  map: maplibregl.Map | null;
  /** Airport the user is currently viewing in 3D, if any — takes priority over the map center. */
  focusIcao?: string | null;
  onFlagged: (t: AtcTranscript) => void;
}

const SEV_COLOR = ["#94a3b8", "#facc15", "#fb923c", "#ef4444"];

interface DeckNodes {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  data: Float32Array;
}

export function AtcConsole({ map, focusIcao, onFlagged }: Props) {
  const { feeds: activeFeeds } = useActiveAtcFeeds();

  const activeIcaos = useMemo(() => {
    const set = new Set<string>();
    for (const f of activeFeeds) set.add(f.icao);
    return Array.from(set);
  }, [activeFeeds]);

  const activeAirports = useMemo(
    () => AIRPORTS.filter((a) => activeIcaos.includes(a.icao)),
    [activeIcaos]
  );

  const [autoIcao, setAutoIcao] = useState<{ icao: string; km: number } | null>(null);
  const [pinned, setPinned] = useState<string | null>("RJTT");
  const [mount, setMount] = useState<string | null>(null);
  const [companionMount, setCompanionMount] = useState<string | null>(null);
  const [hearingMount, setHearingMount] = useState<string | null>(null);
  const [skipSilence, setSkipSilence] = useState<boolean>(true);
  const [boostAudio, setBoostAudio] = useState<boolean>(true);
  const [custom, setCustom] = useState("");
  const [play, setPlay] = useState<PlayState>("stopped");
  const [volume, setVolume] = useState(0.9);
  const [liveDb, setLiveDb] = useState<number>(-90);
  const [bars, setBars] = useState<number[]>([0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(0);
  const [capError, setCapError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<AtcTranscript[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const companionAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const primaryNodesRef = useRef<DeckNodes | null>(null);
  const companionNodesRef = useRef<DeckNodes | null>(null);

  const captureRun = useRef(0);
  const [route, setRoute] = useState<AudioRoute>("relay");
  const routeRef = useRef<AudioRoute>("relay");
  const mountRef = useRef<string | null>(null);
  const companionMountRef = useRef<string | null>(null);
  const connectTimer = useRef<number | undefined>(undefined);
  const lastPrimaryVoiceAt = useRef<number>(0);
  const lastAnyVoiceAt = useRef<number>(0);
  const scannerIdxRef = useRef<number>(0);

  // Follow the nearest airport that actually has active audio feeds.
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const c = map.getCenter();
      const n = nearestActiveAtcAirport(c.lat, c.lng, activeIcaos);
      setAutoIcao({ icao: n.airport.icao, km: n.km });
    };
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [map, activeIcaos]);

  const resolvedFocusIcao = focusIcao && activeIcaos.includes(focusIcao) ? focusIcao : null;
  const icao = pinned ?? resolvedFocusIcao ?? autoIcao?.icao ?? activeIcaos[0] ?? "RJTT";
  const airport = AIRPORTS.find((a) => a.icao === icao);

  // Only show feeds for this airport that are verified active
  const airportFeeds = useMemo(
    () => activeFeeds.filter((f) => f.icao === icao),
    [activeFeeds, icao]
  );

  // Top currently-playing feeds across all airports, sorted by real-time voice activity
  const talkingFeeds = useMemo(
    () =>
      [...activeFeeds].sort((a, b) => {
        if (a.talkingNow !== b.talkingNow) return a.talkingNow ? -1 : 1;
        if (a.continuous !== b.continuous) return a.continuous ? 1 : -1;
        return b.meanDb - a.meanDb;
      }),
    [activeFeeds]
  );

  const activeFeed: ActiveAtcFeed | null = useMemo(() => {
    if (!mount) return null;
    const found = activeFeeds.find((f) => f.mount === mount);
    if (found) return found;
    return {
      mount,
      icao,
      label: mount.toUpperCase(),
      airportName: airport?.name ?? "Custom",
      continuous: false,
      companion: "rjtt_app",
      online: true,
      active: true,
      talkingNow: true,
      meanDb: -24,
      maxDb: -6,
      lastTalkingAt: Date.now(),
      checkedAt: Date.now(),
    };
  }, [mount, activeFeeds, icao, airport]);

  // Initialize Web Audio API processing chain (bandpass + compressor + makeup gain + real-time analyser)
  function ensureAudioGraph() {
    const primaryEl = audioRef.current;
    const companionEl = companionAudioRef.current;
    if (!primaryEl || !companionEl) return;

    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const buildDeck = (el: HTMLAudioElement): DeckNodes => {
        const source = ctx.createMediaElementSource(el);
        const highpass = ctx.createBiquadFilter();
        highpass.type = "highpass";
        highpass.frequency.value = 220;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -34;
        compressor.knee.value = 14;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.15;

        const gain = ctx.createGain();
        gain.gain.value = volume * (boostAudio ? 2.4 : 1.1);

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.55;

        source.connect(highpass);
        highpass.connect(compressor);
        compressor.connect(gain);
        gain.connect(analyser);
        analyser.connect(ctx.destination);

        return {
          source,
          gain,
          analyser,
          data: new Float32Array(analyser.fftSize),
        };
      };

      if (!primaryNodesRef.current) {
        primaryNodesRef.current = buildDeck(primaryEl);
      }
      if (!companionNodesRef.current) {
        companionNodesRef.current = buildDeck(companionEl);
        companionNodesRef.current.gain.gain.value = 0;
      }
    } catch {
      // Fallback to native HTMLAudioElement volume if Web Audio graph is already bound
    }
  }

  // Real-time audio level meter & Dual-Watch Squelch-Skip loop
  useEffect(() => {
    if (play !== "live") {
      setLiveDb(-90);
      setBars([0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);
      return;
    }

    const measureDeck = (deck: DeckNodes | null): { db: number; bands: number[] } => {
      if (!deck) return { db: -90, bands: [0.08, 0.08, 0.08, 0.08, 0.08, 0.08] };
      deck.analyser.getFloatTimeDomainData(deck.data);
      let sum = 0;
      const len = deck.data.length;
      const seg = Math.floor(len / 6);
      const bands: number[] = [];
      for (let b = 0; b < 6; b++) {
        let bSum = 0;
        for (let i = b * seg; i < (b + 1) * seg; i++) {
          const s = deck.data[i] || 0;
          sum += s * s;
          bSum += s * s;
        }
        const bRms = Math.sqrt(bSum / seg);
        bands.push(Math.min(1, Math.max(0.08, bRms * 5.2)));
      }
      const rms = Math.sqrt(sum / len);
      const db = rms > 0.00001 ? Math.max(-90, Math.round(20 * Math.log10(rms) * 10) / 10) : -90;
      return { db, bands };
    };

    const targetGain = volume * (boostAudio ? 2.4 : 1.1);

    const timer = window.setInterval(() => {
      const now = Date.now();
      const pNode = primaryNodesRef.current;
      const cNode = companionNodesRef.current;
      const pMeas = measureDeck(pNode);
      const cMeas = measureDeck(cNode);

      const primaryTalking = pMeas.db > SQUELCH_DB_THRESHOLD;
      const companionTalking = cMeas.db > SQUELCH_DB_THRESHOLD;

      if (primaryTalking) {
        lastPrimaryVoiceAt.current = now;
        lastAnyVoiceAt.current = now;
      }

      const primarySilentMs = now - lastPrimaryVoiceAt.current;

      if (primaryTalking || !skipSilence || primarySilentMs < 1400) {
        // Primary channel has priority whenever it's talking or within 1.4s of last word
        if (pNode) pNode.gain.gain.value = targetGain;
        if (cNode) cNode.gain.gain.value = 0;
        setHearingMount(mountRef.current);
        setLiveDb(pMeas.db);
        setBars(primaryTalking ? pMeas.bands : [0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      } else if (skipSilence && companionMountRef.current) {
        // Primary is in a squelch pause (>1.4s): unmute companion deck if it has voice
        if (companionTalking) {
          lastAnyVoiceAt.current = now;
          if (pNode) pNode.gain.gain.value = targetGain * 0.25;
          if (cNode) cNode.gain.gain.value = targetGain;
          setHearingMount(companionMountRef.current);
          setLiveDb(cMeas.db);
          setBars(cMeas.bands);
        } else {
          if (pNode) pNode.gain.gain.value = targetGain;
          if (cNode) cNode.gain.gain.value = targetGain * 0.85;
          setHearingMount(mountRef.current);
          setLiveDb(Math.max(pMeas.db, cMeas.db));
          setBars([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);

          // If both primary and companion have been silent for > 3.8s, rotate companion to the next active feed
          if (now - lastAnyVoiceAt.current > 3800 && talkingFeeds.length > 1) {
            lastAnyVoiceAt.current = now;
            const candidates = talkingFeeds.filter((f) => f.mount !== mountRef.current);
            if (candidates.length > 0) {
              scannerIdxRef.current = (scannerIdxRef.current + 1) % candidates.length;
              const nextCompanion = candidates[scannerIdxRef.current].mount;
              if (nextCompanion !== companionMountRef.current) {
                attachCompanion(nextCompanion);
              }
            }
          }
        }
      }
    }, 85);

    return () => window.clearInterval(timer);
  }, [play, volume, boostAudio, skipSilence, talkingFeeds]);

  useEffect(() => {
    const a = audioRef.current;
    const c = companionAudioRef.current;
    if (a) a.volume = 1.0;
    if (c) c.volume = 1.0;
    const targetGain = volume * (boostAudio ? 2.4 : 1.1);
    if (primaryNodesRef.current) {
      primaryNodesRef.current.gain.gain.value = targetGain;
    } else if (a) {
      a.volume = volume;
    }
  }, [volume, boostAudio]);

  useEffect(() => () => {
    captureRun.current++;
    mountRef.current = null;
    companionMountRef.current = null;
    window.clearTimeout(connectTimer.current);
    audioRef.current?.pause();
    companionAudioRef.current?.pause();
  }, []);

  function stopCapture() {
    captureRun.current++;
    setCapturing(false);
  }

  function stopAudio() {
    mountRef.current = null;
    companionMountRef.current = null;
    window.clearTimeout(connectTimer.current);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    const c = companionAudioRef.current;
    if (c) {
      c.pause();
      c.removeAttribute("src");
      c.load();
    }
    setPlay("stopped");
    setMount(null);
    setCompanionMount(null);
    setHearingMount(null);
    stopCapture();
  }

  function attachCompanion(compMount: string) {
    const c = companionAudioRef.current;
    if (!c) return;
    companionMountRef.current = compMount;
    setCompanionMount(compMount);
    c.src = atcRelayUrl(compMount);
    c.play().catch(() => {
      /* ignore background companion autoplay errors */
    });
  }

  /** Connect via our CORS-enabled server relay first (~1s start + Web Audio API gain/meter), fallback to direct. */
  function attach(m: string, r: AudioRoute) {
    const a = audioRef.current;
    if (!a) return;
    ensureAudioGraph();
    window.clearTimeout(connectTimer.current);
    routeRef.current = r;
    setRoute(r);
    setPlay("connecting");
    a.src = r === "relay" ? atcRelayUrl(m) : atcStreamUrl(m);
    a.volume = 1.0;
    connectTimer.current = window.setTimeout(() => streamFailed(m, r), r === "relay" ? 10000 : 12000);
    a.play().catch((e: DOMException) => {
      if (e.name === "AbortError") return;
      if (e.name === "NotAllowedError") {
        window.clearTimeout(connectTimer.current);
        setPlay("offline");
        return;
      }
      streamFailed(m, r);
    });
  }

  function streamFailed(m: string, r: AudioRoute) {
    if (mountRef.current !== m || routeRef.current !== r) return;
    if (r === "relay") {
      attach(m, "direct");
      return;
    }
    window.clearTimeout(connectTimer.current);
    // If a custom or temporarily busy mount failed, auto-switch to the highest-activity verified feed
    const fallback = talkingFeeds.find((f) => f.mount !== m);
    if (fallback && skipSilence) {
      setPinned(fallback.icao);
      playFeed(fallback.mount, fallback.icao);
      return;
    }
    setPlay("offline");
  }

  function playFeed(m: string, targetIcao?: string) {
    if (mount === m && play !== "offline") {
      stopAudio();
      return;
    }
    if (targetIcao) setPinned(targetIcao);
    if (mount !== m) stopCapture();
    mountRef.current = m;
    lastPrimaryVoiceAt.current = Date.now();
    lastAnyVoiceAt.current = Date.now();
    setMount(m);
    setHearingMount(m);
    attach(m, "relay");

    // Pick a high-activity companion mount for Dual-Watch squelch skipping
    const feedMeta = activeFeeds.find((f) => f.mount === m);
    const comp =
      feedMeta?.companion ||
      talkingFeeds.find((f) => f.mount !== m && !f.continuous)?.mount ||
      "rjtt_dep";
    if (skipSilence && comp && comp !== m) {
      attachCompanion(comp);
    }
  }

  async function toggleCapture() {
    if (capturing) {
      stopCapture();
      return;
    }
    const targetMount = hearingMount ?? activeFeed?.mount;
    if (!targetMount || play !== "live") {
      setCapError("Start a live feed first, then transcribe.");
      return;
    }
    setCapError(null);
    setCapturing(true);
    const run = ++captureRun.current;
    const icaoAtStart = icao;
    let failures = 0;
    while (captureRun.current === run) {
      setPending((p) => p + 1);
      const currentMount = hearingMount ?? mountRef.current ?? targetMount;
      const currentMeta = activeFeeds.find((f) => f.mount === currentMount);
      try {
        const t = await captureAndTranscribe(
          currentMount,
          currentMeta?.icao ?? icaoAtStart,
          currentMeta?.label ?? currentMount.toUpperCase(),
          CLIP_SECONDS
        );
        failures = 0;
        if (captureRun.current !== run || !t.lines.length) continue;
        const entry = { ...t, id: `${t.at}-${Math.random().toString(36).slice(2, 7)}` };
        setTranscripts((prev) => [entry, ...prev].slice(0, MAX_TRANSCRIPTS));
        if (entry.flags.some((f) => f.severity >= 2)) onFlagged(entry);
      } catch (e) {
        if (captureRun.current !== run) break;
        setCapError((e as Error).message);
        if (++failures >= 3) {
          stopCapture();
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      } finally {
        setPending((p) => p - 1);
      }
    }
  }

  const flaggedCount = transcripts.reduce((n, t) => n + t.flags.filter((f) => f.severity >= 2).length, 0);
  const isTalkingNow = play === "live" && liveDb > SQUELCH_DB_THRESHOLD;
  const activeHearingMeta = activeFeeds.find((f) => f.mount === (hearingMount ?? mount));

  return (
    <section aria-label="Live ATC" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <audio
        ref={audioRef}
        preload="none"
        crossOrigin="anonymous"
        onPlaying={() => {
          window.clearTimeout(connectTimer.current);
          setPlay("live");
          if (audioCtxRef.current?.state === "suspended") {
            void audioCtxRef.current.resume();
          }
        }}
        onWaiting={() => setPlay((p) => (p === "live" ? "connecting" : p))}
        onError={() => {
          const m = mountRef.current;
          if (m) streamFailed(m, routeRef.current);
        }}
        onEnded={() => {
          const m = mountRef.current;
          if (m) attach(m, routeRef.current);
        }}
      />
      <audio ref={companionAudioRef} preload="none" crossOrigin="anonymous" />

      {/* Live Active Audio Scanner Banner */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "7px 8px",
          border: `1px solid ${ACCENT}44`,
          background: "rgba(163,230,53,0.05)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9, letterSpacing: "0.14em", color: ACCENT }}>
            <Radio size={11} aria-hidden />
            VERIFIED ACTIVE AUDIO ({talkingFeeds.length} LIVE)
          </span>
          <button
            type="button"
            onClick={() => {
              const best = talkingFeeds[0];
              if (best) playFeed(best.mount, best.icao);
            }}
            style={{
              fontFamily: FONT,
              fontSize: 8.5,
              letterSpacing: "0.14em",
              padding: "2px 7px",
              cursor: "pointer",
              color: "#05090a",
              background: ACCENT,
              border: "none",
            }}
          >
            {play === "live" ? "NEXT ACTIVE" : "▶ PLAY BUSIEST"}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 4 }}>
          {talkingFeeds.slice(0, 6).map((f) => {
            const selected = mount === f.mount;
            const hearing = play === "live" && hearingMount === f.mount;
            return (
              <button
                key={f.mount}
                type="button"
                onClick={() => playFeed(f.mount, f.icao)}
                aria-pressed={selected}
                title={`${f.airportName} ${f.label} (${f.mount}) · Avg ${Math.round(f.meanDb)} dB`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 4,
                  fontFamily: FONT,
                  fontSize: 8.5,
                  letterSpacing: "0.08em",
                  padding: "5px 6px",
                  cursor: "pointer",
                  color: selected ? "#05090a" : "#ecfccb",
                  background: selected ? ACCENT : hearing ? "rgba(163,230,53,0.18)" : "rgba(5,9,10,0.7)",
                  border: `1px solid ${selected || hearing ? ACCENT : `${ACCENT}33`}`,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span
                    aria-hidden
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 99,
                      flexShrink: 0,
                      background: selected ? "#05090a" : f.talkingNow ? ACCENT : "#facc15",
                    }}
                  />
                  {f.icao} {f.label}
                </span>
                <span style={{ fontSize: 7.5, opacity: 0.85, flexShrink: 0 }}>
                  {f.continuous ? "24/7" : `${Math.round(f.meanDb)}dB`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Airport Header & Active-Only Selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, letterSpacing: "0.12em", color: "#ecfccb" }}>
            {icao} <span style={{ color: DIM, fontSize: 10.5, letterSpacing: "0.1em" }}>{airport?.iata ?? ""}</span>
          </div>
          <div style={{ fontSize: 9.5, color: DIM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {airport ? `${airport.name} · ${airport.city}` : "Active ATC Hub"}
            {!pinned && !resolvedFocusIcao && autoIcao ? ` · ${Math.round(autoIcao.km)} KM` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPinned((p) => (p ? null : icao))}
          aria-pressed={!!pinned}
          title={pinned ? "Unpin — follow nearest active airport" : "Pin this airport"}
          style={iconBtn(!!pinned)}
        >
          {pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
          <span className="sr-only">{pinned ? "Unpin airport" : "Pin airport"}</span>
        </button>
        <select
          aria-label="Choose active airport"
          value={activeAirports.some((a) => a.icao === icao) ? icao : activeAirports[0]?.icao ?? "RJTT"}
          onChange={(e) => {
            const nextIcao = e.target.value;
            setPinned(nextIcao);
            const firstFeed = activeFeeds.find((f) => f.icao === nextIcao);
            if (firstFeed) playFeed(firstFeed.mount, nextIcao);
          }}
          style={{
            fontFamily: FONT,
            fontSize: 10,
            background: "#05090a",
            color: "#ecfccb",
            border: `1px solid ${ACCENT}44`,
            padding: "4px 4px",
            maxWidth: 105,
          }}
        >
          {activeAirports.map((a) => (
            <option key={a.icao} value={a.icao}>
              {a.icao} · {a.iata}
            </option>
          ))}
        </select>
      </div>

      {/* Airport Active Feeds Grid */}
      {airportFeeds.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
          {airportFeeds.map((f) => {
            const on = mount === f.mount;
            const state = on ? play : "stopped";
            return (
              <button
                key={f.mount}
                type="button"
                onClick={() => playFeed(f.mount, f.icao)}
                aria-pressed={on}
                title={`LiveATC mount ${f.mount} (${Math.round(f.meanDb)} dB)`}
                style={{
                  fontFamily: FONT,
                  fontSize: 8.5,
                  letterSpacing: "0.1em",
                  padding: "6px 2px",
                  cursor: "pointer",
                  color: on ? "#05090a" : state === "offline" ? "#fca5a5" : "#ecfccb",
                  background: on ? (state === "offline" ? "#f87171" : ACCENT) : "rgba(163,230,53,0.06)",
                  border: `1px solid ${on ? "transparent" : `${ACCENT}33`}`,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Dual-Watch Squelch Skip & Audio Boost Controls */}
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          onClick={() => {
            const next = !skipSilence;
            setSkipSilence(next);
            if (!next && companionAudioRef.current) {
              companionAudioRef.current.pause();
            } else if (next && mount && play === "live") {
              const comp = activeFeeds.find((f) => f.mount === mount)?.companion || "rjtt_dep";
              if (comp !== mount) attachCompanion(comp);
            }
          }}
          aria-pressed={skipSilence}
          title="Automatically bridges silence gaps between transmissions with companion active frequencies so audio plays every few seconds"
          style={{
            flex: 1,
            fontFamily: FONT,
            fontSize: 8.5,
            letterSpacing: "0.1em",
            padding: "5px 6px",
            cursor: "pointer",
            color: skipSilence ? "#05090a" : ACCENT,
            background: skipSilence ? ACCENT : "transparent",
            border: `1px solid ${ACCENT}55`,
          }}
        >
          {skipSilence ? "✓ SKIP SILENCE (DUAL-WATCH)" : "SINGLE FREQ ONLY"}
        </button>
        <button
          type="button"
          onClick={() => setBoostAudio((b) => !b)}
          aria-pressed={boostAudio}
          title="Boosts quiet VHF radio transmissions with dynamic compression (+7.5 dB)"
          style={{
            fontFamily: FONT,
            fontSize: 8.5,
            letterSpacing: "0.1em",
            padding: "5px 8px",
            cursor: "pointer",
            color: boostAudio ? "#05090a" : ACCENT,
            background: boostAudio ? ACCENT : "transparent",
            border: `1px solid ${ACCENT}55`,
          }}
        >
          {boostAudio ? "BOOST +8dB" : "RAW GAIN"}
        </button>
      </div>

      {/* Custom Mount Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const m = custom.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
          if (m) playFeed(m);
        }}
        style={{ display: "flex", gap: 4 }}
      >
        <label htmlFor="atc-mount" className="sr-only">LiveATC mount name</label>
        <input
          id="atc-mount"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="custom mount e.g. rjtt_app"
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: FONT,
            fontSize: 10,
            background: "#05090a",
            color: "#ecfccb",
            border: `1px solid ${ACCENT}33`,
            padding: "5px 6px",
          }}
        />
        <button type="submit" style={{ ...iconBtn(false), width: "auto", padding: "0 8px", fontSize: 9, letterSpacing: "0.14em" }}>
          TUNE
        </button>
        <a
          href={liveAtcSearchUrl(icao)}
          target="_blank"
          rel="noreferrer"
          title="Find this airport's feeds on LiveATC"
          style={{ ...iconBtn(false), textDecoration: "none" }}
        >
          <ExternalLink size={12} aria-hidden />
          <span className="sr-only">Search LiveATC for {icao}</span>
        </a>
      </form>

      {/* Active Playback Status & Real-Time VU Meter */}
      {activeFeed && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 8px",
            border: `1px solid ${play === "offline" ? "#f8717155" : isTalkingNow ? ACCENT : `${ACCENT}44`}`,
            background: isTalkingNow ? "rgba(163,230,53,0.09)" : "rgba(5,9,10,0.65)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 99,
              background: play === "offline" ? "#f87171" : isTalkingNow ? ACCENT : "#facc15",
              boxShadow: isTalkingNow ? `0 0 8px ${ACCENT}` : "none",
            }}
          />
          <div style={{ flex: 1, minWidth: 0, fontSize: 9.5, letterSpacing: "0.09em" }}>
            <div style={{ color: "#ecfccb", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span>{(hearingMount ?? activeFeed.mount).toUpperCase()}</span>
              <span style={{ color: isTalkingNow ? ACCENT : "#facc15" }}>
                · {play === "offline" ? "NO STREAM" : play === "connecting" ? "CONNECTING" : isTalkingNow ? `TRANSMITTING (${liveDb} dB)` : "SQUELCH · SCANNING"}
              </span>
            </div>
            <div style={{ fontSize: 8.5, color: DIM, marginTop: 1 }}>
              {activeHearingMeta ? `${activeHearingMeta.airportName} · ${activeHearingMeta.label}` : activeFeed.mount.toUpperCase()}
              {hearingMount && hearingMount !== activeFeed.mount ? ` · BRIDGING SILENCE ON ${activeFeed.mount.toUpperCase()}` : ""}
              {companionMount && skipSilence && hearingMount === activeFeed.mount ? ` · DUAL-WATCH: ${companionMount.toUpperCase()}` : ""}
              {play !== "offline" ? ` · ${route === "relay" ? "BOOSTED RELAY" : "DIRECT"}` : ""}
            </div>
            {play === "offline" && (
              <div style={{ color: "#fca5a5", lineHeight: 1.5, marginTop: 2 }}>
                Feed unavailable. Click another verified active channel above.
              </div>
            )}
          </div>
          {play === "live" && <EqBars bars={bars} talking={isTalkingNow} />}
          <button type="button" onClick={stopAudio} style={iconBtn(false)} title="Stop">
            <Square size={11} aria-hidden />
            <span className="sr-only">Stop audio</span>
          </button>
        </div>
      )}

      {/* Volume Slider */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Volume2 size={13} color={DIM} aria-hidden />
        <label htmlFor="atc-vol" className="sr-only">Volume</label>
        <input
          id="atc-vol"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          style={{ flex: 1, accentColor: ACCENT }}
        />
        <span style={{ fontSize: 8.5, color: DIM, minWidth: 32, textAlign: "right" }}>{Math.round(volume * 100)}%</span>
      </div>

      {/* Gemini Transcription */}
      <button
        type="button"
        onClick={() => void toggleCapture()}
        aria-pressed={capturing}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontFamily: FONT,
          fontSize: 10,
          letterSpacing: "0.22em",
          padding: "8px 0",
          cursor: "pointer",
          color: capturing ? "#05090a" : ACCENT,
          background: capturing ? ACCENT : "transparent",
          border: `1px solid ${ACCENT}`,
          boxShadow: capturing ? `0 0 16px ${ACCENT}66` : "none",
        }}
      >
        {capturing ? <MicOff size={13} aria-hidden /> : <Mic size={13} aria-hidden />}
        {capturing ? `TRANSCRIBING${pending ? " ···" : ""}` : "GEMINI TRANSCRIBE"}
      </button>
      <p style={{ margin: 0, fontSize: 9, lineHeight: 1.5, color: DIM }}>
        {capturing
          ? `Recording ${CLIP_SECONDS}s clips of ${(hearingMount ?? activeFeed?.mount ?? "feed").toUpperCase()} on the server and transcribing with Gemini.`
          : "Only feeds with verified live audio are shown above. Dual-Watch automatically fills squelch pauses so you hear transmissions every few seconds."}
      </p>
      {capError && (
        <p role="alert" style={{ margin: 0, fontSize: 9.5, color: "#fca5a5" }}>
          {capError}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, letterSpacing: "0.18em", color: DIM, paddingTop: 2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Activity size={11} aria-hidden />
          TRANSCRIPT LOG · {transcripts.length}
        </span>
        {flaggedCount > 0 && <span style={{ color: "#fb923c" }}>{flaggedCount} FLAGGED</span>}
      </div>
      <ol aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
        {transcripts.length === 0 && (
          <li style={{ fontSize: 9.5, color: DIM, padding: "8px 0", textAlign: "center", border: `1px dashed ${ACCENT}22` }}>
            {capturing ? "Listening for transmissions…" : "No transmissions transcribed yet."}
          </li>
        )}
        {transcripts.map((t) => {
          const top = Math.max(0, ...t.flags.map((f) => f.severity));
          return (
            <li
              key={t.id}
              style={{
                borderLeft: `2px solid ${top ? SEV_COLOR[top] : `${ACCENT}55`}`,
                padding: "4px 0 4px 8px",
                background: top >= 2 ? "rgba(239,68,68,0.06)" : "transparent",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: DIM, letterSpacing: "0.12em" }}>
                <span>{t.icao} · {t.feed}</span>
                <time dateTime={new Date(t.at).toISOString()}>{new Date(t.at).toISOString().slice(11, 19)}Z</time>
              </div>
              {t.flags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, margin: "3px 0" }}>
                  {t.flags.map((f) => (
                    <span key={f.tag} style={{ fontSize: 8.5, letterSpacing: "0.1em", padding: "1px 5px", color: "#05090a", background: SEV_COLOR[f.severity] }}>
                      {f.tag}
                    </span>
                  ))}
                </div>
              )}
              {t.lines.map((l, i) => (
                <div key={i} style={{ fontSize: 10, lineHeight: 1.45, color: "#ecfccb" }}>
                  <span style={{ color: l.speaker === "ATC" ? "#67e8f9" : ACCENT }}>{l.speaker}: </span>
                  {l.text}
                </div>
              ))}
              {t.summary && <div style={{ fontSize: 9, color: DIM, marginTop: 2 }}>{t.summary}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Real-time Web Audio API level bars — only bounce when real audio signal is present. */
function EqBars({ bars, talking }: { bars: number[]; talking: boolean }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14 }}>
      {bars.map((v, i) => (
        <span
          key={i}
          style={{
            width: 2.5,
            height: `${Math.round(Math.max(12, Math.min(100, v * 100)))}%`,
            background: talking ? ACCENT : "rgba(250,204,21,0.45)",
            transition: "height 75ms ease-out",
          }}
        />
      ))}
    </span>
  );
}

function iconBtn(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    cursor: "pointer",
    fontFamily: FONT,
    color: active ? "#05090a" : ACCENT,
    background: active ? ACCENT : "transparent",
    border: `1px solid ${ACCENT}55`,
  };
}


