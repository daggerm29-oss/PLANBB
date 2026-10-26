import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "./cctv";

export interface LaunchStage {
  serial: string | null;
  type: string | null;
  reused: boolean | null;
  flight: number | null;
  landingAttempt: boolean | null;
  landingSuccess: boolean | null;
  landingType: string | null;
  landingName: string | null;
  landingDownrangeKm: number | null;
}

export interface Launch {
  id: string;
  name: string;
  net: string;
  status: string;
  statusName: string;
  provider: string | null;
  rocket: string;
  rocketLengthM: number | null;
  rocketDiameterM: number | null;
  mission: string | null;
  missionType: string | null;
  missionDescription: string | null;
  orbit: string | null;
  orbitName: string | null;
  pad: { name: string; location: string | null; lat: number; lon: number; country: string | null };
  image: string | null;
  patch: string | null;
  webcast: string | null;
  stages: LaunchStage[];
}

export interface LaunchesPayload {
  fetchedAt: number;
  upcoming: Launch[];
  previous: Launch[];
}

/** How a mission is played: synced to the real clock, a reconstruction of a past flight, or a prediction. */
export type LaunchPlayMode = "live" | "replay" | "simulation";

/** A launch is "live" from 1 h before T-0 until 90 min after (the ascent + first orbit). */
export const LIVE_BEFORE_S = 3600;
export const LIVE_AFTER_S = 5400;

export function launchTimeSec(l: Launch): number {
  return Date.parse(l.net) / 1000;
}

export function missionClockSec(l: Launch, nowMs = Date.now()): number {
  return nowMs / 1000 - launchTimeSec(l);
}

export function isLiveWindow(l: Launch, nowMs = Date.now()): boolean {
  const t = missionClockSec(l, nowMs);
  if (l.status === "Failure" || l.status === "Scrubbed") return false;
  return t >= -LIVE_BEFORE_S && t <= LIVE_AFTER_S;
}

export function defaultPlayMode(l: Launch, nowMs = Date.now()): LaunchPlayMode {
  if (isLiveWindow(l, nowMs)) return "live";
  return missionClockSec(l, nowMs) > 0 ? "replay" : "simulation";
}

/** "Falcon 9 Block 5 | Starlink Group 10-5" -> "Starlink Group 10-5". */
export function missionTitle(l: Launch): string {
  const i = l.name.indexOf("|");
  return (l.mission ?? (i >= 0 ? l.name.slice(i + 1) : l.name)).trim();
}

export function formatMissionClock(t: number): string {
  const sign = t < 0 ? "-" : "+";
  const a = Math.abs(Math.trunc(t));
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T${sign}${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "Success":
      return "#34d399";
    case "Failure":
    case "Partial Failure":
      return "#f87171";
    case "In Flight":
      return "#fbbf24";
    case "Go":
      return "#22d3ee";
    case "Hold":
    case "Scrubbed":
      return "#fb923c";
    default:
      return "#94a3b8";
  }
}

type Status = "idle" | "loading" | "ready" | "error";

/** Launch list from /api/launches (server caches Launch Library 2 for 30 min). Fetched once the panel opens. */
export function useLaunches(active: boolean) {
  const [data, setData] = useState<LaunchesPayload | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const started = useRef(false);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const r = await fetch(`${apiBase()}/api/launches`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as LaunchesPayload);
      setStatus("ready");
    } catch (e) {
      console.error("Failed to load launches", e);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    void load();
  }, [active, load]);

  return { data, status, reload: load };
}
