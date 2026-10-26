import { X } from "lucide-react";

const FONT = "'Share Tech Mono','Courier New',monospace";

export interface SignalAlert {
  id: string;
  code: string;
  title: string;
  detail: string;
  color: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface Props {
  alerts: SignalAlert[];
  onDismiss: (id: string) => void;
}

/** Top-center stack of critical alerts (emergency squawks, flagged ATC transmissions). */
export function SignalAlertBanner({ alerts, onDismiss }: Props) {
  if (!alerts.length) return null;
  const shown = alerts.slice(0, 3);
  return (
    <div
      role="region"
      aria-label="Critical alerts"
      aria-live="assertive"
      style={{ position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "flex", flexDirection: "column", gap: 6, width: "min(520px, calc(100vw - 140px))", pointerEvents: "none" }}
    >
      {shown.map((a) => (
        <div
          key={a.id}
          className="sig-alert"
          style={{
            pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
            fontFamily: FONT, color: "#fff", background: "rgba(10,4,6,0.88)", backdropFilter: "blur(8px)",
            border: `1px solid ${a.color}`, boxShadow: `0 0 24px ${a.color}55, inset 0 0 18px ${a.color}22`,
            ["--sig-alert" as string]: a.color,
          }}
        >
          <span style={{ fontSize: 14, letterSpacing: "0.08em", color: "#0a0406", background: a.color, padding: "3px 7px", whiteSpace: "nowrap" }}>{a.code}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, letterSpacing: "0.16em", color: a.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
            <div style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(255,255,255,0.8)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.detail}</div>
          </div>
          {a.onAction && (
            <button
              type="button"
              onClick={() => { a.onAction?.(); onDismiss(a.id); }}
              style={{ fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.18em", padding: "5px 9px", cursor: "pointer", color: "#0a0406", background: a.color, border: "none" }}
            >
              {a.actionLabel ?? "VIEW"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(a.id)}
            style={{ display: "inline-flex", padding: 4, cursor: "pointer", color: "rgba(255,255,255,0.7)", background: "transparent", border: "none" }}
          >
            <X size={14} aria-hidden />
            <span className="sr-only">Dismiss alert</span>
          </button>
        </div>
      ))}
      {alerts.length > shown.length && (
        <div style={{ alignSelf: "center", fontFamily: FONT, fontSize: 9, letterSpacing: "0.2em", color: "rgba(255,255,255,0.6)" }}>+{alerts.length - shown.length} MORE ALERTS</div>
      )}
    </div>
  );
}
