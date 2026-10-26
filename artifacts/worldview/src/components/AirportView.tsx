import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadGoogleTileset, TILESET_NIGHT_SHADER, applyModelVision } from "./CinematicTracker";
import { AirportHud, type AirportCameraPreset, type AircraftInfo, type FeedState } from "./AirportHud";
import { MODEL_GEOMETRY } from "../lib/tracked-entity";
import type { VisionMode } from "../lib/vision-modes";
import type { Airport } from "../lib/airports";
import {
  MODEL_WHEEL_DEPTH,
  PHASE_COLOR,
  contactModelFile,
  contactScale,
  formatAltitude,
  normalizeContact,
  phaseLabel,
  type AirportContact,
  type RawAirportContact,
} from "../lib/airport-traffic";

const RADIUS_NM = 12;
const POLL_MS = 3000;
const STALE_DROP_MS = 60_000;
const STALE_FEED_MS = 20_000;
const SAMPLE_INTERVAL_MS = 1200;
const SAMPLE_BATCH = 40;
/** Surface is sampled at the centre and 4 points this far out; the minimum wins so jet bridges, roofs
 *  and aircraft baked into the photogrammetry don't lift the model off the apron. */
const SAMPLE_SPREAD_M = 22;
const RESAMPLE_MOVE_M = 20;
const M_PER_DEG = 111_320;
const FADE_MS = 600;
const LABEL_FAR_M = 16_000;
const PARKED_LABEL_FAR_M = 1_800;

interface Track {
  contact: AirportContact;
  modelFile: string;
  scale: number;
  model: Cesium.Model | null;
  loading: boolean;
  label: Cesium.Label;
  point: Cesium.PointPrimitive | null;
  fixLat: number;
  fixLon: number;
  fixMs: number;
  disp: { lat: number; lon: number; h: number; heading: number } | null;
  surfaceH: number | null;
  surfaceLat: number;
  surfaceLon: number;
  lastSeenMs: number;
  labelText: string;
}

interface SceneApi {
  update: (contacts: AirportContact[]) => void;
  preset: (p: AirportCameraPreset) => void;
  focus: (hex: string) => void;
  restyle: () => void;
}

interface Props {
  airport: Airport;
  base: string;
  visionMode: VisionMode;
  onExit: () => void;
}

function wrapDeg(d: number): number {
  return ((d % 360) + 540) % 360 - 180;
}

function labelColor(c: AirportContact): Cesium.Color {
  return Cesium.Color.fromCssColorString(c.military ? "#ff7a3d" : c.vehicle ? "#ffd34d" : PHASE_COLOR[c.phase]);
}

function labelText(c: AirportContact): string {
  if (c.vehicle) return `${c.callsign}\nVEHICLE`;
  if (c.phase === "parked") return `${c.callsign}\nPARKED`;
  const speed = c.gsKt === null ? "" : ` · ${Math.round(c.gsKt)} kt`;
  return `${c.callsign}\n${phaseLabel(c)} · ${formatAltitude(c)}${speed}`;
}

