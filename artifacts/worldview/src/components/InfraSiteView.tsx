import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadGoogleTileset, TILESET_NIGHT_SHADER } from "./CinematicTracker";
import { InfraSiteHud, type SiteCameraPreset, type SiteTelemetry } from "./InfraSiteHud";
import type { VisionMode } from "../lib/vision-modes";
import type { CableRoute, Dam, DataCenter, LandingPoint } from "../lib/infrastructure";
import { cablesNear, nearbySites, orbitFraming, type InfraSite, type NearbySite } from "../lib/infra-site";

const FADE_MS = 600;
const NEARBY_RADIUS_KM = 30;
const NEARBY_LIMIT = 60;
const STEM_LIMIT = 40;
/** One full 360° sweep at 1× speed. */
const SWEEP_PERIOD_S = 60;
/** After the user drags / zooms, the auto-orbit resumes from wherever they left the camera. */
const RESUME_AFTER_MS = 3500;
const MIN_RANGE = 60;
const MAX_RANGE = 60_000;
const INTRO_ALT = 1_400_000;

interface Props {
  site: InfraSite;
  dams: Dam[];
  datacenters: DataCenter[];
  landings: LandingPoint[];
  cables: CableRoute[];
  visionMode: VisionMode;
  onSite: (site: InfraSite) => void;
  onExit: () => void;
}

interface SceneApi {
  retarget: (site: InfraSite, nearby: NearbySite[]) => void;
  preset: (p: SiteCameraPreset) => void;
  zoom: (factor: number) => void;
  setRotating: (on: boolean) => void;
  setSpeed: (s: number) => void;
  restyle: () => void;
}

const LABEL_FONT = "600 12px 'Share Tech Mono', 'Courier New', monospace";
const css = (c: string, a = 1) => Cesium.Color.fromCssColorString(c).withAlpha(a);

function circle(lat: number, lon: number, h: number, radiusM: number, n = 72): Cesium.Cartesian3[] {
  const out: Cesium.Cartesian3[] = [];
  const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(lat)), 0.01);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Cesium.Cartesian3.fromDegrees(
      lon + (radiusM * Math.sin(a)) / (111_320 * cosLat),
      lat + (radiusM * Math.cos(a)) / 111_320,
      h,
    ));
  }
  return out;
}

/**
 * Drops the camera onto a single installation (dam, data centre, cable landing) over Google
 * Photorealistic 3D Tiles and sweeps a continuous 360° orbit around it. Every other mapped
 * installation within 30 km is drawn as a labelled stem, nearby cables are draped on the tiles,
 * and clicking a stem (or the HUD list) flies the orbit to that site.
 */
