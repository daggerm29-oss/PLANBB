/**
 * Rocket glyph used in the panel, map markers and as the far-distance billboard in the replay.
 * Pointing up; `flame` adds the exhaust plume.
 */
export function rocketSvg(color = "#22d3ee", { flame = true, glow = true, size = 64 } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size * 1.5}" viewBox="0 0 64 96">
  <defs>
    <linearGradient id="b" x1="0" x2="1">
      <stop offset="0" stop-color="#9fb4c4"/><stop offset="0.45" stop-color="#ffffff"/><stop offset="1" stop-color="#7f93a3"/>
    </linearGradient>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.25" stop-color="#ffe28a"/><stop offset="0.6" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ff3d00" stop-opacity="0"/>
    </linearGradient>
    ${glow ? `<filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="bl"/><feMerge><feMergeNode in="bl"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : ""}
  </defs>
  ${flame ? `<path d="M26 70 Q32 98 38 70 Z" fill="url(#f)"/><path d="M29 70 Q32 84 35 70 Z" fill="#fff"/>` : ""}
  <g ${glow ? 'filter="url(#g)"' : ""} stroke="${color}" stroke-width="1.6" stroke-linejoin="round">
    <path d="M32 4 C40 14 42 26 42 36 V66 H22 V36 C22 26 24 14 32 4 Z" fill="url(#b)"/>
    <path d="M22 50 L12 62 V70 L22 66 Z" fill="#0b1622"/>
    <path d="M42 50 L52 62 V70 L42 66 Z" fill="#0b1622"/>
    <path d="M28 66 H36 L37.5 71 H26.5 Z" fill="#26303a"/>
    <path d="M22 30 H42" stroke-width="1.2"/>
    <circle cx="32" cy="24" r="3.4" fill="${color}" stroke="#0b1622" stroke-width="1"/>
  </g>
</svg>`;
}

export const rocketDataUrl = (color?: string, opts?: Parameters<typeof rocketSvg>[1]) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rocketSvg(color, opts))}`;
