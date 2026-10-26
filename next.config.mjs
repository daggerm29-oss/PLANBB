import { spawn } from "node:child_process";
import net from "node:net";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const vitePort = Number(process.env.VITE_PORT || 5173);
const viteOrigin = `http://127.0.0.1:${vitePort}`;

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.end(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// This Next.js layer only proxies to the Vite app. `npm run dev` (scripts/dev.mjs) starts both, but some hosts
// (e.g. the v0 preview) launch `next dev` directly, which would leave every request failing with ECONNREFUSED.
async function ensureVite() {
  if (process.env.WORLDVIEW_VITE_MANAGED) return;
  process.env.WORLDVIEW_VITE_MANAGED = "1";
  if (await portOpen(vitePort)) return;

  let child = null;
  let shuttingDown = false;
  let attempts = 0;

  // The host may launch `next dev` while dependencies are still installing, so Vite can exit
  // immediately ("vite: command not found"). Keep retrying instead of leaving the proxy dead.
  const start = () => {
    attempts += 1;
    child = spawn(
      "npm",
      ["run", "dev", "--workspace=@workspace/worldview", "--", "--port", String(vitePort), "--strictPort"],
      { stdio: "inherit", env: { ...process.env, PORT: String(vitePort), BASE_PATH: "/" } },
    );
    child.once("exit", async () => {
      if (shuttingDown) return;
      if (await portOpen(vitePort)) return;
      if (attempts >= 30) return;
      setTimeout(start, Math.min(2000 * attempts, 10_000));
    });
  };
  start();

  const stop = () => { shuttingDown = true; child?.kill(); };
  process.once("exit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** @type {(phase: string) => Promise<import('next').NextConfig>} */
export default async function config(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER) await ensureVite();
  return {
    experimental: { proxyTimeout: 60_000 },
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "Permissions-Policy", value: "microphone=*, geolocation=*" },
          ],
        },
      ];
    },
    async rewrites() {
      return {
        beforeFiles: [{ source: "/:path*", destination: `${viteOrigin}/:path*` }],
      };
    },
  };
}

