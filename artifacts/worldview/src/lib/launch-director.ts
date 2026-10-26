import type { Trajectory } from "./launch-trajectory";

/**
 * The "movie": an ordered list of camera shots, each covering a slice of mission time.
 * In REPLAY / SIMULATION the playback clock `p` (seconds at 1x) is mapped onto mission time
 * shot by shot, so liftoff plays close to real time while the long coast to orbit is
 * compressed. In LIVE mode mission time is the real clock and long shots alternate between
 * two camera set-ups so the feed keeps cutting like a broadcast.
 */

export type ShotId =
  | "pad360"
  | "liftoff"
  | "tracking"
  | "chase"
  | "onboard"
  | "sepchase"
  | "highalt"
  | "landing"
  | "insertion"
  | "overview"
  | "hold";

export interface Shot {
  id: ShotId;
  cam: string;
  label: string;
  tStart: number;
  tEnd: number;
  /** Playback seconds at 1x. */
  dur: number;
  /** Continuous camera move from the previous shot instead of a hard cut. */
  blend?: boolean;
}

export interface Timeline {
  shots: Shot[];
  pStarts: number[];
  /** Playback seconds until the open-ended HOLD shot begins. */
  totalP: number;
  /** Mission seconds per playback second during HOLD. */
  holdRate: number;
}

const LABELS: Record<ShotId, { cam: string; label: string }> = {
  pad360: { cam: "CAM 01", label: "PAD 360 · TERMINAL COUNT" },
  liftoff: { cam: "CAM 02", label: "LIFTOFF · PAD PERIMETER" },
  tracking: { cam: "CAM 03", label: "LONG-RANGE TRACKING · 1200MM" },
  chase: { cam: "CAM 04", label: "CHASE · AIRBORNE" },
  onboard: { cam: "CAM 05", label: "ONBOARD · AFT FACING" },
  sepchase: { cam: "CAM 06", label: "STAGE SEPARATION" },
  highalt: { cam: "CAM 07", label: "HIGH ALTITUDE · LIMB VIEW" },
  landing: { cam: "CAM 08", label: "RECOVERY · LANDING ZONE" },
  insertion: { cam: "CAM 09", label: "ORBIT INSERTION" },
  overview: { cam: "ORBIT", label: "TRAJECTORY + ORBIT OVERVIEW" },
  hold: { cam: "ORBIT", label: "EST. ORBIT POSITION" },
};

const shot = (id: ShotId, tStart: number, tEnd: number, dur: number, blend = false): Shot => ({
  id,
  ...LABELS[id],
  tStart,
  tEnd,
  dur,
  blend,
});

export function buildTimeline(tr: Trajectory): Timeline {
  const shots: Shot[] = [];
  if (tr.spec.kind === "suborbital") {
    shots.push(
      shot("pad360", -14, 0, 10),
      shot("liftoff", 0, 8, 8),
      shot("tracking", 8, 50, 8),
      shot("chase", 50, 130, 8),
      shot("highalt", 130, 300, 8),
      shot("overview", 300, 480, 10, true),
    );
    const pStarts = cumulative(shots);
    return { shots: [...shots, shot("hold", 480, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, true)], pStarts: [...pStarts, sum(shots)], totalP: sum(shots), holdRate: 2 };
  }

  const recovering = tr.landing === "ASDS" || tr.landing === "RTLS";
  const highEnd = recovering ? tr.tLand - 60 : 440;
  shots.push(
    shot("pad360", -14, 0, 10),
    shot("liftoff", 0, 8, 8),
    shot("tracking", 8, 50, 8),
    shot("chase", 50, 110, 7),
    shot("onboard", 110, 164, 8),
    shot("sepchase", 164, 215, 7),
    shot("highalt", 215, highEnd, 7),
  );
  if (recovering) shots.push(shot("landing", highEnd, tr.tLand + 4, 9));
  const insStart = Math.max(recovering ? tr.tLand + 4 : highEnd, tr.tInsert - 40);
  shots.push(shot("insertion", insStart, tr.tInsert + 20, 6));
  const span = Math.min(tr.periodSec * (tr.spec.kind === "transfer" ? 0.45 : 0.3), 3 * 86400);
  shots.push(shot("overview", tr.tInsert + 20, tr.tInsert + 20 + span, 12, true));
  const totalP = sum(shots);
  const pStarts = cumulative(shots);
  const holdStart = tr.tInsert + 20 + span;
  shots.push(shot("hold", holdStart, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, true));
  pStarts.push(totalP);
  return { shots, pStarts, totalP, holdRate: (span / 12) * 0.35 };
}

