import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadGoogleTileset } from "./CinematicTracker";
import { LaunchReplayHud, type ReplayTelemetry } from "./LaunchReplayHud";
import type { VisionMode } from "../lib/vision-modes";
import { defaultPlayMode, launchTimeSec, missionClockSec, type Launch, type LaunchPlayMode } from "../lib/launches";
import { buildTrajectory, EARTH_R, phaseLabel, speedAt, toCartesian, type Geo, type Trajectory } from "../lib/launch-trajectory";
import { buildTimeline, playbackForMissionTime, sampleLive, sampleReplay, type ShotId, type ShotSample } from "../lib/launch-director";
import { rocketDataUrl } from "../lib/rocket-icon";

const FADE_MS = 600;
const INTRO_S = 3.4;
const TILES_MAX_CAM_H = 180_000;
/** Photoreal tiles replace the globe only within this distance of the pad (downrange / landing zones use the globe). */
const TILES_MAX_PAD_DIST = 35_000;
/** Google leaf tiles in photogrammetry areas are a few metres; anything coarser looks smeared at grazing angles. */
const PHOTOREAL_MAX_GEOM_ERR = 6;
const PHOTOREAL_DECIDE_MS = 30_000;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

interface Props {
  launch: Launch;
  index: number;
  count: number;
  visionMode: VisionMode;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
}

export interface ReplayControls {
  togglePause: () => void;
  setSpeed: (s: number) => void;
  seekMission: (t: number) => void;
  seekFraction: (f: number) => void;
  restart: () => void;
  setDirector: (d: "auto" | "free") => void;
  setMode: (m: LaunchPlayMode) => void;
}

const C = Cesium.Cartesian3;
const v3 = () => new Cesium.Cartesian3();
const add = (a: Cesium.Cartesian3, b: Cesium.Cartesian3) => C.add(a, b, v3());
const sub = (a: Cesium.Cartesian3, b: Cesium.Cartesian3) => C.subtract(a, b, v3());
const mul = (a: Cesium.Cartesian3, s: number) => C.multiplyByScalar(a, s, v3());
const norm = (a: Cesium.Cartesian3) => {
  const m = C.magnitude(a);
  return m > 1e-9 ? C.divideByScalar(a, m, v3()) : C.clone(C.UNIT_Z);
};
const cross = (a: Cesium.Cartesian3, b: Cesium.Cartesian3) => C.cross(a, b, v3());
const lerpV = (a: Cesium.Cartesian3, b: Cesium.Cartesian3, t: number) => C.lerp(a, b, t, v3());
const smooth = (x: number) => {
  const t = Cesium.Math.clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const css = (c: string, a = 1) => Cesium.Color.fromCssColorString(c).withAlpha(a);
const surfaceUp = (p: Cesium.Cartesian3) => Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(p, v3());

/** Rotation whose Z column is `axis` (rocket frame: Z = long axis, origin = base of the stack). */
function frameMatrix(origin: Cesium.Cartesian3, axis: Cesium.Cartesian3, hint: Cesium.Cartesian3, scale?: Cesium.Cartesian3): Cesium.Matrix4 {
  const z = norm(axis);
  let x = cross(hint, z);
  if (C.magnitude(x) < 1e-6) x = cross(C.UNIT_X, z);
  x = norm(x);
  const y = cross(z, x);
  const rot = new Cesium.Matrix3(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
  const m = Cesium.Matrix4.fromRotationTranslation(rot, origin);
  return scale ? Cesium.Matrix4.multiplyByScale(m, scale, m) : m;
}

function radialCanvas(stops: [number, string][], size = 64): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

// ---------- procedural launch vehicle ----------

interface PartSpec {
  kind: "cyl" | "box";
  z: number;
  len: number;
  top?: number;
  bottom?: number;
  dims?: [number, number];
  offset?: [number, number];
  rotZ?: number;
  color: string;
}

function partsPrimitive(parts: PartSpec[], translucent = false): Cesium.Primitive {
  const instances = parts.map((p) => {
    let m = Cesium.Matrix4.fromTranslation(new C(p.offset?.[0] ?? 0, p.offset?.[1] ?? 0, p.z));
    if (p.rotZ) m = Cesium.Matrix4.multiply(Cesium.Matrix4.fromRotation(Cesium.Matrix3.fromRotationZ(p.rotZ)), m, new Cesium.Matrix4());
    const geometry =
      p.kind === "cyl"
        ? new Cesium.CylinderGeometry({
            length: p.len,
            topRadius: p.top ?? 1,
            bottomRadius: p.bottom ?? p.top ?? 1,
            slices: 40,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          })
        : Cesium.BoxGeometry.fromDimensions({
            dimensions: new C(p.dims![0], p.dims![1], p.len),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          });
    return new Cesium.GeometryInstance({
      geometry,
      modelMatrix: m,
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(css(p.color, translucent ? 0.999 : 1)) },
    });
  });
  return new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: translucent, translucent, closed: !translucent }),
    asynchronous: false,
    allowPicking: false,
  });
}

function buildVehicle(L: number, D: number) {
  const r = D / 2;
  const WHITE = "#eef2f6";
  const SOOT = "#2a2f36";
  const BLACK = "#0d1014";
  const stage1: PartSpec[] = [
    { kind: "cyl", z: -0.012 * L, len: 0.024 * L, top: r * 0.82, bottom: r * 0.95, color: "#3b4148" },
    { kind: "cyl", z: 0.01 * L, len: 0.02 * L, top: r, bottom: r, color: SOOT },
    { kind: "cyl", z: 0.02 * L + 0.27 * L, len: 0.54 * L, top: r, bottom: r, color: WHITE },
    { kind: "cyl", z: 0.24 * L, len: 0.012 * L, top: r * 1.003, bottom: r * 1.003, color: "#c8d1da" },
    { kind: "cyl", z: 0.59 * L, len: 0.06 * L, top: r, bottom: r, color: BLACK },
  ];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    stage1.push({ kind: "box", z: 0.1 * L, len: 0.17 * L, dims: [r * 0.28, r * 0.14], offset: [Math.cos(a) * r * 1.03, Math.sin(a) * r * 1.03], rotZ: 0, color: BLACK });
    stage1.push({ kind: "box", z: 0.6 * L, len: r * 0.7, dims: [r * 0.08, r * 0.9], offset: [Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4], rotZ: a, color: "#1b1f24" });
  }
  const upper: PartSpec[] = [
    { kind: "cyl", z: 0.62 * L + 0.015 * L, len: 0.03 * L, top: r * 0.35, bottom: r * 0.78, color: "#5a3a22" },
    { kind: "cyl", z: 0.64 * L + 0.09 * L, len: 0.18 * L, top: r, bottom: r, color: WHITE },
  ];
  const fairing: PartSpec[] = [
    { kind: "cyl", z: 0.822 * L, len: 0.008 * L, top: r * 1.12, bottom: r, color: BLACK },
    { kind: "cyl", z: 0.826 * L + 0.05 * L, len: 0.1 * L, top: r * 1.12, bottom: r * 1.12, color: WHITE },
    { kind: "cyl", z: 0.926 * L + 0.037 * L, len: 0.074 * L, top: r * 0.08, bottom: r * 1.12, color: WHITE },
  ];
  const payload: PartSpec[] = [{ kind: "cyl", z: 0.86 * L, len: 0.06 * L, top: r * 0.55, bottom: r * 0.75, color: "#d4a83a" }];
  const plume: PartSpec[] = [
    { kind: "cyl", z: -0.5, len: 1, top: 1, bottom: 2.2, color: "#ff6a1a" },
    { kind: "cyl", z: -0.38, len: 0.76, top: 0.75, bottom: 1.2, color: "#ffd27a" },
    { kind: "cyl", z: -0.2, len: 0.4, top: 0.55, bottom: 0.6, color: "#ffffff" },
  ];
  // Translucent plume layers need distinct alpha; rebuild with explicit colours.
  const plumePrim = new Cesium.Primitive({
    geometryInstances: plume.map(
      (p, i) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.CylinderGeometry({ length: p.len, topRadius: p.top!, bottomRadius: p.bottom!, slices: 28, vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }),
          modelMatrix: Cesium.Matrix4.fromTranslation(new C(0, 0, p.z)),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(css(p.color, [0.28, 0.55, 0.9][i])) },
        }),
    ),
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
    asynchronous: false,
    allowPicking: false,
  });
  return {
    stage1: partsPrimitive(stage1),
    upper: partsPrimitive(upper),
    fairing: partsPrimitive(fairing),
    payload: partsPrimitive(payload),
    plume: plumePrim,
    boosterPlume: new Cesium.Primitive({
      geometryInstances: plume.map(
        (p, i) =>
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({ length: p.len, topRadius: p.top!, bottomRadius: p.bottom!, slices: 28, vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }),
            modelMatrix: Cesium.Matrix4.fromTranslation(new C(0, 0, p.z)),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(css(p.color, [0.28, 0.55, 0.9][i])) },
          }),
      ),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
      asynchronous: false,
      allowPicking: false,
    }),
  };
}

