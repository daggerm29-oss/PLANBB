import { useSyncExternalStore } from "react";
import { frameUrl } from "./cctv";

/**
 * One poller per camera, shared by every consumer (the feed panel and the in-map frustum projection),
 * so selecting a camera never doubles the load on the api-server or the upstream DOT.
 */

export interface LiveFrameState {
  src: string | null;
  offline: boolean;
  changedAt: number | null;
}

const POLL_MS = 1000;
const OFFLINE_AFTER_FAILURES = 5;
const IDLE: LiveFrameState = { src: null, offline: false, changedAt: null };

interface Entry {
  state: LiveFrameState;
  listeners: Set<() => void>;
  stop: () => void;
}

const entries = new Map<string, Entry>();

function start(cameraId: string): Entry {
  const entry: Entry = { state: IDLE, listeners: new Set(), stop: () => {} };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let lastHash = "";
  let failures = 0;

  const publish = (next: Partial<LiveFrameState>) => {
    entry.state = { ...entry.state, ...next };
    entry.listeners.forEach((l) => l());
  };

  const tick = async () => {
    if (stopped) return;
    if (document.hidden) {
      timer = setTimeout(tick, POLL_MS);
      return;
    }
    const started = Date.now();
    controller = new AbortController();
    try {
      const res = await fetch(frameUrl(cameraId, started), { signal: controller.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hash = res.headers.get("X-Frame-Hash") ?? "";
      const blob = await res.blob();
      if (stopped) return;
      failures = 0;
      if (!hash || hash !== lastHash) {
        lastHash = hash;
        const prev = entry.state.src;
        publish({ src: URL.createObjectURL(blob), offline: false, changedAt: Date.now() });
        if (prev) URL.revokeObjectURL(prev);
      } else if (entry.state.offline) {
        publish({ offline: false });
      }
    } catch {
      if (stopped) return;
      failures += 1;
      if (failures >= OFFLINE_AFTER_FAILURES && !entry.state.offline) publish({ offline: true });
    }
    if (!stopped) timer = setTimeout(tick, Math.max(0, POLL_MS - (Date.now() - started)));
  };

  entry.stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
    if (entry.state.src) URL.revokeObjectURL(entry.state.src);
  };
  tick();
  return entry;
}

/** Grace period so remounts (StrictMode, panel re-open) reuse the running poller instead of restarting it. */
const RELEASE_DELAY_MS = 2000;
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function subscribe(cameraId: string, listener: () => void): () => void {
  clearTimeout(releaseTimers.get(cameraId));
  releaseTimers.delete(cameraId);
  let entry = entries.get(cameraId);
  if (!entry) {
    entry = start(cameraId);
    entries.set(cameraId, entry);
  }
  entry.listeners.add(listener);
  return () => {
    const e = entries.get(cameraId);
    if (!e) return;
    e.listeners.delete(listener);
    if (e.listeners.size > 0) return;
    releaseTimers.set(
      cameraId,
      setTimeout(() => {
        releaseTimers.delete(cameraId);
        if (e.listeners.size === 0 && entries.get(cameraId) === e) {
          e.stop();
          entries.delete(cameraId);
        }
      }, RELEASE_DELAY_MS),
    );
  };
}

const noopUnsubscribe = () => {};
const subscribers = new Map<string, (l: () => void) => () => void>();
const subscriberFor = (cameraId: string) => {
  let fn = subscribers.get(cameraId);
  if (!fn) {
    fn = (l) => subscribe(cameraId, l);
    subscribers.set(cameraId, fn);
  }
  return fn;
};
const subscribeNone = () => noopUnsubscribe;

/** Newest still frame for a camera (object URL), or idle state when `cameraId` is null. */
export function useLiveFrame(cameraId: string | null): LiveFrameState {
  return useSyncExternalStore(
    cameraId ? subscriberFor(cameraId) : subscribeNone,
    () => (cameraId ? entries.get(cameraId)?.state ?? IDLE : IDLE),
  );
}