export function AirportView({ airport, base, visionMode, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const selectedRef = useRef<string | null>(null);
  const followRef = useRef<string | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const [contacts, setContacts] = useState<AirportContact[]>([]);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [followHex, setFollowHex] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [tilesReady, setTilesReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [info, setInfo] = useState<Record<string, AircraftInfo | "loading">>({});

  selectedRef.current = selectedHex;
  followRef.current = followHex;

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const exit = useCallback(() => {
    setVisible(false);
    setTimeout(() => onExitRef.current(), FADE_MS);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  useEffect(() => {
    apiRef.current?.restyle();
  }, [visionMode, selectedHex]);

  // ---- Live feed: small-radius ADS-B snapshot around the field, every 3 s ----
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      const abortTimer = setTimeout(() => controller?.abort(), 10_000);
      try {
        const url = `${base}/api/proxy/adsb/airport?lat=${airport.lat}&lon=${airport.lon}&radius=${RADIUS_NM}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { ac?: RawAirportContact[]; stale?: boolean; fetchedAt?: number | null };
        if (stopped) return;
        const list = (body.ac ?? [])
          .map((r) => normalizeContact(r, airport.elevFt))
          .filter((c): c is AirportContact => c !== null);
        const fetchedAt = body.fetchedAt ?? Date.now();
        setContacts(list);
        setFeed(body.stale || Date.now() - fetchedAt > STALE_FEED_MS ? "stale" : "live");
        setLastUpdate(fetchedAt);
        apiRef.current?.update(list);
      } catch {
        if (!stopped) setFeed((f) => (f === "connecting" ? "error" : "stale"));
      } finally {
        clearTimeout(abortTimer);
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [airport, base]);

  // ---- Enrichment (route + airframe) for the selected contact ----
  useEffect(() => {
    if (!selectedHex || info[selectedHex]) return;
    const c = contacts.find((x) => x.hex === selectedHex);
    if (!c || c.vehicle) return;
    setInfo((m) => ({ ...m, [selectedHex]: "loading" }));
    const params = new URLSearchParams({ hex: selectedHex });
    if (/^[A-Z0-9]{2,8}$/.test(c.callsign) && c.callsign !== c.registration) params.set("callsign", c.callsign);
    fetch(`${base}/api/proxy/adsb/info?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AircraftInfo | null) => setInfo((m) => ({ ...m, [selectedHex]: data ?? { aircraft: null, route: null } })))
      .catch(() => setInfo((m) => ({ ...m, [selectedHex]: { aircraft: null, route: null } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHex]);

  // ---- Cesium scene ----
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
    });
    const scene = viewer.scene;
    scene.backgroundColor = Cesium.Color.fromCssColorString("#02060c");
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#06121c");
    // Atmosphere + fog wash the frame out white once the globe is hidden under the tiles.
    scene.fog.enabled = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    const ctrl = scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = 25;
    ctrl.maximumZoomDistance = 120_000;

    // Local midday lighting so the photogrammetry reads naturally.
    const noonUtcHour = (((12 - airport.lon / 15) % 24) + 24) % 24;
    const noon = new Date();
    noon.setUTCHours(Math.floor(noonUtcHour), Math.round((noonUtcHour % 1) * 60), 0, 0);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(noon);
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
    const tracks = new Map<string, Track>();
    let tileset: Cesium.Cesium3DTileset | null = null;

    // Field surface height (ellipsoidal). Until the tiles answer, MSL elevation is a close-enough stand-in.
    const field = { h: airport.elevFt * 0.3048, known: false };

    scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 900_000),
    });

    const presetOffset = (p: AirportCameraPreset): Cesium.HeadingPitchRange => {
      switch (p) {
        case "top":
          return new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_TWO + 0.0001, 7000);
        case "spotter":
          return new Cesium.HeadingPitchRange(Cesium.Math.toRadians(35), -0.18, 1600);
        default:
          return new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), -0.6, 5200);
      }
    };
    const flyPreset = (p: AirportCameraPreset, duration = 2) => {
      const c = Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, field.h);
      scene.camera.flyToBoundingSphere(new Cesium.BoundingSphere(c, 400), { offset: presetOffset(p), duration });
    };
    flyPreset("overview", 3.2);

    const applyStyles = () => {
      if (viewer.isDestroyed()) return;
      const mode = visionRef.current;
      const tactical = mode === "tactical";
      if (tileset) tileset.customShader = tactical ? TILESET_NIGHT_SHADER : undefined;
      if (esri) esri.brightness = tactical ? 0.45 : 1;
      for (const t of tracks.values()) {
        if (!t.model) continue;
        applyModelVision(t.model, mode);
        if (selectedRef.current === t.contact.hex) {
          t.model.silhouetteColor = Cesium.Color.fromCssColorString("#00ffff");
          t.model.silhouetteSize = 2.5;
        }
      }
    };

    const excluded = (): object[] => {
      const list: object[] = [labels, points];
      for (const t of tracks.values()) if (t.model) list.push(t.model);
      return list;
    };

    const ring = (lat: number, lon: number, spreadM: number): Cesium.Cartographic[] => {
      const dLat = spreadM / M_PER_DEG;
      const dLon = spreadM / (M_PER_DEG * Math.max(Math.cos(Cesium.Math.toRadians(lat)), 0.01));
      return [
        Cesium.Cartographic.fromDegrees(lon, lat),
        Cesium.Cartographic.fromDegrees(lon + dLon, lat),
        Cesium.Cartographic.fromDegrees(lon - dLon, lat),
        Cesium.Cartographic.fromDegrees(lon, lat + dLat),
        Cesium.Cartographic.fromDegrees(lon, lat - dLat),
      ];
    };

    const minHeight = (cs: Array<Cesium.Cartographic | undefined>): number | null => {
      let best = Infinity;
      for (const c of cs) if (c && Number.isFinite(c.height) && c.height < best) best = c.height;
      return Number.isFinite(best) ? best : null;
    };

    const sampleField = () => {
      if (!tileset) return;
      scene
        .sampleHeightMostDetailed([...ring(airport.lat, airport.lon, 0), ...ring(airport.lat, airport.lon, 180)], excluded())
        .then((cs) => {
          const h = minHeight(cs);
          if (h !== null) {
            field.h = h;
            field.known = true;
          }
        })
        .catch(() => {});
    };

    loadGoogleTileset()
      .then((ts) => {
        if (cancelled || viewer.isDestroyed()) {
          ts.destroy();
          return;
        }
        tileset = scene.primitives.add(ts) as Cesium.Cesium3DTileset;
        // The ellipsoid sits above the tiles wherever the geoid is negative; hide it.
        scene.globe.show = false;
        applyStyles();
        setTilesReady(true);
        sampleField();
      })
      .catch((e) => {
        console.error("Failed to load Google 3D tileset; using satellite imagery only", e);
        setTilesReady(true);
      });

    let samplePending = false;
    let lastSampleMs = 0;
    const sampleSurfaces = () => {
      if (!tileset || samplePending) return;
      const now = performance.now();
      if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
      lastSampleMs = now;
      const batch: Track[] = [];
      for (const t of tracks.values()) {
        const c = t.contact;
        if (!(c.onGround || c.aglM < 400) || !t.disp) continue;
        const moved =
          t.surfaceH === null ||
          Math.hypot(
            (t.disp.lat - t.surfaceLat) * M_PER_DEG,
            (t.disp.lon - t.surfaceLon) * M_PER_DEG * Math.cos(Cesium.Math.toRadians(t.disp.lat)),
          ) > RESAMPLE_MOVE_M;
        if (moved) batch.push(t);
        if (batch.length >= SAMPLE_BATCH) break;
      }
      if (batch.length === 0) return;
      samplePending = true;
      const at = batch.map((t) => ({ lat: t.disp!.lat, lon: t.disp!.lon }));
      const pts = at.flatMap((p) => ring(p.lat, p.lon, SAMPLE_SPREAD_M));
      scene
        .sampleHeightMostDetailed(pts, excluded())
        .then((cs) => {
          batch.forEach((t, i) => {
            let h = minHeight(cs.slice(i * 5, i * 5 + 5));
            if (h === null) return;
            // Implausible jumps away from the field level are holes or structures in the mesh.
            if (field.known && Math.abs(h - field.h) > 40) h = field.h;
            t.surfaceH = h;
            t.surfaceLat = at[i].lat;
            t.surfaceLon = at[i].lon;
          });
        })
        .catch(() => {})
        .finally(() => {
          samplePending = false;
        });
    };

    const loadModel = (t: Track) => {
      if (t.contact.vehicle || t.loading || t.model) return;
      t.loading = true;
      Cesium.Model.fromGltfAsync({
        url: `${base}/${t.modelFile}`,
        id: t.contact.hex,
        scale: t.scale,
        minimumPixelSize: 26,
        maximumScale: 4000,
        shadows: Cesium.ShadowMode.DISABLED,
        show: false,
      })
        .then((mdl) => {
          if (cancelled || viewer.isDestroyed() || tracks.get(t.contact.hex) !== t) {
            mdl.destroy();
            return;
          }
          t.model = scene.primitives.add(mdl) as Cesium.Model;
          applyStyles();
        })
        .catch((e) => console.error("Failed to load aircraft model", e))
        .finally(() => {
          t.loading = false;
        });
    };

    const removeTrack = (t: Track) => {
      if (t.model) scene.primitives.remove(t.model);
      labels.remove(t.label);
      if (t.point) points.remove(t.point);
      tracks.delete(t.contact.hex);
    };

    const createTrack = (c: AirportContact, now: number, fixMs: number): Track => ({
      contact: c,
      modelFile: contactModelFile(c),
      scale: contactScale(c),
      model: null,
      loading: false,
      label: labels.add({
        id: c.hex,
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, field.h),
        text: "",
        font: "600 12px 'Share Tech Mono', 'Courier New', monospace",
        fillColor: labelColor(c),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("rgba(2,4,8,0.72)"),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
        pixelOffset: new Cesium.Cartesian2(0, -34),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, LABEL_FAR_M),
        scaleByDistance: new Cesium.NearFarScalar(800, 1, 12_000, 0.65),
      }),
      point: c.vehicle
        ? points.add({
            id: c.hex,
            pixelSize: 7,
            color: Cesium.Color.fromCssColorString("#ffd34d"),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          })
        : null,
      fixLat: c.lat,
      fixLon: c.lon,
      fixMs,
      disp: null,
      surfaceH: null,
      surfaceLat: c.lat,
      surfaceLon: c.lon,
      lastSeenMs: now,
      labelText: "",
    });

    const update = (list: AirportContact[]) => {
      if (viewer.isDestroyed()) return;
      const now = performance.now();
      for (const c of list) {
        const fixMs = now - Math.min(c.ageSec, 10) * 1000;
        let t = tracks.get(c.hex);
        if (!t) {
          t = createTrack(c, now, fixMs);
          tracks.set(c.hex, t);
        } else if (c.lat !== t.contact.lat || c.lon !== t.contact.lon) {
          t.fixLat = c.lat;
          t.fixLon = c.lon;
          t.fixMs = fixMs;
        }
        t.contact = c;
        t.lastSeenMs = now;
        const text = labelText(c);
        if (text !== t.labelText) {
          t.labelText = text;
          t.label.text = text;
          t.label.fillColor = labelColor(c);
          // Parked aircraft crowd the gates; only label them up close.
          t.label.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(0, c.phase === "parked" || c.vehicle ? PARKED_LABEL_FAR_M : LABEL_FAR_M);
        }
        loadModel(t);
      }
      for (const t of [...tracks.values()]) {
        if (now - t.lastSeenMs > STALE_DROP_MS) removeTrack(t);
      }
    };

    const scratchHpr = new Cesium.HeadingPitchRoll();
    const scratchPos = new Cesium.Cartesian3();
    const scratchDelta = new Cesium.Cartesian3();
    let followPrev: Cesium.Cartesian3 | null = null;
    let followHexPrev: string | null = null;
    let lastFrame = performance.now();

    const onPreRender = () => {
      if (viewer.isDestroyed()) return;
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 0.25);
      lastFrame = now;
      const posAlpha = 1 - Math.exp(-dt / 0.9);
      const hdgAlpha = 1 - Math.exp(-dt / 0.6);
      let followPos: Cesium.Cartesian3 | null = null;

      for (const t of tracks.values()) {
        const c = t.contact;
        // Dead reckoning from the last fix along the reported track.
        const maxExtrapolate = c.onGround ? 8 : 20;
        const elapsed = Math.max(0, Math.min((now - t.fixMs) / 1000, maxExtrapolate));
        const dist = c.phase === "parked" ? 0 : c.speedMs * elapsed;
        const hRad = Cesium.Math.toRadians(c.headingDeg);
        const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(t.fixLat)), 0.01);
        const lat = t.fixLat + (dist * Math.cos(hRad)) / M_PER_DEG;
        const lon = t.fixLon + (dist * Math.sin(hRad)) / (M_PER_DEG * cosLat);

        // Ground snapping: grounded contacts sit on the sampled surface with wheels on the tarmac.
        const ground = t.surfaceH ?? field.h;
        const wheels = (MODEL_WHEEL_DEPTH[t.modelFile] ?? 0.3) * t.scale;
        let h: number;
        if (c.vehicle) h = ground + 1.5;
        else if (c.onGround) h = ground + wheels;
        else h = Math.max(c.altGeomM ?? field.h + c.aglM, ground + wheels);

        const d = t.disp;
        if (!d || Math.abs(lat - d.lat) * M_PER_DEG > 3000) {
          t.disp = { lat, lon, h, heading: c.headingDeg };
        } else {
          d.lat += (lat - d.lat) * posAlpha;
          d.lon += (lon - d.lon) * posAlpha;
          // Settling onto freshly sampled ground is quick; altitude changes in the air are smoothed.
          d.h += (h - d.h) * (c.onGround ? Math.min(1, posAlpha * 2.5) : posAlpha);
          d.heading += wrapDeg(c.headingDeg - d.heading) * hdgAlpha;
        }
        const disp = t.disp!;
        const pos = Cesium.Cartesian3.fromDegrees(disp.lon, disp.lat, disp.h, undefined, scratchPos);
        if (t.model) {
          scratchHpr.heading = Cesium.Math.toRadians(disp.heading + (MODEL_GEOMETRY[t.modelFile]?.headingOffsetDeg ?? 180));
          scratchHpr.pitch = 0;
          scratchHpr.roll = 0;
          t.model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, scratchHpr, undefined, undefined, t.model.modelMatrix);
          t.model.show = true;
        }
        if (t.point) t.point.position = pos;
        t.label.position = pos;
        if (followRef.current === c.hex) followPos = Cesium.Cartesian3.clone(pos);
      }

      // Follow: carry the camera along with the target so orbit/zoom stay under user control.
      const fHex = followRef.current;
      if (fHex && followPos) {
        if (followPrev && followHexPrev === fHex) {
          Cesium.Cartesian3.subtract(followPos, followPrev, scratchDelta);
          Cesium.Cartesian3.add(scene.camera.position, scratchDelta, scene.camera.position);
        }
        followPrev = followPos;
        followHexPrev = fHex;
      } else {
        followPrev = null;
        followHexPrev = null;
      }

      sampleSurfaces();
    };
    scene.preRender.addEventListener(onPreRender);

    const pickHex = (position: Cesium.Cartesian2): string | null => {
      const picked = scene.pick(position) as { id?: unknown } | undefined;
      return typeof picked?.id === "string" && tracks.has(picked.id) ? picked.id : null;
    };
    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
      const hex = pickHex(e.position);
      setSelectedHex(hex);
      if (!hex) setFollowHex(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
      const hex = pickHex(e.position);
      if (!hex) return;
      setSelectedHex(hex);
      apiRef.current?.focus(hex);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    apiRef.current = {
      update,
      preset: (p) => {
        setFollowHex(null);
        flyPreset(p);
      },
      focus: (hex) => {
        const t = tracks.get(hex);
        if (!t?.disp) return;
        setFollowHex(null);
        const p = Cesium.Cartesian3.fromDegrees(t.disp.lon, t.disp.lat, t.disp.h);
        const range = Math.max(160, t.scale * 9);
        scene.camera.flyToBoundingSphere(new Cesium.BoundingSphere(p, 1), {
          offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(t.disp.heading + 150), -0.32, range),
          duration: 1.6,
          complete: () => setFollowHex(hex),
        });
      },
      restyle: applyStyles,
    };

    return () => {
      cancelled = true;
      apiRef.current = null;
      handler.destroy();
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [airport, base]);

  const selected = selectedHex ? contacts.find((c) => c.hex === selectedHex) ?? null : null;

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
      {createPortal(
        <AirportHud
          airport={airport}
          contacts={contacts}
          selected={selected}
          selectedInfo={selectedHex ? info[selectedHex] ?? null : null}
          feed={feed}
          lastUpdate={lastUpdate}
          tilesReady={tilesReady}
          following={!!followHex && followHex === selectedHex}
          visible={visible}
          onSelect={(hex) => {
            setSelectedHex(hex);
            if (hex) apiRef.current?.focus(hex);
            else setFollowHex(null);
          }}
          onToggleFollow={() => setFollowHex((f) => (f ? null : selectedHex))}
          onPreset={(p) => apiRef.current?.preset(p)}
          onExit={exit}
        />,
        document.body,
      )}
    </>
  );
}
