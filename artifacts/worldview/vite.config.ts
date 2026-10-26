import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";
import cesium from "vite-plugin-cesium";
import express from "express";
import cors from "cors";
import proxyRouter from "../api-server/src/routes/proxy";
import cctvRouter from "../api-server/src/routes/cctv";
import healthRouter from "../api-server/src/routes/health";
import configRouter from "../api-server/src/routes/config";
import trafficRouter from "../api-server/src/routes/traffic";
import infrastructureRouter from "../api-server/src/routes/infrastructure";
import launchesRouter from "../api-server/src/routes/launches";
import aiRouter from "../api-server/src/routes/ai";
import eventsRouter from "../api-server/src/routes/events";
import signalsRouter from "../api-server/src/routes/signals";

const require = createRequire(import.meta.url);
const cesiumPkgDir = path.dirname(require.resolve("cesium/package.json"));

// The API routes run inside this Vite process, so expose server-only keys from the repo-root
// .env files (e.g. TomTom_API) to them without the VITE_ prefix that would ship them to the client.
for (const [k, v] of Object.entries(loadEnv(process.env.NODE_ENV ?? "development", path.resolve(import.meta.dirname, "../.."), ""))) {
  if (!process.env[k]) process.env[k] = v;
}

const port = Number(process.env.PORT) || 3000;
const basePath = process.env.BASE_PATH || "/";

function apiProxyPlugin(): Plugin {
  const mountApi = (server: any) => {
    const apiApp = express();
    apiApp.use(cors());
    apiApp.use(express.json({ limit: "8mb" }));
    const router = express.Router();
    router.use(aiRouter);
    router.use(healthRouter);
    router.use(configRouter);
    router.use(proxyRouter);
    router.use(cctvRouter);
    router.use(trafficRouter);
    router.use(infrastructureRouter);
    router.use(launchesRouter);
    router.use(eventsRouter);
    router.use(signalsRouter);
    apiApp.use("/api", router);
    server.middlewares.use(apiApp);
  };

  return {
    name: "api-proxy-plugin",
    configureServer(server) {
      mountApi(server);
    },
    configurePreviewServer(server) {
      mountApi(server);
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    cesium({
      cesiumBuildRootPath: path.join(cesiumPkgDir, "Build"),
      cesiumBuildPath: path.join(cesiumPkgDir, "Build/Cesium/"),
    }),
    apiProxyPlugin(),
  ],
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom", "three"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
