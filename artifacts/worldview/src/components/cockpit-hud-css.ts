/** Scoped styles for CockpitHud (class prefix `wvc-`). Plain CSS so media queries work outside Tailwind. */
export const COCKPIT_CSS = `
.wvc-root{position:fixed;inset:0;z-index:5000;pointer-events:none;font-family:'Share Tech Mono','Courier New',monospace;color:#d6f6ff;letter-spacing:.12em;--wvc-accent:#00e5ff;--wvc-ring:#e8b04a;--wvc-visor:min(88vh,74vw)}
.wvc-root p,.wvc-root h2,.wvc-root dl{margin:0}
.wvc-visor{position:absolute;left:50%;top:50%;width:var(--wvc-visor);height:var(--wvc-visor);transform:translate(-50%,-50%);border-radius:50%;box-shadow:0 0 0 200vmax rgba(1,4,8,.95),inset 0 0 calc(var(--wvc-visor)*.12) rgba(0,0,0,.85)}
.wvc-visor-ring{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(232,176,74,.7)}
.wvc-visor-ring-inner{inset:3%;border:1px dashed rgba(232,176,74,.22)}
.wvc-frame{position:absolute;inset:14px;border:1px solid rgba(0,229,255,.18);border-radius:14px}
.wvc-top{position:absolute;left:32px;right:32px;top:28px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.wvc-top-center{display:flex;gap:6px;align-items:center;margin-top:2px}
.wvc-top-right{text-align:right}
.wvc-kicker{font-size:10px;color:rgba(214,246,255,.7);display:flex;align-items:center;gap:6px}
.wvc-dot{width:6px;height:6px;border-radius:50%;background:var(--wvc-accent);box-shadow:0 0 8px var(--wvc-accent)}
.wvc-root .wvc-callsign{font-size:22px;font-weight:600;color:#fff;letter-spacing:.14em;margin-top:4px}
.wvc-sub{font-size:9px;color:rgba(214,246,255,.55);letter-spacing:.16em}
.wvc-clock{font-size:13px;color:#fff}
.wvc-chip{font-size:9px;padding:3px 7px;border:1px solid rgba(0,229,255,.25);background:rgba(2,10,16,.7);color:rgba(214,246,255,.7)}
.wvc-chip-active{border-color:var(--wvc-ring);color:var(--wvc-ring)}
.wvc-tape-wrap{position:absolute;left:50%;top:calc(50% - var(--wvc-visor)/2 + 28px);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:4px}
.wvc-tape{position:relative;width:420px;max-width:60vw;height:26px;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent);mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent)}
.wvc-tape-tick{position:absolute;left:50%;top:0;display:flex;flex-direction:column;align-items:center;width:0}
.wvc-tape-line{display:block;width:1px;height:6px;background:rgba(214,246,255,.6)}
.wvc-tape-line-major{height:10px;background:#fff}
.wvc-tape-label{font-size:9px;margin-top:2px;color:#fff}
.wvc-tape-caret{position:absolute;left:50%;bottom:0;width:0;height:0;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:6px solid var(--wvc-ring)}
.wvc-tape-readout{font-size:12px;color:var(--wvc-ring);padding:1px 8px;border:1px solid rgba(232,176,74,.6);background:rgba(2,10,16,.6)}
.wvc-ladder{position:absolute;left:50%;top:50%;width:0;height:0}
.wvc-rung{position:absolute;left:-110px;width:220px;height:0;border-top:1px solid rgba(214,246,255,.55);display:flex;justify-content:space-between}
.wvc-rung-neg{border-top-style:dashed}
.wvc-rung-horizon{left:-200px;width:400px;border-top:1px solid rgba(232,176,74,.85)}
.wvc-rung-label{font-size:9px;color:rgba(214,246,255,.7);transform:translateY(-50%)}
.wvc-rung-label-l{margin-left:-22px}
.wvc-rung-label-r{margin-right:-22px}
.wvc-reticle{position:absolute;left:50%;top:50%;width:120px;height:60px;transform:translate(-50%,-50%);color:#7dfcff;filter:drop-shadow(0 0 3px rgba(0,229,255,.7))}
.wvc-panel{position:absolute;width:230px;padding:12px 14px;background:rgba(2,10,16,.78);border:1px solid rgba(0,229,255,.22);display:flex;flex-direction:column;gap:6px}
.wvc-panel-left{left:32px;top:132px}
.wvc-panel-right{right:32px;top:132px}
.wvc-panel-title{font-size:9px;color:var(--wvc-accent)}
.wvc-root .wvc-mt{margin-top:10px}
.wvc-row{display:flex;justify-content:space-between;gap:10px;font-size:10px;padding:2px 0;border-bottom:1px solid rgba(0,229,255,.07)}
.wvc-row dt{color:rgba(214,246,255,.55)}
.wvc-row dd{margin:0;color:#fff;text-align:right}
.wvc-row dd.wvc-alert{color:#ff5d5d}
.wvc-contact{font-size:15px;color:#fff}
.wvc-root .wvc-mil{color:#ff9a5c}
.wvc-note{font-size:9px;color:rgba(214,246,255,.6);line-height:1.5;letter-spacing:.1em}
.wvc-cohort{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.wvc-cohort>div,.wvc-route>div{display:flex;flex-direction:column;gap:2px}
.wvc-big{font-size:18px;color:#fff}
.wvc-route{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wvc-route-arrow{color:var(--wvc-ring);font-size:16px}
.wvc-readouts{position:absolute;left:50%;top:calc(50% + var(--wvc-visor)*.2);transform:translateX(-50%);display:flex;align-items:flex-end;gap:28px}
.wvc-readout{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;background:rgba(2,10,16,.45);border:1px solid rgba(214,246,255,.12)}
.wvc-readout-mid{border-color:rgba(232,176,74,.5)}
.wvc-num{font-size:40px;line-height:1;color:#fff;letter-spacing:.04em;font-variant-numeric:tabular-nums;text-shadow:0 0 12px rgba(0,229,255,.35)}
.wvc-root .wvc-num-sm{font-size:22px;color:var(--wvc-ring)}
.wvc-actions{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);display:flex;gap:10px;pointer-events:auto}
.wvc-btn{font-family:inherit;font-size:10px;letter-spacing:.18em;padding:8px 14px;background:rgba(2,10,16,.85);color:#d6f6ff;border:1px solid rgba(0,229,255,.4);border-radius:999px;cursor:pointer}
.wvc-btn:hover,.wvc-btn:focus-visible{background:rgba(0,229,255,.14);outline:none;border-color:var(--wvc-accent)}
.wvc-btn-exit{border-color:rgba(232,176,74,.7);color:var(--wvc-ring)}
.wvc-help{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);font-size:8px;color:rgba(214,246,255,.45);white-space:nowrap}
@media (max-width:1000px){.wvc-panel,.wvc-top-center{display:none}.wvc-num{font-size:28px}.wvc-readouts{gap:12px}}
@media (max-width:600px){.wvc-help{display:none}.wvc-root .wvc-callsign{font-size:16px}}
`;