// ---------- camera poses ----------

interface Pose {
  pos: Cesium.Cartesian3;
  target: Cesium.Cartesian3;
  up: Cesium.Cartesian3;
  fov: number;
}

interface FrameCtx {
  tr: Trajectory;
  t: number;
  L: number;
  base: Cesium.Cartesian3;
  axis: Cesium.Cartesian3;
  vdir: Cesium.Cartesian3;
  center: Cesium.Cartesian3;
  padBase: Cesium.Cartesian3;
  east: Cesium.Cartesian3;
  north: Cesium.Cartesian3;
  padUp: Cesium.Cartesian3;
  booster: { base: Cesium.Cartesian3; axis: Cesium.Cartesian3 } | null;
  landing: Cesium.Cartesian3 | null;
  orbit: { center: Cesium.Cartesian3; normal: Cesium.Cartesian3; minor: Cesium.Cartesian3; fit: number };
}

const horiz = (ctx: FrameCtx, deg: number) => {
  const a = Cesium.Math.toRadians(deg);
  return add(mul(ctx.east, Math.sin(a)), mul(ctx.north, Math.cos(a)));
};

function lensFov(sizeM: number, dist: number, k: number, min = 0.35, max = 60) {
  return Cesium.Math.clamp(Cesium.Math.toDegrees(2 * Math.atan((sizeM * k) / Math.max(dist, 1))), min, max);
}

function shake(t: number, amp: number): Cesium.Cartesian3 {
  if (amp <= 0) return v3();
  return new C(
    amp * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 91.7) * 0.4),
    amp * (Math.sin(t * 41.3 + 1.3) * 0.6 + Math.sin(t * 77.9) * 0.4),
    amp * (Math.sin(t * 53.9 + 2.1) * 0.6 + Math.sin(t * 63.1) * 0.4),
  );
}

function overviewEnd(ctx: FrameCtx, extraRot: number): { pos: Cesium.Cartesian3; target: Cesium.Cartesian3; up: Cesium.Cartesian3 } {
  const { normal, minor, center, fit } = ctx.orbit;
  const tilt = Cesium.Math.toRadians(52);
  let dir = norm(add(mul(normal, Math.sin(tilt)), mul(minor, -Math.cos(tilt))));
  if (extraRot) {
    const q = Cesium.Quaternion.fromAxisAngle(normal, extraRot);
    dir = Cesium.Matrix3.multiplyByVector(Cesium.Matrix3.fromQuaternion(q), dir, v3());
  }
  const range = fit / Math.sin(Cesium.Math.toRadians(22));
  return { pos: add(center, mul(dir, range)), target: center, up: normal };
}

