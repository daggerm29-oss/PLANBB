import { Router, type IRouter } from "express";
import healthRouter from "./health";
import proxyRouter from "./proxy";
import cctvRouter from "./cctv";
import configRouter from "./config";
import trafficRouter from "./traffic";
import infrastructureRouter from "./infrastructure";
import launchesRouter from "./launches";
import aiRouter from "./ai";
import eventsRouter from "./events";
import signalsRouter from "./signals";

const router: IRouter = Router();
router.use(aiRouter);
router.use(eventsRouter);
router.use(signalsRouter);
router.use(launchesRouter);

router.use(configRouter);
router.use(healthRouter);
router.use(proxyRouter);
router.use(cctvRouter);
router.use(trafficRouter);
router.use(infrastructureRouter);

export default router;
