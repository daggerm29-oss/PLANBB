import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type maplibregl from "maplibre-gl";
import { CCTV_SOURCE_COLORS, type CctvCamera } from "../lib/cctv";
import { estimatePose, type CameraPose } from "../lib/viewshed";
import { buildFrustum, planeFovDeg, quadToMatrix3d, type GeoPoint3 } from "../lib/frustum";
import { useLiveFrame } from "../lib/live-frame";

const MONO = "'Share Tech Mono','Courier New',monospace";
const LAYER_ID = "cctv-frustum-projection";
const MIN_ZOOM = 14;
/** Element-space width of the projected plane; the homography scales it to wherever the plane lands. */
const PLANE_PX = 480;
/** Target on-screen width of the plane, so the feed stays legible at any zoom. */
const TARGET_SCREEN_PX = 300;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  camera: CctvCamera | null;
  visible: boolean;
}

type Mat = ArrayLike<number>;
type ModelTransform = { getMatrixForModel: (loc: [number, number], altitude: number) => Mat };

function toScreen(
  transform: ModelTransform, main: Mat, p: GeoPoint3, w: number, h: number,
): [number, number] | null {
  const m = transform.getMatrixForModel([p[0], p[1]], p[2]);
  const x = m[12], y = m[13], z = m[14];
  const cx = main[0] * x + main[4] * y + main[8] * z + main[12];
  const cy = main[1] * x + main[5] * y + main[9] * z + main[13];
  const cw = main[3] * x + main[7] * y + main[11] * z + main[15];
  if (cw <= 1e-6) return null;
  return [((cx / cw + 1) / 2) * w, ((1 - cy / cw) / 2) * h];
}

const fmt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/**
 * Projects the selected camera's live frame into the 3D scene: the image is drawn on the camera's
 * frustum image plane (perspective-correct via a CSS homography recomputed every map frame), with
 * frustum edges from the lens and the corner rays carried down to where they meet the ground.
 */
