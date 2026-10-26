import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadGoogleTileset, TILESET_NIGHT_SHADER } from "./CinematicTracker";
import { Route3DHud, type RoutePhase, type RouteTelemetry } from "./Route3DHud";
import type { VisionMode } from "../lib/vision-modes";
import { route3d, useRoute3D, type Route3D } from "../lib/route-3d";
import { angleDelta, buildFlightPath, easeInOut, flightFraming, type PathPoint } from "../lib/route-flight";

const FADE_MS = 600;
const INTRO_FLY_S = 2.8;
const OVERVIEW_FLY_S = 3.2;
/** The camera yaws gently around the subject so the shot never reads as a static chase cam. */
const SWAY_RAD = 0.14;
const ARRIVAL_ORBIT_RAD_PER_S = 0.09;

/** Screen-space error targets: sharper while the camera is still, slightly relaxed while it moves. */
const SSE_STILL = 4;
const SSE_FLYING = 6;
/** Hold the start of the flight until the first street-level tiles have streamed in. */
const PRELOAD_MAX_MS = 6000;

const css = (c: string, a = 1) => Cesium.Color.fromCssColorString(c).withAlpha(a);

// Google serves photogrammetry from one host; Cesium's default of 18 parallel requests starves a moving camera.
Cesium.RequestScheduler.maximumRequests = Math.max(Cesium.RequestScheduler.maximumRequests, 96);
Cesium.RequestScheduler.requestsByServer["tile.googleapis.com:443"] = 48;

/** Keep refining while the camera moves instead of cancelling requests mid-flight. */
function tuneTilesetForFlight(ts: Cesium.Cesium3DTileset) {
  ts.maximumScreenSpaceError = SSE_STILL;
  ts.cullRequestsWhileMoving = false;
  ts.foveatedScreenSpaceError = false;
  ts.dynamicScreenSpaceError = true;
  ts.dynamicScreenSpaceErrorDensity = 0.0002;
  ts.dynamicScreenSpaceErrorFactor = 12;
  ts.preloadFlightDestinations = true;
  ts.preferLeaves = true;
  ts.cacheBytes = 1536 * 1024 * 1024;
  ts.maximumCacheOverflowBytes = 1024 * 1024 * 1024;
}
const toCart = (p: PathPoint, lift = 0) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + lift);

interface SceneApi {
  fly: (durationSec?: number) => void;
  togglePause: () => void;
  overview: () => void;
  restyle: () => void;
}

/** Mounted once in WorldviewMap; shows the 3D route view whenever the copilot opens a route. */
export function Route3DLayer({ visionMode }: { visionMode: VisionMode }) {
  const { route, flight } = useRoute3D();
  if (!route) return null;
  return <Route3DView key={route.id} route={route} flight={flight} visionMode={visionMode} />;
}

interface Props {
  route: Route3D;
  flight: { seq: number; durationSec?: number } | null;
  visionMode: VisionMode;
}

/**
 * Drapes an AI-drawn route over Google Photorealistic 3D Tiles and, on "fly the route", flies a
 * cinematic drone camera along it: eased take-off, smoothed chase through the street canyon, automatic
 * climb when a tower blocks the shot, and a slow orbit over the destination on arrival.
 */
