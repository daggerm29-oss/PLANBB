import { useSyncExternalStore } from "react";
import type { LngLat } from "./ai/geo";

export interface RouteEndpoint {
  name: string;
  lat: number;
  lon: number;
}

export interface Route3D {
  id: string;
  label: string;
  color: string;
  coords: LngLat[];
  from?: RouteEndpoint;
  to?: RouteEndpoint;
  distanceKm: number;
  durationMin: number | null;
  mode: string;
}

export interface Route3DState {
  route: Route3D | null;
  /** A new `seq` restarts the drone flight; null means the camera is free / in overview. */
  flight: { seq: number; durationSec?: number } | null;
}

/** Routes longer than this are flown on the 2D map; drone framing stops making sense at that scale. */
export const ROUTE_3D_MAX_KM = 500;

let state: Route3DState = { route: null, flight: null };
let flightSeq = 0;
const listeners = new Set<() => void>();

function set(next: Route3DState) {
  state = next;
  for (const l of listeners) l();
}

/**
 * Shared state between the AI executor (which has no React tree) and the Cesium route view mounted in
 * WorldviewMap. The copilot opens a route here and the view renders it over Google Photorealistic 3D Tiles.
 */
export const route3d = {
  open(route: Route3D) {
    set({ route, flight: null });
  },
  fly(durationSec?: number) {
    if (!state.route) return false;
    flightSeq += 1;
    set({ ...state, flight: { seq: flightSeq, durationSec } });
    return true;
  },
  stop() {
    if (state.flight) set({ ...state, flight: null });
  },
  close() {
    if (state.route || state.flight) set({ route: null, flight: null });
  },
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useRoute3D(): Route3DState {
  return useSyncExternalStore(route3d.subscribe, route3d.get, route3d.get);
}
