import { useEffect, useState } from "react";
import { apiBase } from "../lib/cctv";

export interface TrafficStatus {
  hasKey: boolean;
  mode: "live" | "simulation";
  provider: string | null;
  ttlSec: number;
  upstreamError: number | null;
}

const POLL_MS = 60_000;

/** Server-side TomTom key / upstream health. Live mode only when the proxy reports a working key. */
export function useTrafficStatus(active: boolean) {
  const [status, setStatus] = useState<TrafficStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase()}/api/proxy/traffic/status`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as TrafficStatus;
        if (!cancelled) setStatus(body);
      } catch {
        if (!cancelled) setStatus({ hasKey: false, mode: "simulation", provider: null, ttlSec: 120, upstreamError: null });
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return status;
}
