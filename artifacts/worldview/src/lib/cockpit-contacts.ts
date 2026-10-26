import * as Cesium from "cesium";
import { deadReckon, distanceM, M_TO_FT, type CockpitContext } from "./cockpit";

const MAX_RANGE_M = 150_000;
const MAX_LABELS = 60;
const CIV = Cesium.Color.fromCssColorString("#bff8ff");
const MIL = Cesium.Color.fromCssColorString("#ff9a5c");
const LABEL_BG = Cesium.Color.fromCssColorString("rgba(2,10,16,0.55)");

interface Slot {
  label: Cesium.Label;
  point: Cesium.PointPrimitive;
}

/**
 * Labelled markers for the live traffic around the ownship, drawn in the 3D scene
 * so they sit on the real positions in the cockpit view (like a HUD traffic overlay).
 */
export function createContactLayer(scene: Cesium.Scene) {
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene })) as Cesium.LabelCollection;
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
  const slots = new Map<string, Slot>();
  const scratch = new Cesium.Cartesian3();

  const hideAll = () => {
    slots.forEach((s) => {
      s.label.show = false;
      s.point.show = false;
    });
  };

  return {
    update(ownHex: string, eye: { lat: number; lon: number }, ctx: CockpitContext | null, show: boolean) {
      if (!show || !ctx) {
        hideAll();
        return;
      }
      const age = (Date.now() - ctx.aircraftSampleMs) / 1000;
      const near = ctx.aircraft
        .filter((c) => c.hex !== ownHex)
        .map((c) => {
          const p = deadReckon(c, age);
          return { c, p, d: distanceM(eye.lat, eye.lon, p.lat, p.lon) };
        })
        .filter((x) => x.d <= MAX_RANGE_M)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_LABELS);

      const seen = new Set<string>();
      for (const { c, p, d } of near) {
        seen.add(c.hex);
        let slot = slots.get(c.hex);
        if (!slot) {
          slot = {
            label: labels.add({
              position: Cesium.Cartesian3.ZERO,
              text: "",
              font: "600 12px 'Share Tech Mono', 'Courier New', monospace",
              style: Cesium.LabelStyle.FILL,
              showBackground: true,
              backgroundColor: LABEL_BG,
              backgroundPadding: new Cesium.Cartesian2(5, 3),
              pixelOffset: new Cesium.Cartesian2(10, -10),
              horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }),
            point: points.add({
              position: Cesium.Cartesian3.ZERO,
              pixelSize: 6,
              outlineWidth: 1,
              outlineColor: Cesium.Color.BLACK,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }),
          };
          slots.set(c.hex, slot);
        }
        const pos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, Math.max(c.altM, 20), undefined, scratch);
        const color = c.military ? MIL : CIV;
        const fl = c.altM > 0 ? `FL${String(Math.round((c.altM * M_TO_FT) / 100)).padStart(3, "0")}` : "GND";
        slot.label.position = pos;
        slot.label.text = `${c.callsign || c.hex.toUpperCase()}  ${fl}  ${(d / 1852).toFixed(0)}NM`;
        slot.label.fillColor = color;
        slot.label.show = true;
        slot.point.position = pos;
        slot.point.color = color;
        slot.point.show = true;
      }
      slots.forEach((s, hex) => {
        if (seen.has(hex)) return;
        labels.remove(s.label);
        points.remove(s.point);
        slots.delete(hex);
      });
    },
    destroy() {
      if (!scene.isDestroyed()) {
        scene.primitives.remove(labels);
        scene.primitives.remove(points);
      }
      slots.clear();
    },
  };
}

export type ContactLayer = ReturnType<typeof createContactLayer>;