function computePose(shot: ShotId, s: number, ctx: FrameCtx): Pose {
  const { L, center, vdir, padBase, padUp, t } = ctx;
  const rUp = surfaceUp(center);
  const flightAz = Cesium.Math.toDegrees(ctx.tr.azimuth);
  switch (shot) {
    case "pad360": {
      const c = add(padBase, mul(padUp, L * 0.5));
      const ang = flightAz + 200 + s * 150;
      const range = L * (2.5 - 0.45 * s);
      const el = Cesium.Math.toRadians(5 + 9 * s);
      const pos = add(c, add(mul(horiz(ctx, ang), range * Math.cos(el)), mul(padUp, range * Math.sin(el))));
      return { pos, target: add(padBase, mul(padUp, L * 0.55)), up: padUp, fov: 46 - 4 * s };
    }
    case "liftoff": {
      const pos = add(add(padBase, mul(horiz(ctx, flightAz + 125), L * 3.4)), add(mul(padUp, 5), shake(t, t < 0 ? 0 : 0.35 * (1 - s * 0.6))));
      return { pos, target: add(center, mul(padUp, L * 0.1)), up: padUp, fov: 60 - 22 * s };
    }
    case "tracking": {
      const pos = add(add(padBase, mul(horiz(ctx, flightAz - 90), 6_800)), add(mul(horiz(ctx, flightAz), -1_800), mul(padUp, 70)));
      const dist = C.distance(pos, center);
      return { pos: add(pos, shake(t, 0.25)), target: center, up: padUp, fov: lensFov(L, dist, 2.6 + 1.2 * s) };
    }
    case "chase": {
      const side = norm(cross(vdir, rUp));
      const pos = add(center, add(mul(vdir, -L * (4.2 + 2.2 * s)), add(mul(side, L * 1.7), mul(rUp, -L * 0.5))));
      return { pos: add(pos, shake(t, 0.6)), target: add(center, mul(vdir, L * 0.5)), up: rUp, fov: 42 };
    }
    case "onboard": {
      let side = cross(ctx.axis, rUp);
      if (C.magnitude(side) < 1e-3) side = ctx.east;
      side = norm(side);
      const camPos = add(ctx.base, add(mul(ctx.axis, L * 0.69), mul(side, (L / 70) * 3.1)));
      const dir = norm(add(mul(ctx.axis, -1), mul(side, 0.2)));
      return { pos: add(camPos, shake(t, 0.05)), target: add(camPos, mul(dir, 100)), up: side, fov: 78 };
    }
    case "sepchase": {
      let side = cross(ctx.axis, rUp);
      if (C.magnitude(side) < 1e-3) side = ctx.east;
      side = norm(side);
      const upperC = add(ctx.base, mul(ctx.axis, L * 0.78));
      const pos = add(upperC, add(mul(side, L * 2.1), add(mul(ctx.axis, -L * (0.6 + 0.8 * s)), mul(rUp, L * 0.4))));
      return { pos, target: add(ctx.base, mul(ctx.axis, L * 0.45)), up: rUp, fov: 58 };
    }
    case "highalt": {
      const side = norm(cross(vdir, rUp));
      const pos = add(center, add(mul(side, 160_000 + 70_000 * s), add(mul(vdir, -110_000), mul(rUp, 22_000))));
      return { pos, target: add(center, mul(vdir, 40_000)), up: rUp, fov: 48 };
    }
    case "landing": {
      const b = ctx.booster;
      const site = ctx.landing ?? padBase;
      const lUp = surfaceUp(site);
      const tgt = b ? add(b.base, mul(b.axis, L * 0.3)) : site;
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(site);
      const e = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4());
      const n = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4());
      const a = Cesium.Math.toRadians(flightAz + 150);
      const h = new C(e.x * Math.sin(a) + n.x * Math.cos(a), e.y * Math.sin(a) + n.y * Math.cos(a), e.z * Math.sin(a) + n.z * Math.cos(a));
      const pos = add(site, add(mul(h, 420), mul(lUp, 28)));
      const dist = C.distance(pos, tgt);
      return { pos, target: tgt, up: lUp, fov: lensFov(L * 0.62, dist, 3.4, 1.2, 55) };
    }
    case "insertion": {
      const side = norm(cross(vdir, rUp));
      const pos = add(center, add(mul(vdir, -(70_000 + 30_000 * s)), add(mul(rUp, 26_000), mul(side, 30_000))));
      return { pos, target: center, up: rUp, fov: 46 };
    }
    case "overview": {
      const side = norm(cross(vdir, rUp));
      const start = add(center, add(mul(vdir, -100_000), add(mul(rUp, 26_000), mul(side, 30_000))));
      const end = overviewEnd(ctx, 0);
      const e = smooth(s);
      const target = lerpV(center, end.target, e);
      const d0 = sub(start, center);
      const d1 = sub(end.pos, end.target);
      const r0 = C.magnitude(d0);
      const r1 = C.magnitude(d1);
      const dir = norm(lerpV(norm(d0), norm(d1), e));
      const range = Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * smooth(Math.min(s * 1.15, 1)));
      return { pos: add(target, mul(dir, range)), target, up: norm(lerpV(rUp, end.up, e)), fov: 46 };
    }
    case "hold":
    default: {
      const end = overviewEnd(ctx, s * 0.035);
      return { ...end, fov: 46 };
    }
  }
}

/**
 * Cinematic launch replay: a Cesium scene that flies to the pad, then plays the mission as an
 * auto-directed film (pad 360°, liftoff, long-lens tracking, chase, onboard, stage separation,
 * high-altitude limb, booster landing, insertion) and finally pulls all the way out to show the
 * full ascent trajectory, booster return and the target orbit.
 */