function Route3DView({ route, flight, visionMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const routeRef = useRef(route);

  const [visible, setVisible] = useState(false);
  const [telemetry, setTelemetry] = useState<RouteTelemetry>({
    phase: "loading",
    progress: 0,
    aglM: null,
    headingDeg: 0,
    tilesReady: false,
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const exit = useCallback(() => {
    setVisible(false);
    setTimeout(() => route3d.close(), FADE_MS);
  }, []);

  useEffect(() => {
    apiRef.current?.restyle();
  }, [visionMode]);

  // ---- Cesium scene (mounted once per route) ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const r = routeRef.current;
    const framing = flightFraming(r.distanceKm * 1000);
    const path = buildFlightPath(r.coords, framing);

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
      msaaSamples: 4,
      useBrowserRecommendedResolution: false,
    });
    const dpr = window.devicePixelRatio || 1;
    viewer.resolutionScale = dpr > 2 ? 2 / dpr : 1;
    const scene = viewer.scene;
    const camera = scene.camera;
    const ctrl = scene.screenSpaceCameraController;
    scene.backgroundColor = css("#02060c");
    scene.globe.baseColor = css("#06121c");
    scene.fog.enabled = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    // FXAA smears photogrammetry textures; use MSAA when the GPU supports it.
    scene.postProcessStages.fxaa.enabled = !scene.msaaSupported;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    ctrl.minimumZoomDistance = 40;

    // Local early-afternoon sun so facades along the route are lit rather than silhouetted.
    const mid = path.cameraAt(path.length / 2);
    const noonUtcHour = (((14 - mid.lon / 15) % 24) + 24) % 24;
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

    // ---- route geometry draped on the photogrammetry ----
    const color = css(r.color);
    const flat = r.coords.flat();
    viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: 14,
        clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH,
        material: new Cesium.PolylineGlowMaterialProperty({ color: color.withAlpha(0.95), glowPower: 0.22 }),
      },
    });
    const endpoints = [
      r.from ?? { name: "Start", lon: r.coords[0][0], lat: r.coords[0][1] },
      r.to ?? { name: "Destination", lon: r.coords[r.coords.length - 1][0], lat: r.coords[r.coords.length - 1][1] },
    ];
    endpoints.forEach((p, i) => {
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: {
          pixelSize: 13,
          color: i === 0 ? css("#ffffff") : color,
          outlineColor: i === 0 ? color : css("#ffffff"),
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${i === 0 ? "START" : "END"} · ${p.name.toUpperCase()}`,
          font: "600 13px 'Share Tech Mono', 'Courier New', monospace",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: css("#02060c", 0.82),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });

    // The moving subject (walker / car) the drone is chasing.
    const points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
    const subject = points.add({
      position: toCart(path.subjectAt(0), 2),
      pixelSize: 11,
      color: css("#ffffff"),
      outlineColor: color,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: false,
    });

    let tileset: Cesium.Cesium3DTileset | null = null;
    const streaming = { pending: 0 };
    const setDetail = (moving: boolean) => {
      if (tileset) tileset.maximumScreenSpaceError = moving ? SSE_FLYING : SSE_STILL;
    };
    const waitForTiles = (maxMs: number) =>
      new Promise<void>((resolve) => {
        const startedAt = performance.now();
        const poll = () => {
          if (cancelled) return resolve();
          const settled = !tileset || (tileset.tilesLoaded && streaming.pending < 4);
          if (settled || performance.now() - startedAt > maxMs) return resolve();
          setTimeout(poll, 120);
        };
        poll();
      });
    const applyStyles = () => {
      if (viewer.isDestroyed()) return;
      const tactical = visionRef.current === "tactical";
      if (tileset) tileset.customShader = tactical ? TILESET_NIGHT_SHADER : undefined;
      if (esri) esri.brightness = tactical ? 0.45 : 1;
    };

    // ---- ground heights along the path (Cesium World Terrain; tiles refine via collision checks) ----
    const heightsReady = Cesium.createWorldTerrainAsync()
      .then(async (terrain) => {
        const cartos = path.samples().map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
        const res = await Cesium.sampleTerrainMostDetailed(terrain, cartos);
        if (!cancelled) path.setHeights(res.map((c) => (Number.isFinite(c.height) ? c.height : null)));
      })
      .catch((e) => console.error("Route terrain sampling failed; flying at ellipsoid height", e));

    const fl = {
      phase: "loading" as RoutePhase,
      t: 0,
      duration: framing.durationSec,
      heading: 0,
      sway: 0,
      pitchExtra: 0,
      pitchExtraTarget: 0,
      orbitHeading: 0,
      orbitRange: framing.range,
      frame: 0,
      aglM: null as number | null,
      token: 0,
      speed: 1,
    };
    const setPhase = (p: RoutePhase) => {
      fl.phase = p;
      setDetail(p === "flying" || p === "intro");
      setTelemetry((t) => ({ ...t, phase: p }));
    };
    const releaseCamera = () => {
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      ctrl.enableInputs = true;
    };

    const routeSphere = () => {
      const pts: Cesium.Cartesian3[] = [];
      const stride = Math.max(1, Math.floor(path.count / 120));
      for (let i = 0; i < path.count; i += stride) pts.push(toCart(path.subjectAt((i / (path.count - 1)) * path.length)));
      pts.push(toCart(path.subjectAt(path.length)));
      return Cesium.BoundingSphere.fromPoints(pts);
    };

    const overview = (duration: number) => {
      const token = ++fl.token;
      releaseCamera();
      subject.show = false;
      const sphere = routeSphere();
      const startHeading = path.headingBetween(path.cameraAt(0), path.cameraAt(path.length)) ?? 0;
      camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(startHeading + 0.5, Cesium.Math.toRadians(-38), Math.max(sphere.radius * 2.6, 700)),
        duration,
        complete: () => {
          if (!cancelled && token === fl.token) setPhase("overview");
        },
      });
    };

    const startFlight = async (durationSec?: number) => {
      const token = ++fl.token;
      setPhase("intro");
      // Wait briefly for real ground heights so the drone doesn't start inside the street.
      await Promise.race([heightsReady, new Promise((res) => setTimeout(res, 4000))]);
      if (cancelled || token !== fl.token) return;
      fl.duration = durationSec && durationSec > 5 ? durationSec : framing.durationSec;
      fl.t = 0;
      fl.speed = 1;
      fl.pitchExtra = 0;
      fl.pitchExtraTarget = 0;
      const start = path.cameraAt(0);
      const beginFlying = async () => {
        await waitForTiles(PRELOAD_MAX_MS);
        if (!cancelled && token === fl.token) setPhase("flying");
      };
      fl.heading = path.headingBetween(start, path.cameraAt(framing.lookAhead)) ?? 0;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      ctrl.enableInputs = false;
      subject.position = toCart(path.subjectAt(0), 2);
      subject.show = true;
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(toCart(start), 1), {
        offset: new Cesium.HeadingPitchRange(fl.heading, framing.pitch, framing.range),
        duration: INTRO_FLY_S,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        complete: () => void beginFlying(),
        cancel: () => void beginFlying(),
      });
    };

    camera.setView({ destination: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat, 60_000) });
    overview(OVERVIEW_FLY_S);

    loadGoogleTileset()
      .then((ts) => {
        if (cancelled || viewer.isDestroyed()) {
          ts.destroy();
          return;
        }
        tuneTilesetForFlight(ts);
        ts.loadProgress.addEventListener((pending: number, processing: number) => {
          streaming.pending = pending + processing;
        });
        tileset = scene.primitives.add(ts) as Cesium.Cesium3DTileset;
        setDetail(fl.phase === "flying" || fl.phase === "intro");
        // Wherever the geoid is negative the ellipsoid pokes through the tiles; hide it.
        scene.globe.show = false;
        applyStyles();
        setTelemetry((t) => ({ ...t, tilesReady: true }));
      })
      .catch((e) => {
        console.error("Failed to load Google 3D tileset; using satellite imagery only", e);
        setTelemetry((t) => ({ ...t, tilesReady: true }));
      });

    // ---- per-frame drone camera ----
    const hpr = new Cesium.HeadingPitchRange();
    let last = performance.now();
    let lastHud = 0;
    let progress = 0;

    /** Climb (steeper pitch) whenever the camera would sit inside or skim a building. */
    const checkClearance = () => {
      if (++fl.frame % 4 !== 0 || !scene.sampleHeightSupported) return;
      const c = camera.positionCartographic;
      const surf = scene.sampleHeight(c, [points]);
      if (surf === undefined) return;
      const clear = c.height - surf;
      fl.aglM = clear;
      fl.pitchExtraTarget = clear < framing.clearance ? Math.min(0.8, fl.pitchExtraTarget + 0.07) : Math.max(0, fl.pitchExtraTarget - 0.012);
    };

    const onPreRender = () => {
      if (viewer.isDestroyed()) return;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      if (fl.phase === "flying") {
        // Ease off the throttle while the next blocks are still streaming so buildings arrive sharp.
        const backlog = streaming.pending;
        const targetSpeed = backlog > 80 ? 0.3 : backlog > 40 ? 0.55 : backlog > 15 ? 0.8 : 1;
        fl.speed += (targetSpeed - fl.speed) * (1 - Math.exp(-dt / 0.9));
        fl.t += dt * fl.speed;
        const u = Math.min(1, fl.t / fl.duration);
        const s = easeInOut(u) * path.length;
        progress = u;
        const target = path.cameraAt(s);
        const desired = path.headingBetween(target, path.cameraAt(s + framing.lookAhead));
        if (desired !== null) fl.heading += angleDelta(fl.heading, desired) * (1 - Math.exp(-dt / 1.1));
        fl.sway = Math.sin(fl.t * 0.21) * SWAY_RAD * Math.sin(Math.PI * u);
        checkClearance();
        fl.pitchExtra += (fl.pitchExtraTarget - fl.pitchExtra) * (1 - Math.exp(-dt / 0.6));
        hpr.heading = fl.heading + fl.sway;
        hpr.pitch = Cesium.Math.clamp(framing.pitch - fl.pitchExtra, -1.4, -0.12);
        hpr.range = framing.range * (1 + 0.07 * Math.sin(fl.t * 0.13));
        camera.lookAt(toCart(target), hpr);
        subject.position = toCart(path.subjectAt(s), 2);
        if (u >= 1) {
          fl.orbitHeading = hpr.heading;
          fl.orbitRange = hpr.range;
          setPhase("arrived");
        }
      } else if (fl.phase === "arrived") {
        const end = path.cameraAt(path.length);
        fl.orbitHeading += ARRIVAL_ORBIT_RAD_PER_S * dt;
        fl.orbitRange += (framing.range * 1.35 - fl.orbitRange) * (1 - Math.exp(-dt / 2));
        checkClearance();
        fl.pitchExtra += (fl.pitchExtraTarget - fl.pitchExtra) * (1 - Math.exp(-dt / 0.6));
        hpr.heading = fl.orbitHeading;
        hpr.pitch = Cesium.Math.clamp(-0.5 - fl.pitchExtra, -1.4, -0.12);
        hpr.range = fl.orbitRange;
        camera.lookAt(toCart(end), hpr);
        progress = 1;
      }

      if (now - lastHud > 200) {
        lastHud = now;
        setTelemetry((t) => ({
          ...t,
          progress,
          aglM: fl.phase === "flying" || fl.phase === "arrived" ? fl.aglM : null,
          headingDeg: (Cesium.Math.toDegrees(camera.heading) + 360) % 360,
        }));
      }
    };
    scene.preRender.addEventListener(onPreRender);

    apiRef.current = {
      fly: (d) => void startFlight(d),
      togglePause: () => {
        if (fl.phase === "flying") setPhase("paused");
        else if (fl.phase === "paused") setPhase("flying");
      },
      overview: () => {
        progress = 0;
        overview(2.2);
      },
      restyle: applyStyles,
    };

    return () => {
      cancelled = true;
      apiRef.current = null;
      scene.preRender.removeEventListener(onPreRender);
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // A new flight request (from the copilot or the HUD) restarts the drone; clearing it returns to overview.
  const flightSeq = flight?.seq ?? null;
  const flightDuration = flight?.durationSec;
  const hadFlight = useRef(false);
  useEffect(() => {
    if (flightSeq !== null) {
      hadFlight.current = true;
      apiRef.current?.fly(flightDuration);
    } else if (hadFlight.current) {
      hadFlight.current = false;
      apiRef.current?.overview();
    }
  }, [flightSeq, flightDuration]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") exit();
      else if (e.key === " ") {
        e.preventDefault();
        apiRef.current?.togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  const cinematic = telemetry.phase === "intro" || telemetry.phase === "flying" || telemetry.phase === "paused" || telemetry.phase === "arrived";

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
      {/* Letterbox bars for the drone shot */}
      {(["top", "bottom"] as const).map((edge) => (
        <div
          key={edge}
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            [edge]: 0,
            height: "9vh",
            zIndex: 7,
            pointerEvents: "none",
            background: "#000",
            transform: `translateY(${cinematic && visible ? 0 : edge === "top" ? "-100%" : "100%"})`,
            transition: "transform 900ms cubic-bezier(.2,.7,.2,1)",
          }}
        />
      ))}
      {createPortal(
        <Route3DHud
          route={route}
          telemetry={telemetry}
          visible={visible}
          onFly={() => route3d.fly()}
          onPause={() => apiRef.current?.togglePause()}
          onOverview={() => route3d.stop()}
          onExit={exit}
        />,
        document.body,
      )}
    </>
  );
}