export function CctvProjectionLayer({ map, mapLoaded, camera, visible }: Props) {
  const active = !!(map && mapLoaded && camera && visible);
  const pose = useMemo<CameraPose | null>(() => (camera ? estimatePose(camera) : null), [camera]);
  const hasStill = !!camera && camera.kind !== "location" && !!camera.imageUrl;
  const frame = useLiveFrame(active && hasStill ? camera!.id : null);
  const [aspect, setAspect] = useState(4 / 3);
  const color = camera ? CCTV_SOURCE_COLORS[camera.source] ?? "#00ffff" : "#00ffff";

  const rootRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const edgesRef = useRef<SVGPathElement>(null);
  const raysRef = useRef<SVGPathElement>(null);
  const footRef = useRef<SVGPathElement>(null);
  const apexRef = useRef<SVGCircleElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const live = useRef({ pose, aspect });
  live.current = { pose, aspect };

  useEffect(() => setAspect(4 / 3), [camera?.id]);

  useEffect(() => {
    if (!active || !map) return;
    const transform = (map as unknown as { transform: ModelTransform }).transform;
    const hide = () => {
      if (rootRef.current) rootRef.current.style.visibility = "hidden";
    };

    const update = (main: Mat) => {
      const { pose: p, aspect: ar } = live.current;
      const root = rootRef.current;
      if (!p || !root || map.getZoom() < MIN_ZOOM) return hide();

      const mpp = (EARTH_CIRCUMFERENCE_M * Math.cos((p.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      const halfTan = Math.tan((planeFovDeg(p) * Math.PI) / 360);
      const distanceM = Math.min(p.rangeM * 0.7, Math.max(6, ((TARGET_SCREEN_PX / 2) * mpp) / halfTan));
      const fr = buildFrustum(p, { distanceM, aspect: ar, viewerBearingDeg: map.getBearing() });

      const canvas = map.getCanvas();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const plane = fr.plane.map((g) => toScreen(transform, main, g, w, h));
      if (plane.some((q) => !q)) return hide();
      const quad = plane as [number, number][];
      const matrix = quadToMatrix3d(PLANE_PX, PLANE_PX / ar, quad);
      if (!matrix) return hide();

      const apex = toScreen(transform, main, fr.apex, w, h);
      const reach = fr.reach.map((g) => (g ? toScreen(transform, main, g, w, h) : null));

      root.style.visibility = "visible";
      if (planeRef.current) planeRef.current.style.transform = matrix;
      if (edgesRef.current) {
        edgesRef.current.setAttribute(
          "d",
          apex ? quad.map((q) => `M${fmt(apex)}L${fmt(q)}`).join("") : "",
        );
      }
      if (raysRef.current) {
        raysRef.current.setAttribute(
          "d",
          quad.map((q, i) => (reach[i] ? `M${fmt(q)}L${fmt(reach[i]!)}` : "")).join(""),
        );
      }
      if (footRef.current) {
        const base = toScreen(transform, main, [fr.apex[0], fr.apex[1], 0], w, h);
        const [, , br, bl] = reach;
        footRef.current.setAttribute("d", base && br && bl ? `M${fmt(base)}L${fmt(bl)}L${fmt(br)}Z` : "");
      }
      if (apexRef.current && apex) {
        apexRef.current.setAttribute("cx", apex[0].toFixed(1));
        apexRef.current.setAttribute("cy", apex[1].toFixed(1));
      }
      if (labelRef.current) {
        const top = quad[0][1] < quad[3][1] ? [quad[0], quad[1]] : [quad[3], quad[2]];
        const lx = (top[0][0] + top[1][0]) / 2;
        const ly = Math.min(top[0][1], top[1][1]);
        labelRef.current.style.transform = `translate(${lx.toFixed(1)}px, ${(ly - 10).toFixed(1)}px) translate(-50%, -100%)`;
      }
    };

    const layer: maplibregl.CustomLayerInterface = {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "3d",
      render: (_gl, args) => update(args.defaultProjectionData.mainMatrix),
    };
    if (!map.getLayer(LAYER_ID)) map.addLayer(layer);
    map.triggerRepaint();
    return () => {
      hide();
      if (map.style && map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    };
  }, [active, map]);

  useEffect(() => {
    if (active) map?.triggerRepaint();
  }, [active, map, aspect, pose]);

  if (!active || !map || !camera || !pose) return null;

  const planeH = PLANE_PX / aspect;
  const shortId = `CAM-${camera.id}`.toUpperCase();
  const lens = `HDG ${pose.headingDeg === null ? "EST" : `${Math.round(pose.headingDeg)}°`} · FOV ${Math.round(planeFovDeg(pose))}° · RANGE ${Math.round(pose.rangeM)}m`;

  return createPortal(
    <div
      ref={rootRef}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", visibility: "hidden", zIndex: 2 }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <path ref={footRef} fill={color} fillOpacity={0.1} stroke={color} strokeOpacity={0.5} strokeWidth={1} strokeDasharray="4 4" />
        <path ref={raysRef} stroke={color} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="3 5" fill="none" />
      </svg>

      <div
        ref={planeRef}
        style={{
          position: "absolute", left: 0, top: 0, width: PLANE_PX, height: planeH,
          transformOrigin: "0 0", background: "#02060a",
          outline: `2px solid ${color}`, boxShadow: `0 0 18px ${color}66`,
          fontFamily: MONO,
        }}
      >
        {frame.src ? (
          <img
            src={frame.src}
            alt=""
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                const next = img.naturalWidth / img.naturalHeight;
                setAspect((prev) => (Math.abs(prev - next) > 0.01 ? next : prev));
              }
            }}
            style={{ width: "100%", height: "100%", display: "block", objectFit: "fill", opacity: frame.offline ? 0.4 : 1 }}
          />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color, fontSize: 18, letterSpacing: 3 }}>
            {!hasStill ? (camera.kind === "location" ? "NO PUBLIC FEED" : "STREAM · SEE FEED PANEL") : frame.offline ? "FEED OFFLINE" : "ACQUIRING FEED…"}
          </div>
        )}
        <div style={{ position: "absolute", right: 10, top: "52%", color: "#e6fffb", fontSize: 13, textShadow: "0 0 4px #000, 0 0 2px #000" }}>
          {shortId}
        </div>
      </div>

      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <path ref={edgesRef} stroke={color} strokeOpacity={0.9} strokeWidth={1.2} fill="none" />
        <circle ref={apexRef} r={4} fill={color} stroke="#000" strokeWidth={1} />
      </svg>

      <div
        ref={labelRef}
        style={{
          position: "absolute", left: 0, top: 0, fontFamily: MONO, whiteSpace: "nowrap",
          background: "rgba(4,10,14,0.88)", borderLeft: `3px solid ${color}`, padding: "4px 10px",
          color: "#fff", fontSize: 13, letterSpacing: 0.5, boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
        }}
      >
        <div>{camera.name}</div>
        <div style={{ color, fontSize: 10, letterSpacing: 1.5, marginTop: 1 }}>
          {lens}{pose.headingDeg === null ? " · FACING VIEWER" : ""}
        </div>
      </div>
    </div>,
    map.getContainer(),
  );
}