export function LaunchReplayView({ launch, index, count, visionMode, onPrev, onNext, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<HTMLDivElement>(null);
  const boosterTagRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<ReplayControls | null>(null);
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const tr = useMemo(() => buildTrajectory(launch), [launch]);
  const timeline = useMemo(() => buildTimeline(tr), [tr]);
  const initialMode = useMemo(() => defaultPlayMode(launch), [launch]);

  const [visible, setVisible] = useState(false);
  const [telemetry, setTelemetry] = useState<ReplayTelemetry | null>(null);
  const restyleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const exit = useCallback(() => {
    setVisible(false);
    setTimeout(() => onExitRef.current(), FADE_MS);
  }, []);

  useEffect(() => {
    restyleRef.current();
  }, [visionMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    const viewer = new Cesium.Viewer(container, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      baseLayer: false,
      shouldAnimate: true,
      contextOptions: { webgl: { alpha: true } },
    });
    const scene = viewer.scene;
    const camera = scene.camera;
    scene.backgroundColor = Cesium.Color.fromCssColorString("#000004");
    // Neutral land tone (not near-black) so imagery tiles still streaming in don't read as holes.
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#3b4a45");
    scene.globe.showGroundAtmosphere = true;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.showWaterEffect = true;
    scene.globe.enableLighting = true;
    scene.globe.maximumScreenSpaceError = 1.5;
    scene.globe.preloadSiblings = true;
    scene.globe.tileCacheSize = 400;
    // Fog tints the whole ground the sky colour from launch-camera distances.
    scene.fog.enabled = false;
    scene.screenSpaceCameraController.enableInputs = false;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    (camera.frustum as Cesium.PerspectiveFrustum).far = 5e9;
    (camera.frustum as Cesium.PerspectiveFrustum).near = 0.5;

    // Local early-afternoon sun at the pad so the vehicle and pad are lit.
    const noonUtcHour = (((13.5 - launch.pad.lon / 15) % 24) + 24) % 24;
    const sun = new Date();
    sun.setUTCHours(Math.floor(noonUtcHour), Math.round((noonUtcHour % 1) * 60), 0, 0);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(sun);
    viewer.clock.multiplier = 1;

    let esri: Cesium.ImageryLayer | null = null;
    try {
      esri = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          maximumLevel: 19,
          credit: "Imagery © Esri, Maxar, Earthstar Geographics",
        }),
      );
    } catch (e) {
      console.error("Failed to add satellite imagery", e);
    }

    let tileset: Cesium.Cesium3DTileset | null = null;
    const applyStyles = () => {
      if (viewer.isDestroyed()) return;
      // A launch film reads as daylight footage; the Tactical night tint made the pad unreadable,
      // so only NOIR/NVG/FLIR etc. (CSS filters on the world wrapper) change the look here.
      if (tileset) tileset.customShader = undefined;
      if (esri) esri.brightness = visionRef.current === "tactical" ? 0.9 : 1;
    };
    restyleRef.current = applyStyles;

    const L = tr.dims.lengthM;
    const D = tr.dims.diameterM;
    const vehicle = buildVehicle(L, D);
    for (const p of Object.values(vehicle)) scene.primitives.add(p);

    const smokeImg = radialCanvas([
      [0, "rgba(255,255,255,0.95)"],
      [0.5, "rgba(255,255,255,0.45)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    const glowImg = radialCanvas([
      [0, "rgba(255,255,255,1)"],
      [0.2, "rgba(255,226,150,0.95)"],
      [0.5, "rgba(255,120,30,0.35)"],
      [1, "rgba(255,80,0,0)"],
    ]);

    const exhaust = scene.primitives.add(
      new Cesium.ParticleSystem({
        image: smokeImg,
        startColor: css("#fff1d6", 0.75),
        endColor: css("#b7bcc4", 0),
        startScale: 1,
        endScale: 5.5,
        minimumParticleLife: 1.6,
        maximumParticleLife: 3.4,
        minimumSpeed: 18,
        maximumSpeed: 45,
        imageSize: new Cesium.Cartesian2(D * 2.2, D * 2.2),
        sizeInMeters: true,
        emissionRate: 0,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)),
        lifetime: 1e9,
      }),
    ) as Cesium.ParticleSystem;
    const groundCloud = scene.primitives.add(
      new Cesium.ParticleSystem({
        image: smokeImg,
        startColor: css("#f4f1ea", 0.7),
        endColor: css("#9aa0a8", 0),
        startScale: 1,
        endScale: 6,
        minimumParticleLife: 4,
        maximumParticleLife: 9,
        minimumSpeed: 12,
        maximumSpeed: 34,
        imageSize: new Cesium.Cartesian2(L * 0.35, L * 0.35),
        sizeInMeters: true,
        emissionRate: 0,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(84)),
        lifetime: 1e9,
      }),
    ) as Cesium.ParticleSystem;
    const boosterSmoke = scene.primitives.add(
      new Cesium.ParticleSystem({
        image: smokeImg,
        startColor: css("#fff1d6", 0.7),
        endColor: css("#b7bcc4", 0),
        startScale: 1,
        endScale: 4,
        minimumParticleLife: 1.2,
        maximumParticleLife: 2.4,
        minimumSpeed: 10,
        maximumSpeed: 30,
        imageSize: new Cesium.Cartesian2(D * 2, D * 2),
        sizeInMeters: true,
        emissionRate: 0,
        emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(18)),
        lifetime: 1e9,
      }),
    ) as Cesium.ParticleSystem;

    const billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection;
    const labels = scene.primitives.add(new Cesium.LabelCollection({ scene })) as Cesium.LabelCollection;
    const lines = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;

    const nozzleGlow = billboards.add({ image: glowImg, sizeInMeters: true, width: D * 4, height: D * 4, position: C.ZERO });
    const boosterGlow = billboards.add({ image: glowImg, sizeInMeters: true, width: D * 3, height: D * 3, position: C.ZERO, show: false });
    const rocketIcon = billboards.add({
      image: rocketDataUrl("#22d3ee", { size: 48 }),
      width: 22,
      height: 33,
      position: C.ZERO,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(L * 55, Number.POSITIVE_INFINITY),
    });
    const boosterIcon = billboards.add({
      image: rocketDataUrl("#fbbf24", { size: 48, flame: false }),
      width: 16,
      height: 24,
      position: C.ZERO,
      show: false,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(L * 55, Number.POSITIVE_INFINITY),
    });

    const labelStyle = {
      font: "600 12px 'Share Tech Mono', 'Courier New', monospace",
      fillColor: css("#e6f6ff"),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: css("#02060c", 0.82),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(14, 0),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };

    // ---- static geometry: ground track / orbit / booster path ----
    const padCarto = () => toCartesian({ lat: tr.padLat, lon: tr.padLon, h: tr.groundH });
    let ascentSamples: Cesium.Cartesian3[] = [];
    let boosterSamples: Cesium.Cartesian3[] = [];
    const sampleStep = 2;
    const rebuildSamples = () => {
      ascentSamples = [];
      const end = tr.spec.kind === "suborbital" ? tr.tEnd : tr.tInsert;
      for (let t = 0; t <= end; t += sampleStep) ascentSamples.push(toCartesian(tr.geoAt(t)));
      boosterSamples = [];
      if (tr.boosterGeoAt) for (let t = tr.tSep; t <= tr.tLand; t += sampleStep) boosterSamples.push(toCartesian(tr.boosterGeoAt(t)));
    };
    rebuildSamples();

    const glow = (c: string, a: number, p = 0.22) => Cesium.Material.fromType(Cesium.Material.PolylineGlowType, { color: css(c, a), glowPower: p, taperPower: 1 });
    const dash = (c: string, a: number, len = 18) => Cesium.Material.fromType(Cesium.Material.PolylineDashType, { color: css(c, a), gapColor: Cesium.Color.TRANSPARENT, dashLength: len });

    const orbitPositions = () => tr.orbitGeo(tr.spec.kind === "transfer" ? 720 : 360).map((g) => toCartesian(g));
    const orbitLine = lines.add({ positions: orbitPositions(), width: 2.2, material: dash("#22d3ee", 0.85, 22), show: tr.spec.kind !== "suborbital" });
    const orbitGlow = lines.add({ positions: orbitLine.positions, width: 8, material: glow("#22d3ee", 0.25, 0.15), show: false });
    const ascentFuture = lines.add({ positions: ascentSamples, width: 1.6, material: dash("#7dd3fc", 0.45, 14) });
    const ascentTrail = lines.add({ positions: [ascentSamples[0], ascentSamples[1] ?? ascentSamples[0]], width: 7, material: glow("#00f0ff", 0.95, 0.28) });
    const boosterFuture = lines.add({ positions: boosterSamples.length > 1 ? boosterSamples : [C.ZERO, C.ZERO], width: 1.4, material: dash("#fbbf24", 0.5, 12), show: false });
    const boosterTrail = lines.add({ positions: [C.ZERO, C.ZERO], width: 5, material: glow("#fbbf24", 0.9, 0.25), show: false });
    const beam = lines.add({ positions: [padCarto(), toCartesian({ lat: tr.padLat, lon: tr.padLon, h: 140_000 })], width: 1.4, material: dash("#a5f3fc", 0.7, 10) });

    const padLabel = labels.add({ ...labelStyle, position: padCarto(), text: `${launch.pad.name.toUpperCase()}\nLAUNCH SITE`, fillColor: css("#a5f3fc"), distanceDisplayCondition: new Cesium.DistanceDisplayCondition(4_000, Number.POSITIVE_INFINITY) });
    const landingLabel = tr.landingGeo
      ? labels.add({
          ...labelStyle,
          position: toCartesian(tr.landingGeo),
          text: tr.landing === "EXPENDED" ? "BOOSTER IMPACT · EST." : `${(tr.landingName ?? (tr.landing === "RTLS" ? "LZ" : "DRONE SHIP")).toUpperCase()}\nRECOVERY ZONE`,
          fillColor: css("#fde68a"),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(6_000, Number.POSITIVE_INFINITY),
        })
      : null;
    const insLabel =
      tr.spec.kind !== "suborbital"
        ? labels.add({ ...labelStyle, position: toCartesian(tr.geoAt(tr.tInsert)), text: "SECO · ORBIT INSERTION", fillColor: css("#67e8f9"), show: false })
        : null;
    const apoLabel =
      tr.spec.kind === "transfer"
        ? labels.add({
            ...labelStyle,
            position: orbitLine.positions[Math.floor(orbitLine.positions.length / 2)],
            text: `APOGEE · ${Math.round(tr.spec.apogeeAltM / 1000).toLocaleString()} KM`,
            fillColor: css("#67e8f9"),
            show: false,
          })
        : null;

    // Pad ring + soft glow draped on the tiles (like the reference lens ring).
    const ringR = Math.max(140, L * 2.4);
    const ring: Cesium.Cartesian3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const cosLat = Math.max(Math.cos(tr.padLat), 0.01);
      ring.push(C.fromDegrees(launch.pad.lon + (ringR * Math.sin(a)) / (111_320 * cosLat), launch.pad.lat + (ringR * Math.cos(a)) / 111_320));
    }
    viewer.entities.add({
      polyline: { positions: ring, width: 3, clampToGround: true, classificationType: Cesium.ClassificationType.BOTH, material: new Cesium.PolylineGlowMaterialProperty({ color: css("#22d3ee", 0.95), glowPower: 0.25 }) },
    });
    viewer.entities.add({
      position: C.fromDegrees(launch.pad.lon, launch.pad.lat),
      ellipse: { semiMajorAxis: ringR, semiMinorAxis: ringR, material: css("#22d3ee", 0.08), classificationType: Cesium.ClassificationType.BOTH },
    });

    // Drone ship / landing pad.
    let deck: Cesium.Primitive | null = null;
    if (tr.landingGeo && (tr.landing === "ASDS" || tr.landing === "RTLS")) {
      const g = tr.landingGeo;
      const isShip = tr.landing === "ASDS";
      deck = scene.primitives.add(
        partsPrimitive([
          { kind: "box", z: isShip ? 2 : 0.4, len: isShip ? 5 : 0.8, dims: isShip ? [52, 90] : [90, 90], color: isShip ? "#2b3138" : "#5b636c" },
          { kind: "cyl", z: isShip ? 4.6 : 0.85, len: 0.3, top: isShip ? 16 : 30, bottom: isShip ? 16 : 30, color: "#f8fafc" },
          { kind: "cyl", z: isShip ? 4.8 : 0.95, len: 0.3, top: isShip ? 13 : 26, bottom: isShip ? 13 : 26, color: "#2b3138" },
        ]),
      ) as Cesium.Primitive;
      const placeDeck = () => {
        if (!deck) return;
        const p = toCartesian({ ...g, h: isShip ? Math.min(tr.groundH, 0) - 1.5 : tr.groundH });
        deck.modelMatrix = frameMatrix(p, surfaceUp(p), C.UNIT_Z);
      };
      placeDeck();
      (deck as unknown as { _place: () => void })._place = placeDeck;
    }

    // ---- ground height: terrain first, then the photoreal tiles ----
    let groundFromTiles = false;
    let tilesReady = false;
    let terrainGround: number | null = null;
    const onGround = (h: number) => {
      tr.setGroundHeight(h);
      rebuildSamples();
      ascentFuture.positions = ascentSamples;
      if (boosterSamples.length > 1) boosterFuture.positions = boosterSamples;
      orbitLine.positions = orbitPositions();
      orbitGlow.positions = orbitLine.positions;
      beam.positions = [padCarto(), toCartesian({ lat: tr.padLat, lon: tr.padLon, h: h + 140_000 })];
      padLabel.position = padCarto();
      (deck as unknown as { _place?: () => void } | null)?._place?.();
    };
    Cesium.createWorldTerrainAsync({ requestWaterMask: true, requestVertexNormals: true })
      .then((terrain) => {
        // The terrain globe is the ground everywhere (land and sea); the vehicle sits on this exact surface.
        if (!cancelled && !viewer.isDestroyed()) viewer.terrainProvider = terrain;
        return Cesium.sampleTerrainMostDetailed(terrain, [Cesium.Cartographic.fromRadians(tr.padLon, tr.padLat)]);
      })
      .then(([c]) => {
        if (cancelled || !c || !Number.isFinite(c.height)) return;
        terrainGround = c.height;
        if (!groundFromTiles) onGround(c.height);
      })
      .catch(() => {});
    loadGoogleTileset()
      .then((ts) => {
        if (cancelled || viewer.isDestroyed()) {
          ts.destroy();
          return;
        }
        tileset = scene.primitives.add(ts) as Cesium.Cesium3DTileset;
        tileset.maximumScreenSpaceError = 12;
        // Stream while hidden: the globe stays the ground until the pad area is genuinely high-detail.
        tileset.show = false;
        tileset.preloadWhenHidden = true;
        tileset.cullRequestsWhileMoving = false;
        applyStyles();

        // Remote pads, sea launches and slow connections only ever get coarse Google tiles (smeared, holey,
        // or missing). Measure the finest tile actually loaded at the pad and switch only when it is real 3D.
        const padC = toCartesian({ lat: tr.padLat, lon: tr.padLon, h: tr.groundH });
        let finestAtPad = Number.POSITIVE_INFINITY;
        const onTile = (tile: Cesium.Cesium3DTile) => {
          const bs = tile.boundingSphere;
          if (C.distance(bs.center, padC) - bs.radius < 250) finestAtPad = Math.min(finestAtPad, tile.geometricError);
        };
        tileset.tileLoad.addEventListener(onTile);

        const decideBy = performance.now() + PHOTOREAL_DECIDE_MS;
        const tryActivate = async () => {
          if (cancelled || viewer.isDestroyed() || !tileset) return;
          if (finestAtPad > PHOTOREAL_MAX_GEOM_ERR) {
            if (performance.now() < decideBy) setTimeout(tryActivate, 800);
            else {
              tileset.tileLoad.removeEventListener(onTile);
              scene.primitives.remove(tileset);
              tileset = null;
            }
            return;
          }
          // Sample a ring around the pad and take the lowest hit so the tower / mount are not mistaken for ground.
          const pts: Cesium.Cartographic[] = [Cesium.Cartographic.fromRadians(tr.padLon, tr.padLat)];
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            pts.push(Cesium.Cartographic.fromRadians(tr.padLon + (Math.sin(a) * 45) / (EARTH_R * Math.cos(tr.padLat)), tr.padLat + (Math.cos(a) * 45) / EARTH_R));
          }
          tileset.show = true;
          try {
            const res = await scene.sampleHeightMostDetailed(pts, [billboards, labels, lines, ...Object.values(vehicle)]);
            const hs = res.map((c) => c?.height).filter((h): h is number => Number.isFinite(h));
            const tileGround = hs.length ? Math.min(...hs) : Number.NaN;
            // Reject tiles whose surface disagrees with the terrain (half-loaded mesh, sampled the sea floor, etc.).
            if (!cancelled && Number.isFinite(tileGround) && (!terrainGround || Math.abs(tileGround - terrainGround) < 60)) {
              groundFromTiles = true;
              tilesReady = true;
              onGround(tileGround + 1);
              return;
            }
          } catch {
            /* fall through to the globe */
          }
          if (tileset && !tilesReady) tileset.show = false;
        };
        setTimeout(tryActivate, 800);
      })
      .catch((e) => {
        console.error("Failed to load Google 3D tileset; using satellite imagery only", e);
      });

    // ---- playback state ----
    const play = {
      mode: initialMode as LaunchPlayMode,
      p: 0,
      speed: 1,
      paused: false,
      director: "auto" as "auto" | "free",
      introUntil: performance.now() + INTRO_S * 1000,
      flying: true,
    };
    const free = { heading: 0, pitch: Cesium.Math.toRadians(-12), range: L * 3, dragging: false, lx: 0, ly: 0 };
    const netSec = launchTimeSec(launch);

    const sampleNow = (): ShotSample => {
      if (play.mode === "live") return sampleLive(timeline, missionClockSec(launch));
      return sampleReplay(timeline, play.p);
    };

    const stateAt = (t: number) => {
      const g = tr.geoAt(t);
      const base = toCartesian(g);
      const ahead = toCartesian(tr.geoAt(t + 0.5));
      let vdir = sub(ahead, base);
      const up = surfaceUp(base);
      if (t <= 0.3 || C.magnitude(vdir) < 1e-3) vdir = up;
      vdir = norm(vdir);
      // Pitch-over: stay vertical for the first seconds, then follow the velocity vector.
      const axis = t <= 0 ? up : norm(lerpV(up, vdir, smooth((t - 2) / 14)));
      return { g, base, vdir, axis };
    };

    const boosterStateAt = (t: number) => {
      if (!tr.boosterGeoAt || t < tr.tSep) return null;
      const g = tr.boosterGeoAt(t);
      const base = toCartesian(g);
      const next = toCartesian(tr.boosterGeoAt(t + 0.5));
      const prev = toCartesian(tr.boosterGeoAt(Math.max(tr.tSep, t - 0.5)));
      const vel = sub(next, prev);
      const sepAxis = stateAt(tr.tSep).axis;
      const flip = smooth((t - tr.tSep - 4) / 22);
      const retro = C.magnitude(vel) > 1e-3 ? norm(mul(vel, -1)) : surfaceUp(base);
      const vertical = surfaceUp(base);
      const landingBlend = smooth((t - (tr.tLand - 45)) / 35);
      let axis = norm(lerpV(sepAxis, retro, flip));
      axis = norm(lerpV(axis, vertical, landingBlend));
      return { g, base, axis, speed: C.magnitude(vel) / Math.max(1e-3, Math.min(1, t - tr.tSep + 0.5)) };
    };

    const boosterBurning = (t: number) => {
      if (!tr.boosterGeoAt || tr.landing === "EXPENDED") return false;
      const rel = t - tr.tSep;
      if (tr.landing === "RTLS" && rel > 14 && rel < 58) return true;
      if (t > tr.tLand - 130 && t < tr.tLand - 108) return true;
      return t > tr.tLand - 30 && t < tr.tLand - 1;
    };

    // Orbit framing for the overview shot.
    const periP = toCartesian(tr.geoAt(tr.tInsert));
    const padP = padCarto();
    const normal = norm(cross(padP, periP));
    const periDir = norm(periP);
    const minor = norm(cross(normal, periDir));
    const orbitCenter = tr.spec.kind === "transfer" ? mul(periDir, -tr.a * tr.e) : v3();
    const fit = tr.spec.kind === "suborbital" ? 2_500_000 : tr.spec.kind === "transfer" ? tr.a * 1.08 : (EARTH_R + tr.spec.apogeeAltM) * 1.12;

    // ---- input: free 360° camera ----
    const canvas = scene.canvas;
    const onDown = (e: PointerEvent) => {
      free.dragging = true;
      free.lx = e.clientX;
      free.ly = e.clientY;
      if (play.director === "auto") setDirector("free");
    };
    const onMove = (e: PointerEvent) => {
      if (!free.dragging) return;
      free.heading -= (e.clientX - free.lx) * 0.006;
      free.pitch = Cesium.Math.clamp(free.pitch - (e.clientY - free.ly) * 0.005, -1.5, 1.2);
      free.lx = e.clientX;
      free.ly = e.clientY;
    };
    const onUp = () => {
      free.dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (play.director === "auto") setDirector("free");
      free.range = Cesium.Math.clamp(free.range * Math.exp(e.deltaY * 0.0015), L * 1.2, 2e9);
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    let lastCut = "";
    let cutCount = 0;
    let lastHud = 0;
    let lastTrail = 0;
    let lastT = Number.NEGATIVE_INFINITY;
    let lastFrame = performance.now();
    let skyLevel = -1;
    let toast: { label: string; at: number } | null = null;

    const setCamera = (pose: Pose) => {
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      const dir = norm(sub(pose.target, pose.pos));
      let right = cross(dir, pose.up);
      if (C.magnitude(right) < 1e-6) right = cross(dir, C.UNIT_Z);
      const up = norm(cross(norm(right), dir));
      camera.setView({ destination: pose.pos, orientation: { direction: dir, up } });
      (camera.frustum as Cesium.PerspectiveFrustum).fov = Cesium.Math.toRadians(pose.fov);
    };

    // First frame: start in space above the pad, then fly down to the first shot.
    camera.setView({ destination: toCartesian({ lat: tr.padLat - 0.25, lon: tr.padLon, h: 9_000_000 }) });

    const onPreUpdate = () => {
      if (viewer.isDestroyed()) return;
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 1);
      lastFrame = now;

      if (!play.flying && play.mode !== "live" && !play.paused) {
        play.p += dt * play.speed;
      }
      const smp = sampleNow();
      const t = smp.t;

      // ---- vehicle ----
      const st = stateAt(t);
      const center = add(st.base, mul(st.axis, L * 0.5));
      const hint = surfaceUp(st.base);
      const attached = t < tr.tSep;
      const bst = boosterStateAt(t);
      const s1Matrix = attached || !bst ? frameMatrix(st.base, st.axis, hint) : frameMatrix(bst.base, bst.axis, surfaceUp(bst.base));
      vehicle.stage1.modelMatrix = s1Matrix;
      const landed = bst && t >= tr.tLand;
      vehicle.stage1.show = tr.landing !== "EXPENDED" || attached || t < tr.tSep + 90;
      if (tr.landing === "NONE" && !attached) vehicle.stage1.show = false;
      const upperM = frameMatrix(st.base, st.axis, hint);
      vehicle.upper.modelMatrix = upperM;
      vehicle.fairing.modelMatrix = upperM;
      vehicle.payload.modelMatrix = upperM;
      vehicle.fairing.show = t < tr.tFairing;
      vehicle.payload.show = t >= tr.tFairing;

      // Engine plume: stage 1 until MECO, stage 2 from SES-1 to SECO. Expands with altitude (vacuum plume).
      const meco = tr.tSep - 3;
      const s2On = tr.spec.kind !== "suborbital" && t > tr.tSep + 8 && t < tr.tInsert;
      const s1On = t >= -0.4 && t < (tr.spec.kind === "suborbital" ? 150 : meco);
      const burning = s1On || s2On;
      const altKm = (st.g.h - tr.groundH) / 1000;
      const expand = 1 + Math.min(altKm / 22, 7);
      const flicker = 0.92 + Math.sin(now * 0.045) * 0.05 + Math.sin(now * 0.11) * 0.04;
      const nozzleZ = s2On ? L * 0.62 - 0.02 * L : -0.024 * L;
      const plumeR = (s2On ? D * 0.36 : D * 0.42) * (s2On ? expand * 0.8 : Math.min(expand, 3));
      const plumeLen = D * (s2On ? 2.2 : 4.5) * (s2On ? 1 + expand * 0.5 : 1 + Math.min(altKm / 25, 2.5)) * flicker;
      const nozzle = add(st.base, mul(st.axis, nozzleZ));
      vehicle.plume.show = burning;
      vehicle.plume.modelMatrix = frameMatrix(nozzle, st.axis, hint, new C(plumeR, plumeR, plumeLen));
      nozzleGlow.show = burning;
      nozzleGlow.position = add(nozzle, mul(st.axis, -plumeLen * 0.25));
      nozzleGlow.width = nozzleGlow.height = Math.max(D * 3.5, plumeR * 5) * flicker;

      const exhaustM = frameMatrix(nozzle, mul(st.axis, -1), hint);
      exhaust.modelMatrix = exhaustM;
      exhaust.emissionRate = burning && altKm < 48 ? (altKm < 15 ? 90 : 45) : 0;
      const puff = D * 2.2 * (1 + altKm / 6);
      exhaust.minimumImageSize = new Cesium.Cartesian2(puff, puff);
      exhaust.maximumImageSize = new Cesium.Cartesian2(puff, puff);
      const padM = frameMatrix(padCarto(), surfaceUp(padCarto()), C.UNIT_Z);
      groundCloud.modelMatrix = padM;
      groundCloud.emissionRate = t > -0.6 && t < 13 ? 70 * (1 - Math.max(0, t) / 13) : 0;

      // Booster after separation.
      const bOn = !!bst && boosterBurning(t);
      if (bst) {
        const bnoz = add(bst.base, mul(bst.axis, -0.024 * L));
        vehicle.boosterPlume.show = bOn && !landed;
        vehicle.boosterPlume.modelMatrix = frameMatrix(bnoz, bst.axis, surfaceUp(bst.base), new C(D * 0.42, D * 0.42, D * 3 * flicker));
        boosterGlow.show = bOn && !landed;
        boosterGlow.position = bnoz;
        boosterSmoke.modelMatrix = frameMatrix(bnoz, mul(bst.axis, -1), surfaceUp(bst.base));
        boosterSmoke.emissionRate = bOn && bst.g.h - tr.groundH < 45_000 ? 50 : 0;
        boosterIcon.show = tr.landing !== "EXPENDED" || t < tr.tSep + 90;
        boosterIcon.position = add(bst.base, mul(bst.axis, L * 0.3));
      } else {
        vehicle.boosterPlume.show = false;
        boosterGlow.show = false;
        boosterSmoke.emissionRate = 0;
        boosterIcon.show = false;
      }
      rocketIcon.position = center;

      // ---- trails (throttled) ----
      if (now - lastTrail > 120) {
        lastTrail = now;
        const n = Math.max(0, Math.min(ascentSamples.length, Math.floor(t / sampleStep) + 1));
        const trail = ascentSamples.slice(0, n);
        if (t > 0 && t <= (tr.spec.kind === "suborbital" ? tr.tEnd : tr.tInsert)) trail.push(st.base);
        if (t > tr.tInsert && tr.spec.kind !== "suborbital") {
          // Extend the bright trail along the orbit flown so far.
          const step = Math.max(10, (t - tr.tInsert) / 300);
          for (let tt = tr.tInsert + step; tt < t; tt += step) trail.push(toCartesian(tr.geoAt(tt)));
          trail.push(st.base);
        }
        ascentTrail.positions = trail.length >= 2 ? trail : [padCarto(), padCarto()];
        if (bst && boosterSamples.length > 1) {
          const bn = Math.max(1, Math.min(boosterSamples.length, Math.floor((t - tr.tSep) / sampleStep) + 1));
          const btrail = boosterSamples.slice(0, bn);
          if (!landed) btrail.push(bst.base);
          boosterTrail.positions = btrail.length >= 2 ? btrail : [bst.base, bst.base];
          boosterTrail.show = true;
          boosterFuture.show = !landed;
        } else {
          boosterTrail.show = false;
          boosterFuture.show = !!tr.boosterGeoAt && t > 0;
        }
      }
      const wide = smp.variant === "overview" || smp.variant === "hold";
      orbitGlow.show = wide || t > tr.tInsert;
      if (insLabel) insLabel.show = wide;
      if (apoLabel) apoLabel.show = wide;

      // ---- camera ----
      const padBase = padCarto();
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(padBase);
      const col = (i: number) => {
        const c4 = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
        return new C(c4.x, c4.y, c4.z);
      };
      const ctx: FrameCtx = {
        tr,
        t,
        L,
        base: st.base,
        axis: st.axis,
        vdir: st.vdir,
        center,
        padBase,
        east: col(0),
        north: col(1),
        padUp: col(2),
        booster: bst ? { base: bst.base, axis: bst.axis } : null,
        landing: tr.landingGeo ? toCartesian({ ...tr.landingGeo, h: tr.landing === "ASDS" ? Math.min(tr.groundH, 0) : tr.groundH }) : null,
        orbit: { center: orbitCenter, normal, minor, fit },
      };

      if (play.flying) {
        if (now >= play.introUntil + 400) play.flying = false;
      } else if (play.director === "auto") {
        setCamera(computePose(smp.variant, smp.s, ctx));
      } else {
        const focus = center;
        camera.lookAt(focus, new Cesium.HeadingPitchRange(free.heading, free.pitch, free.range));
        (camera.frustum as Cesium.PerspectiveFrustum).fov = Cesium.Math.toRadians(55);
      }

      // Google tiles near the ground, Esri globe + atmosphere from altitude.
      const camH = camera.positionCartographic.height;
      const showTiles = tilesReady && camH < TILES_MAX_CAM_H && C.distance(camera.positionWC, padBase) < TILES_MAX_PAD_DIST;
      if (tileset && tilesReady) tileset.show = showTiles;
      scene.globe.show = !showTiles;

      // Cesium's sky atmosphere is near-black looking up from the surface (and gone entirely when the globe
      // is hidden for photoreal tiles), so near the ground the canvas is transparent over a CSS daylight sky
      // that fades to black space with altitude.
      const daylight = Math.round((1 - smooth(camH / 45_000)) * 50) / 50;
      if (daylight !== skyLevel) {
        skyLevel = daylight;
        scene.backgroundColor = daylight > 0 ? Cesium.Color.TRANSPARENT : Cesium.Color.fromCssColorString("#000004");
        if (scene.skyBox) scene.skyBox.show = daylight < 0.35;
        // Its dome renders as a black band just above the horizon when looking out from the surface.
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = daylight < 0.35;
        container.style.background = daylight > 0 ? skyGradient(daylight) : "#000004";
      }

      // ---- shot cut + events ----
      const cutKey = `${smp.index}:${smp.variant}`;
      if (cutKey !== lastCut) {
        if (lastCut && !smp.shot.blend) cutCount++;
        lastCut = cutKey;
      }
      for (const ev of tr.events) {
        if (lastT < ev.t && t >= ev.t && t - ev.t < 30) toast = { label: ev.label, at: now };
      }
      lastT = t;

      // ---- screen-space trackers ----
      const placeTag = (el: HTMLDivElement | null, world: Cesium.Cartesian3, show: boolean) => {
        if (!el) return;
        const sc = show ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, world) : undefined;
        if (!sc) {
          el.style.opacity = "0";
          return;
        }
        el.style.opacity = "1";
        el.style.transform = `translate(${sc.x.toFixed(1)}px, ${sc.y.toFixed(1)}px)`;
      };
      const camDist = C.distance(camera.positionWC, center);
      placeTag(trackerRef.current, center, !play.flying && camDist > L * 25);
      placeTag(boosterTagRef.current, bst ? bst.base : center, !!bst && !play.flying && C.distance(camera.positionWC, bst.base) > L * 25 && !landed);

      if (now - lastHud > 100) {
        lastHud = now;
        const speed = speedAt(tr.geoAt, Math.max(t, 0.25));
        const dr = downrangeKm(tr, st.g);
        setTelemetry({
          mode: play.mode,
          t,
          p: play.p,
          totalP: timeline.totalP,
          paused: play.paused,
          speed: play.speed,
          director: play.director,
          intro: play.flying,
          shotIndex: smp.index,
          shotCount: timeline.shots.length,
          cam: smp.shot.cam,
          shotLabel: smp.variant === smp.shot.id ? smp.shot.label : `${smp.shot.label} · ALT`,
          variant: smp.variant,
          cutCount,
          altKm,
          velMs: t <= 0 ? 0 : speed,
          downrangeKm: dr,
          phase: phaseLabel(tr, t),
          booster: bst
            ? { altKm: (bst.g.h - tr.groundH) / 1000, velMs: landed ? 0 : speedAt(tr.boosterGeoAt!, t), landed: !!landed, burning: bOn }
            : null,
          toast: toast && now - toast.at < 3200 ? toast.label : null,
          toastAt: toast?.at ?? 0,
          utcMs: (netSec + t) * 1000,
          tilesReady,
        });
      }
    };
    scene.preUpdate.addEventListener(onPreUpdate);

    // Fly from orbit down to the first shot while the tiles stream in.
    const introSample = sampleNow();
    setTimeout(() => {
      if (cancelled || viewer.isDestroyed()) return;
      const st = stateAt(introSample.t);
      const padBase = padCarto();
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(padBase);
      const col = (i: number) => {
        const c4 = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
        return new C(c4.x, c4.y, c4.z);
      };
      const pose = computePose(introSample.variant, introSample.s, {
        tr,
        t: introSample.t,
        L,
        base: st.base,
        axis: st.axis,
        vdir: st.vdir,
        center: add(st.base, mul(st.axis, L * 0.5)),
        padBase,
        east: col(0),
        north: col(1),
        padUp: col(2),
        booster: null,
        landing: null,
        orbit: { center: orbitCenter, normal, minor, fit },
      });
      const dir = norm(sub(pose.target, pose.pos));
      const up = norm(cross(norm(cross(dir, pose.up)), dir));
      if (introSample.variant === "pad360" || introSample.variant === "liftoff" || introSample.variant === "tracking") {
        camera.flyTo({ destination: pose.pos, orientation: { direction: dir, up }, duration: INTRO_S, easingFunction: Cesium.EasingFunction.QUINTIC_IN_OUT });
      } else {
        play.introUntil = performance.now();
      }
    }, 60);

    const setDirector = (d: "auto" | "free") => {
      play.director = d;
      if (d === "free") {
        const st = stateAt(sampleNow().t);
        const center = add(st.base, mul(st.axis, L * 0.5));
        free.range = Cesium.Math.clamp(C.distance(camera.positionWC, center), L * 1.5, 2e9);
        const toCam = norm(sub(camera.positionWC, center));
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
        const local = Cesium.Matrix4.multiplyByPointAsVector(inv, toCam, v3());
        free.heading = Math.atan2(-local.x, -local.y);
        free.pitch = -Math.asin(Cesium.Math.clamp(local.z, -1, 1));
      }
    };

    controlsRef.current = {
      togglePause: () => {
        if (play.mode === "live") return;
        play.paused = !play.paused;
      },
      setSpeed: (s) => {
        play.speed = s;
      },
      seekMission: (t) => {
        if (play.mode === "live") play.mode = netSec * 1000 < Date.now() ? "replay" : "simulation";
        play.p = playbackForMissionTime(timeline, t);
        lastT = t - 0.01;
      },
      seekFraction: (f) => {
        if (play.mode === "live") play.mode = netSec * 1000 < Date.now() ? "replay" : "simulation";
        play.p = Cesium.Math.clamp(f, 0, 1) * timeline.totalP;
        lastT = sampleReplay(timeline, play.p).t - 0.01;
      },
      restart: () => {
        if (play.mode === "live") play.mode = netSec * 1000 < Date.now() ? "replay" : "simulation";
        play.p = 0;
        play.paused = false;
        lastT = Number.NEGATIVE_INFINITY;
        setDirector("auto");
      },
      setDirector,
      setMode: (m) => {
        play.mode = m;
        if (m !== "live") play.p = Math.max(0, playbackForMissionTime(timeline, Math.max(-14, Math.min(missionClockSec(launch), timeline.shots[timeline.shots.length - 1].tStart))));
        else play.paused = false;
      },
    };

    return () => {
      cancelled = true;
      controlsRef.current = null;
      restyleRef.current = () => {};
      scene.preUpdate.removeEventListener(onPreUpdate);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
    // The scene is rebuilt per launch (keyed by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const c = controlsRef.current;
      if (e.key === "Escape") exit();
      else if (e.key === " ") {
        e.preventDefault();
        c?.togglePause();
      } else if (e.key === "f" || e.key === "F") c?.setDirector(telemetry?.director === "free" ? "auto" : "free");
      else if (e.key === "r" || e.key === "R") c?.restart();
      else if (e.key === "]") onNext();
      else if (e.key === "[") onPrev();
      else if (e.key === "+" || e.key === "=") {
        const i = SPEEDS.indexOf(telemetry?.speed ?? 1);
        c?.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)] ?? 1);
      } else if (e.key === "-" || e.key === "_") {
        const i = SPEEDS.indexOf(telemetry?.speed ?? 1);
        c?.setSpeed(SPEEDS[Math.max(0, i - 1)] ?? 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, onNext, onPrev, telemetry?.director, telemetry?.speed]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 6,
          background: "#000004",
          opacity: visible ? 1 : 0,
          transition: `opacity ${FADE_MS}ms ease`,
          touchAction: "none",
        }}
      />
      {createPortal(
        <LaunchReplayHud
          launch={launch}
          trajectory={tr}
          timeline={timeline}
          telemetry={telemetry}
          visible={visible}
          index={index}
          count={count}
          speeds={SPEEDS}
          trackerRef={trackerRef}
          boosterTagRef={boosterTagRef}
          controls={controlsRef}
          onPrev={onPrev}
          onNext={onNext}
          onExit={exit}
        />,
        document.body,
      )}
    </>
  );
}

function skyGradient(k: number): string {
  const mix = (rgb: [number, number, number]) => `rgb(${rgb.map((c) => Math.round(c * k)).join(",")})`;
  return `linear-gradient(to top, ${mix([196, 222, 242])} 0%, ${mix([120, 170, 220])} 38%, ${mix([46, 96, 168])} 72%, ${mix([14, 38, 86])} 100%)`;
}

function downrangeKm(tr: Trajectory, g: Geo): number {
  const dLat = g.lat - tr.padLat;
  const dLon = g.lon - tr.padLon;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(tr.padLat) * Math.cos(g.lat) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)))) / 1000;
}
