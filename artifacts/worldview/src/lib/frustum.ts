import { makeFrame, type CameraPose } from "./viewshed";

/** [lon, lat, altitude in metres above ground] */
export type GeoPoint3 = [number, number, number];

export interface CameraFrustum {
  apex: GeoPoint3;
  /** Image plane corners in TL, TR, BR, BL order. */
  plane: [GeoPoint3, GeoPoint3, GeoPoint3, GeoPoint3];
  /** Where each corner ray meets the ground within lens range; null when it points above the horizon or runs out of range. */
  reach: [GeoPoint3 | null, GeoPoint3 | null, GeoPoint3 | null, GeoPoint3 | null];
  headingDeg: number;
  tiltDeg: number;
  /** True when the feed gave no direction and the plane was turned to face the viewer instead. */
  headingAssumed: boolean;
}

/** Lens used for the projection plane when the feed has no usable FOV (omnidirectional estimate). */
const OMNI_PLANE_FOV = 62;

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

export function planeFovDeg(pose: CameraPose): number {
  return pose.fovDeg >= 360 ? OMNI_PLANE_FOV : pose.fovDeg;
}

/**
 * Builds the camera's view frustum in geographic space. The image plane sits `distanceM` in front of
 * the lens, perpendicular to the (estimated) optical axis, which is pitched down so the axis meets the
 * ground at ~35 % of the lens range — the usual framing of a traffic camera.
 */
export function buildFrustum(
  pose: CameraPose,
  { distanceM, aspect, viewerBearingDeg }: { distanceM: number; aspect: number; viewerBearingDeg: number },
): CameraFrustum {
  const headingAssumed = pose.headingDeg === null;
  const headingDeg = pose.headingDeg ?? viewerBearingDeg;
  const tiltDeg = Math.min(30, Math.max(4, (Math.atan2(pose.mountM, pose.rangeM * 0.35) * 180) / Math.PI));

  const h = (headingDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const fwdFlat: V3 = [Math.sin(h), Math.cos(h), 0];
  const right: V3 = [Math.cos(h), -Math.sin(h), 0];
  const axis: V3 = [fwdFlat[0] * Math.cos(t), fwdFlat[1] * Math.cos(t), -Math.sin(t)];
  const up: V3 = [fwdFlat[0] * Math.sin(t), fwdFlat[1] * Math.sin(t), Math.cos(t)];

  const halfW = distanceM * Math.tan((planeFovDeg(pose) * Math.PI) / 360);
  const halfH = halfW / aspect;
  const apex: V3 = [0, 0, pose.mountM];
  const center = add(apex, mul(axis, distanceM));
  const corners: V3[] = [
    add(add(center, mul(right, -halfW)), mul(up, halfH)),
    add(add(center, mul(right, halfW)), mul(up, halfH)),
    add(add(center, mul(right, halfW)), mul(up, -halfH)),
    add(add(center, mul(right, -halfW)), mul(up, -halfH)),
  ];

  const reach = corners.map((c): V3 | null => {
    const v: V3 = [c[0] - apex[0], c[1] - apex[1], c[2] - apex[2]];
    if (v[2] >= 0) return null;
    const tGround = apex[2] / -v[2];
    const tRange = pose.rangeM / Math.max(1e-6, Math.hypot(v[0], v[1]));
    if (tGround > tRange) return null;
    const p = add(apex, mul(v, tGround));
    return [p[0], p[1], 0];
  });

  const frame = makeFrame(pose.lon, pose.lat);
  const geo = (p: V3): GeoPoint3 => {
    const [lon, lat] = frame.toLonLat(p[0], p[1]);
    return [lon, lat, p[2]];
  };
  return {
    apex: geo(apex),
    plane: corners.map(geo) as CameraFrustum["plane"],
    reach: reach.map((p) => (p ? geo(p) : null)) as CameraFrustum["reach"],
    headingDeg,
    tiltDeg,
    headingAssumed,
  };
}

/**
 * CSS `matrix3d` that maps a `w`×`h` element (transform-origin 0 0) onto an arbitrary screen quad
 * (TL, TR, BR, BL). Perspective-correct: it's the projective square→quad homography (Heckbert 1989).
 * Returns null for degenerate quads.
 */
export function quadToMatrix3d(w: number, h: number, q: [number, number][]): string | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
  if (!m.every(Number.isFinite)) return null;
  return `matrix3d(${m.join(",")})`;
}