function sum(shots: Shot[]) {
  return shots.reduce((a, s) => a + s.dur, 0);
}
function cumulative(shots: Shot[]) {
  const out: number[] = [];
  let acc = 0;
  for (const s of shots) {
    out.push(acc);
    acc += s.dur;
  }
  return out;
}

export interface ShotSample {
  index: number;
  shot: Shot;
  /** Camera move progress inside the shot, 0..1 (HOLD: seconds since start). */
  s: number;
  t: number;
  /** Camera variant (live mode alternates long shots). */
  variant: ShotId;
}

/** Replay: playback seconds -> shot + mission time. */
export function sampleReplay(tl: Timeline, p: number): ShotSample {
  const pc = Math.max(0, p);
  let i = tl.pStarts.length - 1;
  while (i > 0 && pc < tl.pStarts[i]) i--;
  const sh = tl.shots[i];
  if (sh.id === "hold") {
    const dt = pc - tl.pStarts[i];
    return { index: i, shot: sh, s: dt, t: sh.tStart + dt * tl.holdRate, variant: "hold" };
  }
  const s = Math.min((pc - tl.pStarts[i]) / sh.dur, 1);
  return { index: i, shot: sh, s, t: sh.tStart + (sh.tEnd - sh.tStart) * s, variant: sh.id };
}

/** Inverse of sampleReplay: first playback second that shows mission time t. */
export function playbackForMissionTime(tl: Timeline, t: number): number {
  for (let i = 0; i < tl.shots.length; i++) {
    const sh = tl.shots[i];
    if (t < sh.tEnd || sh.id === "hold") {
      if (sh.id === "hold") return tl.pStarts[i] + Math.max(0, t - sh.tStart) / tl.holdRate;
      const s = Math.max(0, (t - sh.tStart) / (sh.tEnd - sh.tStart));
      return tl.pStarts[i] + s * sh.dur;
    }
  }
  return tl.totalP;
}

const LIVE_ALT: Partial<Record<ShotId, ShotId>> = {
  tracking: "chase",
  chase: "onboard",
  onboard: "chase",
  sepchase: "highalt",
  highalt: "chase",
  insertion: "highalt",
};
const LIVE_SEGMENT_S = 18;
const PAD_LOOP_S = 40;

/** Live: real mission clock -> shot. */
export function sampleLive(tl: Timeline, t: number): ShotSample {
  let i = 0;
  while (i < tl.shots.length - 1 && t >= tl.shots[i].tEnd) i++;
  const sh = tl.shots[i];
  if (t < sh.tStart && sh.id === "pad360") {
    return { index: i, shot: sh, s: (((t % PAD_LOOP_S) + PAD_LOOP_S) % PAD_LOOP_S) / PAD_LOOP_S, t, variant: "pad360" };
  }
  if (sh.id === "hold") return { index: i, shot: sh, s: t - sh.tStart, t, variant: "hold" };
  const span = sh.tEnd - sh.tStart;
  const local = t - sh.tStart;
  if (span > LIVE_SEGMENT_S * 1.6 && LIVE_ALT[sh.id]) {
    const k = Math.floor(local / LIVE_SEGMENT_S);
    const segLen = Math.min(LIVE_SEGMENT_S, span - k * LIVE_SEGMENT_S);
    return { index: i, shot: sh, s: (local - k * LIVE_SEGMENT_S) / Math.max(segLen, 1), t, variant: k % 2 === 1 ? LIVE_ALT[sh.id]! : sh.id };
  }
  return { index: i, shot: sh, s: Math.min(local / span, 1), t, variant: sh.id };
}

export const shotMeta = (id: ShotId) => LABELS[id];