export function InfraSiteView({ site, dams, datacenters, landings, cables, visionMode, onSite, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onSiteRef = useRef(onSite);
  onSiteRef.current = onSite;

  const nearby = useMemo(
    () => nearbySites(site, { dams, datacenters, landings }, NEARBY_RADIUS_KM, NEARBY_LIMIT),
    [site, dams, datacenters, landings],
  );
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;
  const cablesRef = useRef(cables);
  cablesRef.current = cables;
  const initialSite = useRef(site);

  const [visible, setVisible] = useState(false);
  const [tilesReady, setTilesReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [rotating, setRotating] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [lens, setLens] = useState(true);
  const [telemetry, setTelemetry] = useState<SiteTelemetry>({ headingDeg: 0, pitchDeg: -28, rangeM: 0, groundM: null, sweep: 0, userControl: false });

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const exit = useCallback(() => {
    setVisible(false);
    setTimeout(() => onExitRef.current(), FADE_MS);
  }, []);

  useEffect(() => {
    apiRef.current?.restyle();
  }, [visionMode]);

  // Orbit to a newly chosen site without tearing down the viewer (tiles stay cached on the GPU).
  useEffect(() => {
    if (site.key === initialSite.current.key) return;
    initialSite.current = site;
    setLocked(false);
    apiRef.current?.retarget(site, nearbyRef.current);
  }, [site]);

  // ---- Cesium scene (mounted once) ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const first = initialSite.current;

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
    });
    const scene = viewer.scene;
    const camera = scene.camera;
    scene.backgroundColor = Cesium.Color.fromCssColorString("#02060c");
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#06121c");
    scene.fog.enabled = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    const ctrl = scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = MIN_RANGE;
    ctrl.maximumZoomDistance = MAX_RANGE;

    // Local early-afternoon sun so dam faces and rooftops are lit, not silhouetted.
    const noonUtcHour = (((13 - first.lon / 15) % 24) + 24) % 24;
    const sun = new Date();
    sun.setUTCHours(Math.floor(noonUtcHour), Math.round((noonUtcHour % 1) * 60), 0, 0);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(sun);
    viewer.clock.shouldAnimate = false;

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

    const labels = scene.primitives.add(new Cesium.LabelCollection({ scene })) as Cesium.LabelCollection;
    const points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
    const stems = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
    let tileset: Cesium.Cesium3DTileset | null = null;
    let terrain: Cesium.TerrainProvider | null = null;
    const terrainReady = Cesium.createWorldTerrainAsync()
      .then((t) => (terrain = t))
      .catch(() => null);

    // ---- orbit state ----
    const cur = { site: first, lat: first.lat, lon: first.lon, h: 0, hTarget: 0, hKnown: false };
    const framing = orbitFraming(first);
    const orbit = {
      heading: Cesium.Math.toRadians(20),
      pitch: Cesium.Math.toRadians(framing.pitchDeg),
      range: framing.range,
      targetPitch: Cesium.Math.toRadians(framing.pitchDeg),
      targetRange: framing.range,
      rotating: true,
      speed: 1,
      sweep: 0,
      mode: "intro" as "intro" | "flying" | "orbit",
    };
    const input = { down: false, wheelUntil: 0, pausedUntil: 0 };
    const pickable = new Map<string, NearbySite>();
    let focus: { stem: Cesium.Polyline; point: Cesium.PointPrimitive; label: Cesium.Label; stemH: number; key: string } | null = null;
    /** The terrain estimate can sit metres below the photogrammetry; move the focus marker onto the real surface. */
    const placeFocus = (s: InfraSite, h: number) => {
      if (!focus || focus.key !== s.key) return;
      const base = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h);
      const top = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h + focus.stemH);
      focus.stem.positions = [base, top];
      focus.point.position = base;
      focus.label.position = top;
    };
    let siteEntities: Cesium.Entity[] = [];
    let buildToken = 0;

    camera.setView({ destination: Cesium.Cartesian3.fromDegrees(first.lon, first.lat, INTRO_ALT) });

    const applyStyles = () => {
      if (viewer.isDestroyed()) return;
      const tactical = visionRef.current === "tactical";
      if (tileset) tileset.customShader = tactical ? TILESET_NIGHT_SHADER : undefined;
      if (esri) esri.brightness = tactical ? 0.45 : 1;
    };

    const centerCartesian = () => Cesium.Cartesian3.fromDegrees(cur.lon, cur.lat, cur.h);

    const sampleTerrain = async (cartos: Cesium.Cartographic[]): Promise<(number | null)[]> => {
      await terrainReady;
      if (!terrain || cancelled) return cartos.map(() => null);
      try {
        const res = await Cesium.sampleTerrainMostDetailed(terrain, cartos);
        return res.map((c) => (Number.isFinite(c.height) ? c.height : null));
      } catch {
        return cartos.map(() => null);
      }
    };

    /** Fast ground estimate from Cesium World Terrain, used to start the fly-in immediately. */
    const terrainGround = async (s: InfraSite) => {
      const [th] = await sampleTerrain([Cesium.Cartographic.fromDegrees(s.lon, s.lat)]);
      if (cancelled || cur.site.key !== s.key) return;
      if (th !== null && !cur.hKnown) {
        cur.hTarget = th;
        if (orbit.mode !== "orbit") cur.h = th;
      }
    };

    /** Exact photogrammetry surface under the site; the orbit centre eases onto it once known. */
    const resolveGround = async (s: InfraSite) => {
      if (!tileset) return;
      try {
        const [c] = await scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(s.lon, s.lat)], [labels, points, stems]);
        if (cancelled || cur.site.key !== s.key || !c || !Number.isFinite(c.height)) return;
        cur.hTarget = c.height;
        cur.hKnown = true;
        placeFocus(s, c.height);
      } catch {
        /* terrain estimate stays */
      }
    };

    const clearMarkers = () => {
      labels.removeAll();
      points.removeAll();
      stems.removeAll();
      for (const e of siteEntities) viewer.entities.remove(e);
      siteEntities = [];
      pickable.clear();
      focus = null;
    };

    const buildMarkers = async (s: InfraSite, list: NearbySite[]) => {
      const token = ++buildToken;
      clearMarkers();
      const fr = orbitFraming(s);
      const color = css(s.color);

      // Target ring + soft fill draped on the tiles around the focus site.
      const ringR = Math.max(50, fr.range * 0.09);
      siteEntities.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
          ellipse: {
            semiMajorAxis: ringR,
            semiMinorAxis: ringR,
            material: color.withAlpha(0.07),
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
        viewer.entities.add({
          polyline: {
            positions: circle(s.lat, s.lon, 0, ringR),
            width: 3,
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
            material: new Cesium.PolylineGlowMaterialProperty({ color: color.withAlpha(0.95), glowPower: 0.25 }),
          },
        }),
      );

      for (const c of cablesNear(s, cablesRef.current, NEARBY_RADIUS_KM)) {
        siteEntities.push(
          viewer.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(c.coords.flat()),
              width: 4,
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
              material: new Cesium.PolylineGlowMaterialProperty({ color: css("#22d3ee", 0.9), glowPower: 0.2 }),
            },
          }),
        );
      }

      const stemList = list.slice(0, STEM_LIMIT);
      const cartos = [s, ...stemList].map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
      const heights = await sampleTerrain(cartos);
      if (cancelled || token !== buildToken || viewer.isDestroyed()) return;
      const ground = (i: number) => heights[i] ?? cur.hTarget;

      const focusGround = cur.hKnown ? cur.hTarget : ground(0);
      const focusBase = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, focusGround);
      const focusTop = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, focusGround + fr.range * 0.16);
      focus = {
        stem: stems.add({ positions: [focusBase, focusTop], width: 3, material: Cesium.Material.fromType("Color", { color }) }),
        point: points.add({ position: focusBase, pixelSize: 11, color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }),
        label: null as unknown as Cesium.Label,
        stemH: fr.range * 0.16,
        key: s.key,
      };
      focus.label = labels.add({
        position: focusTop,
        text: `${s.name.toUpperCase()}\n${s.kindLabel}${s.subtitle ? ` · ${s.subtitle}` : ""}`,
        font: "600 13px 'Share Tech Mono', 'Courier New', monospace",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: css("#02060c", 0.82),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });

      stemList.forEach((n, i) => {
        const g = ground(i + 1);
        const stemH = Math.min(Math.max(n.distKm * 1000 * 0.045, 50), 1100) * (0.6 + n.rank * 0.2);
        const c = css(n.color);
        const base = Cesium.Cartesian3.fromDegrees(n.lon, n.lat, g);
        const top = Cesium.Cartesian3.fromDegrees(n.lon, n.lat, g + stemH);
        stems.add({ id: n.key, positions: [base, top], width: 2, material: Cesium.Material.fromType("Color", { color: c.withAlpha(0.85) }) });
        points.add({ id: n.key, position: base, pixelSize: 7, color: c, outlineColor: css("#dbeafe"), outlineWidth: 1.2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
        labels.add({
          id: n.key,
          position: top,
          text: n.name,
          font: LABEL_FONT,
          fillColor: css("#e6f6ff"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: css("#0b1622", 0.72),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -4),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1_500, 1, 40_000, 0.7),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 90_000),
        });
        pickable.set(n.key, n);
      });
    };

    const flyToSite = (s: InfraSite, duration: number) => {
      const fr = orbitFraming(s);
      orbit.mode = "flying";
      orbit.targetPitch = Cesium.Math.toRadians(fr.pitchDeg);
      orbit.targetRange = fr.range;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(s.lon, s.lat, cur.h), 1), {
        offset: new Cesium.HeadingPitchRange(orbit.heading, orbit.targetPitch, fr.range),
        duration,
        complete: () => {
          if (cancelled || cur.site.key !== s.key) return;
          orbit.pitch = orbit.targetPitch;
          orbit.range = fr.range;
          orbit.sweep = 0;
          orbit.mode = "orbit";
          setLocked(true);
        },
        cancel: () => {
          if (!cancelled && cur.site.key === s.key) orbit.mode = "orbit";
        },
      });
    };

    const startSite = async (s: InfraSite, list: NearbySite[], duration: number) => {
      cur.site = s;
      cur.lat = s.lat;
      cur.lon = s.lon;
      cur.hKnown = false;
      void buildMarkers(s, list);
      await terrainGround(s).catch(() => {});
      if (cancelled || cur.site.key !== s.key) return;
      cur.h = cur.hTarget;
      flyToSite(s, duration);
      void resolveGround(s);
    };

    loadGoogleTileset()
      .then((ts) => {
        if (cancelled || viewer.isDestroyed()) {
          ts.destroy();
          return;
        }
        tileset = scene.primitives.add(ts) as Cesium.Cesium3DTileset;
        // Wherever the geoid is negative the ellipsoid pokes through the tiles; hide it.
        scene.globe.show = false;
        applyStyles();
        setTilesReady(true);
        void resolveGround(cur.site);
      })
      .catch((e) => {
        console.error("Failed to load Google 3D tileset; using satellite imagery only", e);
        setTilesReady(true);
      });

    void startSite(first, nearbyRef.current, 3.6);

    // ---- input: any drag / wheel hands the camera to the user, orbit resumes from there ----
    const canvas = scene.canvas;
    const onDown = () => {
      input.down = true;
    };
    const onUp = () => {
      if (!input.down) return;
      input.down = false;
      input.pausedUntil = performance.now() + RESUME_AFTER_MS;
    };
    const onWheel = () => {
      input.wheelUntil = performance.now() + 900;
      input.pausedUntil = performance.now() + RESUME_AFTER_MS;
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: true });

    const handler = new Cesium.ScreenSpaceEventHandler(canvas);
    handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
      const picked = scene.pick(e.position) as { id?: unknown } | undefined;
      const n = typeof picked?.id === "string" ? pickable.get(picked.id) : undefined;
      if (n) onSiteRef.current(n);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e: { endPosition: Cesium.Cartesian2 }) => {
      const picked = scene.pick(e.endPosition) as { id?: unknown } | undefined;
      canvas.style.cursor = typeof picked?.id === "string" && pickable.has(picked.id) ? "pointer" : "";
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // ---- per-frame orbit ----
    const hpr = new Cesium.HeadingPitchRange();
    let last = performance.now();
    let lastHud = 0;
    const onPreRender = () => {
      if (viewer.isDestroyed()) return;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      if (orbit.mode !== "orbit") return;

      cur.h += (cur.hTarget - cur.h) * (1 - Math.exp(-dt / 0.8));
      const userControl = input.down || now < input.wheelUntil;

      if (userControl) {
        // Read the user's camera back into the orbit so auto-rotation continues seamlessly.
        orbit.heading = camera.heading;
        orbit.pitch = camera.pitch;
        orbit.range = Cesium.Cartesian3.magnitude(camera.position);
        orbit.targetPitch = orbit.pitch;
        orbit.targetRange = orbit.range;
      } else {
        if (orbit.rotating && now >= input.pausedUntil) {
          const step = ((Math.PI * 2) / SWEEP_PERIOD_S) * orbit.speed * dt;
          orbit.heading = (orbit.heading + step) % (Math.PI * 2);
          orbit.sweep += step;
        }
        const ease = 1 - Math.exp(-dt / 0.7);
        orbit.pitch += (orbit.targetPitch - orbit.pitch) * ease;
        orbit.range += (orbit.targetRange - orbit.range) * ease;
        hpr.heading = orbit.heading;
        hpr.pitch = Cesium.Math.clamp(orbit.pitch, -Cesium.Math.PI_OVER_TWO + 0.001, -0.02);
        hpr.range = Cesium.Math.clamp(orbit.range, MIN_RANGE, MAX_RANGE);
        camera.lookAt(centerCartesian(), hpr);
      }

      if (now - lastHud > 200) {
        lastHud = now;
        setTelemetry({
          headingDeg: (Cesium.Math.toDegrees(camera.heading) + 360) % 360,
          pitchDeg: Cesium.Math.toDegrees(camera.pitch),
          rangeM: Cesium.Cartesian3.magnitude(camera.position),
          groundM: cur.hKnown ? cur.h : null,
          sweep: orbit.sweep / (Math.PI * 2),
          userControl: userControl || now < input.pausedUntil,
        });
      }
    };
    scene.preRender.addEventListener(onPreRender);

    apiRef.current = {
      retarget: (s, list) => void startSite(s, list, 2.6),
      preset: (p) => {
        const fr = orbitFraming(cur.site);
        input.pausedUntil = 0;
        if (p === "top") {
          orbit.targetPitch = Cesium.Math.toRadians(-89);
          orbit.targetRange = fr.range * 1.5;
        } else if (p === "low") {
          orbit.targetPitch = Cesium.Math.toRadians(-9);
          orbit.targetRange = fr.range * 0.7;
        } else if (p === "wide") {
          orbit.targetPitch = Cesium.Math.toRadians(-38);
          orbit.targetRange = fr.range * 4;
        } else {
          orbit.targetPitch = Cesium.Math.toRadians(fr.pitchDeg);
          orbit.targetRange = fr.range;
        }
      },
      zoom: (factor) => {
        input.pausedUntil = 0;
        orbit.targetRange = Cesium.Math.clamp(orbit.targetRange * factor, MIN_RANGE, MAX_RANGE);
      },
      setRotating: (on) => {
        orbit.rotating = on;
        input.pausedUntil = 0;
      },
      setSpeed: (sp) => {
        orbit.speed = sp;
      },
      restyle: applyStyles,
    };

    return () => {
      cancelled = true;
      apiRef.current = null;
      scene.preRender.removeEventListener(onPreRender);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      handler.destroy();
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    apiRef.current?.setRotating(rotating);
  }, [rotating]);
  useEffect(() => {
    apiRef.current?.setSpeed(speed);
  }, [speed]);

  // Keyboard: Esc exit, Space pause, +/- zoom, 1-4 views, [ ] previous / next nearby site.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") exit();
      else if (e.key === " ") {
        e.preventDefault();
        setRotating((r) => !r);
      } else if (e.key === "+" || e.key === "=") apiRef.current?.zoom(0.75);
      else if (e.key === "-" || e.key === "_") apiRef.current?.zoom(1.33);
      else if (e.key === "1") apiRef.current?.preset("orbit");
      else if (e.key === "2") apiRef.current?.preset("low");
      else if (e.key === "3") apiRef.current?.preset("top");
      else if (e.key === "4") apiRef.current?.preset("wide");
      else if (e.key === "]" && nearbyRef.current[0]) onSiteRef.current(nearbyRef.current[0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 6,
          background: "#000005",
          opacity: visible ? 1 : 0,
          transition: `opacity ${FADE_MS}ms ease`,
          touchAction: "none",
        }}
      />
      {lens && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 7,
            pointerEvents: "none",
            opacity: visible ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease`,
            background: "radial-gradient(circle at 50% 52%, transparent 0, transparent 44vmin, rgba(0,255,255,0.35) 44.2vmin, rgba(0,0,0,0.55) 44.6vmin, rgba(1,3,6,0.94) 47vmin)",
          }}
        />
      )}
      {createPortal(
        <InfraSiteHud
          site={site}
          nearby={nearby}
          telemetry={telemetry}
          tilesReady={tilesReady}
          locked={locked}
          rotating={rotating}
          speed={speed}
          lens={lens}
          visible={visible}
          onToggleRotate={() => setRotating((r) => !r)}
          onSpeed={setSpeed}
          onLens={setLens}
          onPreset={(p) => apiRef.current?.preset(p)}
          onZoom={(f) => apiRef.current?.zoom(f)}
          onSite={onSite}
          onExit={exit}
        />,
        document.body,
      )}
    </>
  );
}
